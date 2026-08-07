"""AuthService：认证门面（docs/auth-structure.md §2.8 / §2.14）。

组合账户/设备仓库 + 密码/令牌服务 + 防刷，对外暴露 login / refresh / logout
三个受控业务动作。路由层经 deps 注入本门面，不直接触碰仓库与 JWT 细节。
所有失败抛 AuthError（统一错误 schema），由全局异常处理器转成 JSON 响应。
"""

from datetime import datetime, timedelta, timezone
from typing import Callable

from backend.errors import (
    ERROR_ACCOUNT_DISABLED,
    ERROR_INVALID_CREDENTIALS,
    ERROR_INVALID_REQUEST,
    ERROR_INVALID_TOKEN,
    ERROR_LOGIN_BLOCKED,
    ERROR_SESSION_REVOKED,
    AuthError,
)
from backend.repositories.account_devices import (
    AccountDevicesRepository,
    validate_DeviceId,
)
from backend.repositories.accounts import AccountsRepository, normalize_Phone
from backend.services.password import PasswordService
from backend.services.rate_limiter import RateLimiter
from backend.services.token import TokenError, TokenPair, TokenService


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class AuthService:
    """认证业务门面：登录（含防刷）、刷新（滚动续期）、登出。"""

    def __init__(
        self,
        accounts: AccountsRepository,
        devices: AccountDevicesRepository,
        password: PasswordService,
        tokens: TokenService,
        limiter: RateLimiter,
        now_factory: Callable[[], datetime] = _utc_now,
    ) -> None:
        self._accounts = accounts
        self._devices = devices
        self._password = password
        self._tokens = tokens
        self._limiter = limiter
        self._now = now_factory

    def login(self, phone: str, password: str, device_id: str) -> TokenPair:
        """手机号+密码校验 → 防刷 → 自动登记设备 → 签发 access + refresh。

        失败映射：密码错/账户不存在 401（不泄露账户是否存在）、防刷锁定 401、
        账户停用 403（docs §2.14）。
        """
        try:
            phone = normalize_Phone(phone)
            validate_DeviceId(device_id)
        except ValueError:
            raise AuthError(ERROR_INVALID_REQUEST, "手机号或设备标识不合法", 400) from None
        if self._limiter.is_locked(phone):
            raise AuthError(ERROR_LOGIN_BLOCKED, "登录失败次数过多，请稍后再试", 401)
        account = self._accounts.get_Account(phone)
        if account is None or not self._password.verify(account.password_hash, password):
            self._limiter.record_failure(phone)
            raise AuthError(ERROR_INVALID_CREDENTIALS, "手机号或密码错误", 401)
        if account.status != "active":
            raise AuthError(ERROR_ACCOUNT_DISABLED, "账户已停用，无法登录", 403)
        self._limiter.reset(phone)
        self._register_device(phone, device_id)
        return self._tokens.issue_pair(phone, device_id)

    def refresh(self, refresh_token: str) -> TokenPair:
        """验签 refresh → 查信任表确认组合有效 → 滚动续期（新 access + 新 refresh）。"""
        try:
            claims = self._tokens.verify(refresh_token, "refresh")
        except TokenError:
            raise AuthError(ERROR_INVALID_TOKEN, "refresh token 无效或已过期", 401) from None
        try:
            active = self._devices.get_ActiveSession(claims.phone, claims.device_id)
        except ValueError:
            # 兜底：claim 里的 device_id 格式非法（正常签发不会出现）→ 按无效 token 处理
            raise AuthError(ERROR_INVALID_TOKEN, "refresh token 无效", 401) from None
        if not active:
            raise AuthError(ERROR_SESSION_REVOKED, "会话已失效，请重新登录", 403)
        self._register_device(claims.phone, claims.device_id)
        return self._tokens.issue_pair(claims.phone, claims.device_id)

    def logout(self, refresh_token: str) -> None:
        """登出：吊销当前 (账户, 设备) 会话。cookie 已失效时幂等，不报错。"""
        try:
            claims = self._tokens.verify(refresh_token, "refresh")
        except TokenError:
            return
        self._devices.revoke_Device(claims.phone, claims.device_id)

    def _register_device(self, phone: str, device_id: str) -> None:
        # 首次登录自动登记 / 刷新滚动续期：更新 refresh_expires_at（表 + JWT exp 双存）
        refresh_expires_at = (
            self._now() + timedelta(seconds=self._tokens.refresh_ttl)
        ).isoformat()
        self._devices.upsert_Device(phone, device_id, refresh_expires_at)
