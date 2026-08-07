"""缝 7 公共 fixture：可控时钟 + 覆盖依赖的 TestClient + 受保护测试端点。

认证接口测试在共享 app 上跑，通过 dependency_overrides 把 DB / TokenService /
RateLimiter / AuthService 换成测试实例（注入同一时钟），业务逻辑由真实实现执行。
覆盖前需先建账户（seed_account），token/cookie 全部由真实端点产生。
"""

from datetime import datetime, timezone

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient

from backend.data.db import Database
from backend.data.schema import apply_schema
from backend.deps import (
    CurrentAccount,
    RefreshCookieConfig,
    get_AccountDevicesRepository,
    get_AccountsRepository,
    get_AuthService,
    get_CurrentAccount,
    get_Database,
    get_RateLimiter,
    get_RefreshCookieConfig,
    get_TokenService,
)
from backend.main import app
from backend.repositories.account_devices import AccountDevicesRepository
from backend.repositories.accounts import AccountsRepository
from backend.services.auth import AuthService
from backend.services.password import PasswordService
from backend.services.rate_limiter import RateLimiter
from backend.services.token import TokenService

ACCESS_TTL = 24 * 3600
REFRESH_TTL = 180 * 24 * 3600
SECRET = "test-secret-0123456789abcdef0123456789abcdef"
PASSWORD = "secret-password"

# 文档 §3.4 防刷参数（5 次 / 15 分钟）
MAX_FAILURES = 5
LOCK_SECONDS = 900


class Clock:
    """可控时钟：__call__ 返回 UTC 时间，测试手动拨表模拟过期/锁定到期。"""

    def __init__(self, start_ts: float = 1_800_000_000) -> None:
        self.ts = start_ts

    def __call__(self) -> datetime:
        return datetime.fromtimestamp(self.ts, tz=timezone.utc)


# 受保护测试端点：验证全局守卫与身份注入（业务端点将同样用 get_CurrentAccount 取身份）
@app.get("/protected/ping")
def _protected_ping(
    current: CurrentAccount = Depends(get_CurrentAccount),
) -> dict:
    return {"account_phone": current.account_phone, "device_id": current.device_id}


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def test_database(tmp_path):
    db = Database(str(tmp_path / "test.db"))
    apply_schema(db)
    return db


@pytest.fixture
def client(test_database, clock):
    tokens = TokenService(SECRET, ACCESS_TTL, REFRESH_TTL, now_factory=clock)
    limiter = RateLimiter(MAX_FAILURES, LOCK_SECONDS, now_factory=clock)

    def _override_database():
        return test_database

    def _override_tokens():
        return tokens

    def _override_limiter():
        return limiter

    def _override_cookie():
        return RefreshCookieConfig(name="refresh_token", secure=False, max_age=REFRESH_TTL)

    def _override_auth(
        accounts: AccountsRepository = Depends(get_AccountsRepository),
        devices: AccountDevicesRepository = Depends(get_AccountDevicesRepository),
    ):
        return AuthService(
            accounts, devices, PasswordService(), tokens, limiter, now_factory=clock
        )

    app.dependency_overrides[get_Database] = _override_database
    app.dependency_overrides[get_TokenService] = _override_tokens
    app.dependency_overrides[get_RateLimiter] = _override_limiter
    app.dependency_overrides[get_RefreshCookieConfig] = _override_cookie
    app.dependency_overrides[get_AuthService] = _override_auth

    yield TestClient(app)

    app.dependency_overrides.clear()


@pytest.fixture
def seed_account(test_database):
    def _seed(phone: str = "13800000000", password: str = PASSWORD,
              status: str = "active") -> None:
        conn = test_database.connect()
        try:
            AccountsRepository(conn).create_Account(
                phone, PasswordService().hash(password), status
            )
            conn.commit()
        finally:
            conn.close()

    return _seed


def refresh_cookie(client: TestClient) -> str:
    """从客户端 cookie jar 里取 refresh token（HttpOnly，响应体里拿不到）。"""
    return client.cookies["refresh_token"]
