"""依赖注入组装层：把 Database、连接、Repository、Service 用 FastAPI Depends 串起来。

这是全项目唯一 import FastAPI 的层；仓库层（repositories/）和数据层（data/）保持纯净，
服务层（services/）只依赖仓库与领域服务，便于单元测试和复用。

依赖关系链：
    get_AuthService ──► get_AccountsRepository / get_AccountDevicesRepository
    get_AuthService ──► get_PasswordService / get_TokenService / get_RateLimiter
    get_CurrentAccount ──► get_TokenService / get_AccountDevicesRepository
    端点只声明 get_AuthService 或 get_CurrentAccount 等，细节全部隐藏。
"""

import sqlite3
from collections.abc import Iterator
from dataclasses import dataclass

from fastapi import Depends, Request

from backend.config import Settings
from backend.data.db import Database
from backend.errors import (
    ERROR_INVALID_TOKEN,
    ERROR_SESSION_REVOKED,
    AuthError,
)
from backend.repositories.account_devices import AccountDevicesRepository
from backend.repositories.accounts import AccountsRepository
from backend.services.auth import AuthService
from backend.services.password import PasswordService
from backend.services.rate_limiter import RateLimiter
from backend.services.token import TokenError, TokenService

# 模块级惰性单例：Database 无状态（只含路径+连接工厂），进程内共享一个即可。
# 首次 get_Database() 才读 config.toml 并创建，避免每个请求重复解析配置
# （参照 Learnova 的 db_dep.py 单例模式，但改为惰性，测试不依赖 config.toml 存在）。
_database: Database | None = None

# 白名单制（docs §2.10）：默认所有端点要求有效 access token，仅这三个端点放行。
AUTH_WHITELIST = {
    ("POST", "/auth/login"),
    ("POST", "/auth/refresh"),
    ("POST", "/auth/logout"),
}


@dataclass(frozen=True)
class CurrentAccount:
    """鉴权依赖注入的账户身份。下游模块只见 account_phone（docs §7 术语统一）。"""

    account_phone: str
    device_id: str


@dataclass(frozen=True)
class RefreshCookieConfig:
    """refresh cookie 参数（名称与 Secure 开关），供路由设置/删除 cookie。"""

    name: str
    secure: bool


def get_Database() -> Database:
    """惰性单例：Database 无状态（只含路径+连接工厂），进程内共享一个。"""
    global _database
    if _database is None:
        settings = Settings()
        _database = Database(settings.database_path)
    return _database


def get_Connection(
    database: Database = Depends(get_Database),
) -> Iterator[sqlite3.Connection]:
    """每请求一个连接，统一管理事务边界：
    正常结束自动 commit；抛异常自动 rollback；无论怎样最后关闭。
    连接永不跨请求共享（与 Learnova 的 db_cursor() 语义一致）。
    """
    connection = database.connect()
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def get_AccountsRepository(
    connection: sqlite3.Connection = Depends(get_Connection),
) -> AccountsRepository:
    # 端点声明依赖后直接拿到仓库对象，无需关心连接怎么来怎么走
    return AccountsRepository(connection)


def get_AccountDevicesRepository(
    connection: sqlite3.Connection = Depends(get_Connection),
) -> AccountDevicesRepository:
    return AccountDevicesRepository(connection)


def get_PasswordService() -> PasswordService:
    return PasswordService()


def get_TokenService() -> TokenService:
    # 密钥从 Settings 读（config.toml / ACS_JWT_SECRET 环境变量）
    settings = Settings()
    return TokenService(
        secret=settings.jwt_secret,
        access_ttl=settings.access_token_ttl_seconds,
        refresh_ttl=settings.refresh_token_ttl_seconds,
    )


def get_RateLimiter() -> RateLimiter:
    settings = Settings()
    return RateLimiter(settings.max_login_failures, settings.login_lock_seconds)


def get_RefreshCookieConfig() -> RefreshCookieConfig:
    settings = Settings()
    return RefreshCookieConfig(settings.refresh_cookie_name, settings.secure_cookie)


def get_AuthService(
    accounts: AccountsRepository = Depends(get_AccountsRepository),
    devices: AccountDevicesRepository = Depends(get_AccountDevicesRepository),
    password: PasswordService = Depends(get_PasswordService),
    tokens: TokenService = Depends(get_TokenService),
    limiter: RateLimiter = Depends(get_RateLimiter),
) -> AuthService:
    return AuthService(accounts, devices, password, tokens, limiter)


def get_CurrentAccount(
    request: Request,
    tokens: TokenService = Depends(get_TokenService),
    devices: AccountDevicesRepository = Depends(get_AccountDevicesRepository),
) -> CurrentAccount | None:
    """鉴权守卫（docs §2.14 六步校验链）。

    白名单路径直接放行；其余路径必须携带有效 access token，且设备组合与账户
    均 active（一次 JOIN 往返）。401 / 403 语义见 docs §2.14。
    不缓存解码结果，踢出/停用实时生效。
    """
    if (request.method, request.url.path) in AUTH_WHITELIST:
        return None
    header = request.headers.get("Authorization")
    if not header or not header.startswith("Bearer "):
        raise AuthError(ERROR_INVALID_TOKEN, "缺少 access token", 401)
    try:
        claims = tokens.verify(header.removeprefix("Bearer "), "access")
    except TokenError:
        raise AuthError(ERROR_INVALID_TOKEN, "access token 无效或已过期", 401) from None
    try:
        active = devices.get_ActiveSession(claims.phone, claims.device_id)
    except ValueError:
        # 兜底：claim 里的 device_id 格式非法（正常签发不会出现）→ 按无效 token 处理
        raise AuthError(ERROR_INVALID_TOKEN, "access token 无效", 401) from None
    if not active:
        raise AuthError(ERROR_SESSION_REVOKED, "会话已失效，请重新登录", 403)
    return CurrentAccount(account_phone=claims.phone, device_id=claims.device_id)
