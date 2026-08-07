"""TokenService：JWT 签发与验签（docs/auth-structure.md §2.5）。

双层 token（access 24h / refresh 180 天），claims 均携带 phone + device_id +
token_type + exp。签发/校验分离：验签按 expected_type 区分用途，防止
refresh 被误当 access 使用。时钟可注入（now_factory），便于测试模拟过期。
吊销不依赖本类：验签通过后由 AuthService / 鉴权守卫实时查信任表。
"""

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

import jwt


class TokenError(Exception):
    """token 相关错误的基类。"""


class InvalidTokenError(TokenError):
    """签名伪造 / 格式损坏 / 无法解析。"""


class TokenExpiredError(TokenError):
    """exp 已过期。"""


class TokenTypeError(TokenError):
    """token 有效但 token_type 与期望不符（如 refresh 被当 access 用）。"""


@dataclass(frozen=True)
class TokenClaims:
    """验签成功后解析出的 claims。"""

    phone: str
    device_id: str
    token_type: str


@dataclass(frozen=True)
class TokenPair:
    """一次登录/刷新签发出的 access + refresh。"""

    access_token: str
    refresh_token: str


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class TokenService:
    """JWT 签发/验签门面，secret 与 TTL 可注入。"""

    def __init__(
        self,
        secret: str,
        access_ttl: int,
        refresh_ttl: int,
        now_factory: Callable[[], datetime] = _utc_now,
    ) -> None:
        self._secret = secret
        self._access_ttl = access_ttl
        self.refresh_ttl = refresh_ttl
        self._now = now_factory

    def sign_access(self, phone: str, device_id: str) -> str:
        return self._sign(phone, device_id, "access", self._access_ttl)

    def sign_refresh(self, phone: str, device_id: str) -> str:
        return self._sign(phone, device_id, "refresh", self.refresh_ttl)

    def _sign(self, phone: str, device_id: str, token_type: str, ttl: int) -> str:
        payload = {
            "phone": phone,
            "device_id": device_id,
            "token_type": token_type,
            "exp": self._now().timestamp() + ttl,
        }
        return jwt.encode(payload, self._secret, algorithm="HS256")

    def issue_pair(self, phone: str, device_id: str) -> TokenPair:
        return TokenPair(
            access_token=self.sign_access(phone, device_id),
            refresh_token=self.sign_refresh(phone, device_id),
        )

    def verify(self, token: str, expected_type: str) -> TokenClaims:
        """验签 + 过期判断 + 类型校验；失败抛 TokenError 子类。"""
        # 关闭 pyjwt 内置 exp 校验（它用真实时钟，与注入的 now_factory 冲突），
        # 过期判断改由本类用注入时钟完成，保证测试可模拟过期。
        try:
            payload = jwt.decode(
                token,
                self._secret,
                algorithms=["HS256"],
                options={"verify_exp": False},
            )
        except jwt.InvalidTokenError:
            raise InvalidTokenError() from None
        if self._now().timestamp() >= payload.get("exp", 0):
            raise TokenExpiredError()
        if payload.get("token_type") != expected_type:
            raise TokenTypeError()
        return TokenClaims(
            phone=payload["phone"],
            device_id=payload["device_id"],
            token_type=payload["token_type"],
        )
