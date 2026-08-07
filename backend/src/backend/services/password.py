"""PasswordService：Argon2id 密码哈希与校验（docs/auth-structure.md §2.2）。

accounts 表只存哈希不存明文。argon2.PasswordHasher 默认即 Argon2id。
verify 返回布尔值：密码错误或哈希损坏都返回 False，不抛异常、不泄露细节。
"""

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError


class PasswordService:
    """密码哈希/校验门面，hasher 可注入便于测试与替换。"""

    def __init__(self, hasher: PasswordHasher | None = None) -> None:
        self._hasher = hasher or PasswordHasher()

    def hash(self, password: str) -> str:
        # Argon2id 带随机盐，同一密码两次结果不同
        return self._hasher.hash(password)

    def verify(self, password_hash: str, password: str) -> bool:
        # 密码错（VerificationError）或哈希损坏（InvalidHashError）都按失败处理
        try:
            return self._hasher.verify(password_hash, password)
        except (VerificationError, InvalidHashError):
            return False
