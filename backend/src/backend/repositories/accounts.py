"""AccountsRepository：accounts 表的受控读写接口。

每个公开方法是一次具名的业务操作（不做通用 CRUD）。
时间字段统一由仓库生成（ISO 8601 UTC），调用方无需关心。
下一轮认证功能（密码哈希/JWT）会在这个接口之上加门面 AuthService。
"""

from dataclasses import dataclass
from datetime import datetime, timezone

from backend.repositories._base import BaseRepository


@dataclass(frozen=True)
class Account:
    """一行 accounts 记录的返回值类型，字段与表列一一对应。"""

    phone: str
    password_hash: str
    status: str
    created_at: str
    updated_at: str


class AccountsRepository(BaseRepository):
    """`accounts` 表的受控读写接口。"""

    def get_Account(self, phone: str) -> Account | None:
        # 按主键手机号查账户；查不到返回 None（调用方据此判断"账户不存在"）
        row = self.connection.execute(
            "SELECT phone, password_hash, status, created_at, updated_at"
            " FROM accounts WHERE phone = ?",
            (phone,),
        ).fetchone()
        if row is None:
            return None
        return Account(**dict(row))

    def create_Account(self, phone: str, password_hash: str, status: str) -> None:
        # 创建账户：created_at / updated_at 都填当前时间
        now = datetime.now(timezone.utc).isoformat()
        self._insert(
            "accounts",
            {
                "phone": phone,
                "password_hash": password_hash,
                "status": status,
                "created_at": now,
                "updated_at": now,
            },
        )

    def set_AccountStatus(self, phone: str, status: str) -> None:
        # 改账户状态（如停用 disabled），同时刷新 updated_at
        now = datetime.now(timezone.utc).isoformat()
        self._update(
            "accounts",
            {"status": status, "updated_at": now},
            "phone",
            phone,
        )
