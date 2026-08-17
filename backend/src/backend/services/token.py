"""TokenService：JWT 签发、验签与 refresh 轮换标识（docs/auth-structure.md §2.5）。

access token 无服务端状态；refresh token 带随机 jti + 令牌族，服务端只保存当前
refresh 的 SHA-256 哈希。AuthService 用它完成原子轮换与旧 token 重放检测。
"""

from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from typing import Callable
from uuid import uuid4

import jwt


class TokenError(Exception):
    """token 相关错误的基类。"""


class InvalidTokenError(TokenError):
    """签名伪造 / 格式损坏 / 必要 claim 缺失。"""


class TokenExpiredError(TokenError):
    """exp 已过期。"""


class TokenTypeError(TokenError):
    """token 有效但 token_type 与期望不符。"""


@dataclass(frozen=True)
class TokenClaims:
    """验签成功后解析出的 claims。"""

    phone: str
    device_id: str
    token_type: str
    jti: str | None = None
    refresh_family_id: str | None = None


@dataclass(frozen=True)
class TokenPair:
    """一次登录/刷新签发出的 access + refresh 及 refresh 轮换元数据。"""

    access_token: str
    refresh_token: str
    refresh_jti: str
    refresh_family_id: str


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

    def sign_refresh(
        self,
        phone: str,
        device_id: str,
        *,
        jti: str | None = None,
        refresh_family_id: str | None = None,
    ) -> str:
        return self._sign(
            phone,
            device_id,
            "refresh",
            self.refresh_ttl,
            jti=jti or uuid4().hex,
            refresh_family_id=refresh_family_id or uuid4().hex,
        )

    def _sign(
        self,
        phone: str,
        device_id: str,
        token_type: str,
        ttl: int,
        *,
        jti: str | None = None,
        refresh_family_id: str | None = None,
    ) -> str:
        payload = {
            "phone": phone,
            "device_id": device_id,
            "token_type": token_type,
            "exp": self._now().timestamp() + ttl,
        }
        if token_type == "refresh":
            payload["jti"] = jti
            payload["refresh_family_id"] = refresh_family_id
        return jwt.encode(payload, self._secret, algorithm="HS256")

    def issue_pair(
        self,
        phone: str,
        device_id: str,
        *,
        refresh_family_id: str | None = None,
    ) -> TokenPair:
        refresh_jti = uuid4().hex
        family_id = refresh_family_id or uuid4().hex
        refresh_token = self.sign_refresh(
            phone,
            device_id,
            jti=refresh_jti,
            refresh_family_id=family_id,
        )
        return TokenPair(
            access_token=self.sign_access(phone, device_id),
            refresh_token=refresh_token,
            refresh_jti=refresh_jti,
            refresh_family_id=family_id,
        )

    @staticmethod
    def hash_refresh(token: str) -> str:
        """返回可安全落库比对的 refresh token SHA-256 十六进制哈希。"""
        return sha256(token.encode("utf-8")).hexdigest()

    def verify(self, token: str, expected_type: str) -> TokenClaims:
        """验签 + 过期判断 + 类型/必要 claim 校验；失败抛 TokenError。"""
        try:
            payload = jwt.decode(
                token,
                self._secret,
                algorithms=["HS256"],
                options={"verify_exp": False},
            )
            expires_at = float(payload.get("exp", 0))
        except (jwt.InvalidTokenError, TypeError, ValueError):
            raise InvalidTokenError() from None
        if self._now().timestamp() >= expires_at:
            raise TokenExpiredError()
        if payload.get("token_type") != expected_type:
            raise TokenTypeError()
        phone = payload.get("phone")
        device_id = payload.get("device_id")
        if not isinstance(phone, str) or not isinstance(device_id, str):
            raise InvalidTokenError()
        jti = payload.get("jti")
        family_id = payload.get("refresh_family_id")
        if expected_type == "refresh" and (
            not isinstance(jti, str)
            or not jti
            or not isinstance(family_id, str)
            or not family_id
        ):
            raise InvalidTokenError()
        return TokenClaims(
            phone=phone,
            device_id=device_id,
            token_type=payload["token_type"],
            jti=jti,
            refresh_family_id=family_id,
        )
