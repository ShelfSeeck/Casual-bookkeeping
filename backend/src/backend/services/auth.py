"""AuthService：认证门面（docs/auth-structure.md §2.8 / §2.14）。

组合账户/设备仓库 + 密码/令牌服务 + 防刷，对外暴露 login / refresh / logout
三个受控业务动作。路由层经 deps 注入本门面，不直接触碰仓库与 JWT 细节。
所有失败抛 AuthError（统一错误 schema），由全局异常处理器转成 JSON 响应。
"""

from datetime import datetime, timedelta, timezone
from time import sleep
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
        sleep_factory: Callable[[float], None] = sleep,
    ) -> None:
        self._accounts = accounts
        self._devices = devices
        self._password = password
        self._tokens = tokens
        self._limiter = limiter
        self._now = now_factory
        self._sleep = sleep_factory

    def login(
        self,
        phone: str,
        password: str,
        device_id: str,
        source_ip: str = "unknown",
    ) -> TokenPair:
        """手机号+密码校验 → 防刷 → 自动登记设备 → 签发 access + refresh。

        失败映射：密码错/账户不存在 401（不泄露账户是否存在）、防刷锁定 401、
        账户停用 403（docs §2.14）。
        """
        try:
            phone = normalize_Phone(phone)
            validate_DeviceId(device_id)
        except ValueError:
            raise AuthError(ERROR_INVALID_REQUEST, "手机号或设备标识不合法", 400) from None
        # device_id 由未认证客户端提供，可随意轮换，不能作为硬限流隔离维度。
        # 以直连来源 IP + 目标账户限制该来源，同时不影响其他来源的正确登录。
        source_key = f"source:{source_ip}|account:{phone}"
        account_key = f"account:{phone}"
        if self._limiter.is_locked(source_key):
            raise AuthError(ERROR_LOGIN_BLOCKED, "该来源登录失败次数过多，请稍后再试", 401)

        # 账户维度只做短暂、有上限的指数退避，绝不据此拒绝正确密码，
        # 避免攻击者仅凭手机号把合法用户全局锁死。
        delay = self._limiter.delay_seconds(account_key, base=0.05, maximum=1.0)
        if delay:
            self._sleep(delay)

        account = self._accounts.get_Account(phone)
        if account is None or not self._password.verify(account.password_hash, password):
            self._limiter.record_failure(source_key)
            self._limiter.record_failure(account_key)
            raise AuthError(ERROR_INVALID_CREDENTIALS, "手机号或密码错误", 401)
        if account.status != "active":
            raise AuthError(ERROR_ACCOUNT_DISABLED, "账户已停用，无法登录", 403)
        self._limiter.reset(source_key)
        self._limiter.reset(account_key)
        pair = self._tokens.issue_pair(phone, device_id)
        self._register_device(phone, device_id, pair)
        # 登录成功返回前必须落库：客户端拿到 200 后会立即携带新 access 请求
        # 业务端点（如 /sync/bootstrap）。请求级连接的统一 commit 发生在响应
        # 发送之后（deps.get_Connection 的 yield 退出），若不在此提交，
        # 会形成“设备行尚不可见 → session_revoked”的竞态（见测试缝 6）。
        self._devices.connection.commit()
        return pair

    def refresh(self, refresh_token: str) -> TokenPair:
        """原子轮换 refresh；检测到旧 token 重放时吊销当前令牌族。"""
        try:
            claims = self._tokens.verify(refresh_token, "refresh")
            active = self._devices.get_ActiveSession(claims.phone, claims.device_id)
            current = self._devices.get_Device(claims.phone, claims.device_id)
        except TokenError:
            raise AuthError(ERROR_INVALID_TOKEN, "refresh token 无效或已过期", 401) from None
        except ValueError:
            raise AuthError(ERROR_INVALID_TOKEN, "refresh token 无效", 401) from None
        if not active or current is None:
            raise AuthError(ERROR_SESSION_REVOKED, "会话已失效，请重新登录", 403)

        family_id = claims.refresh_family_id
        incoming_hash = self._tokens.hash_refresh(refresh_token)
        if family_id is None or current.refresh_family_id != family_id:
            # 这是已经被重新登录替换掉的旧族，不得误伤当前新族。
            raise AuthError(ERROR_SESSION_REVOKED, "会话已失效，请重新登录", 403)
        if current.refresh_token_hash != incoming_hash:
            self._revoke_replayed_family(claims.phone, claims.device_id, family_id)

        pair = self._tokens.issue_pair(
            claims.phone, claims.device_id, refresh_family_id=family_id
        )
        refresh_expires_at = (
            self._now() + timedelta(seconds=self._tokens.refresh_ttl)
        ).isoformat()
        rotated = self._devices.rotate_RefreshToken(
            claims.phone,
            claims.device_id,
            expected_token_hash=incoming_hash,
            refresh_token_hash=self._tokens.hash_refresh(pair.refresh_token),
            refresh_family_id=pair.refresh_family_id,
            refresh_jti=pair.refresh_jti,
            refresh_expires_at=refresh_expires_at,
        )
        if not rotated:
            # 并发请求只有一个能完成 compare-and-swap；其余均视为旧 token 重放。
            self._revoke_replayed_family(claims.phone, claims.device_id, family_id)
        self._devices.connection.commit()
        return pair

    def logout(self, refresh_token: str) -> None:
        """登出：吊销当前 (账户, 设备) 会话。cookie 已失效时幂等，不报错。"""
        try:
            claims = self._tokens.verify(refresh_token, "refresh")
        except TokenError:
            return
        if claims.refresh_family_id is not None:
            self._devices.revoke_RefreshFamily(
                claims.phone, claims.device_id, claims.refresh_family_id
            )

    def _register_device(
        self, phone: str, device_id: str, pair: TokenPair
    ) -> None:
        # 登录创建新 token 族；同设备重新登录会替换并失效旧族。
        refresh_expires_at = (
            self._now() + timedelta(seconds=self._tokens.refresh_ttl)
        ).isoformat()
        self._devices.upsert_Device(
            phone,
            device_id,
            refresh_expires_at,
            refresh_token_hash=self._tokens.hash_refresh(pair.refresh_token),
            refresh_family_id=pair.refresh_family_id,
            refresh_jti=pair.refresh_jti,
        )

    def _revoke_replayed_family(
        self, phone: str, device_id: str, family_id: str
    ) -> None:
        self._devices.revoke_RefreshFamily(phone, device_id, family_id)
        # AuthError 会触发请求事务 rollback，因此重放吊销必须先显式持久化。
        self._devices.connection.commit()
        raise AuthError(
            ERROR_SESSION_REVOKED,
            "检测到 refresh token 重放，会话已撤销，请重新登录",
            403,
        )
