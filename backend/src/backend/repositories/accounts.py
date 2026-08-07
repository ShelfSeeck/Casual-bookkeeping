"""AccountsRepository：accounts 表的受控读写接口。

每个公开方法是一次具名的业务操作（不做通用 CRUD）。
时间字段统一由仓库生成（ISO 8601 UTC），调用方无需关心。
下一轮认证功能（密码哈希/JWT）会在这个接口之上加门面 AuthService。
"""

import re
from dataclasses import dataclass
from datetime import datetime, timezone

from backend.repositories._base import BaseRepository

# 中国大陆 11 位手机号：1 开头、第二位 3-9、共 11 位数字（docs/auth-structure.md §2.2）
_MAINLAND_MOBILE = re.compile(r"^1[3-9]\d{9}$")


def normalize_Phone(raw: str) -> str:
    """规范化中国大陆 11 位手机号：去空格、去 +86 前缀；非法则抛 ValueError。

    账户领域的统一规则，入库与查询都先规范化（docs §2.2 / 测试用例 B11），
    供 AccountsRepository 及依赖账户手机号的模块（如设备）共用。
    """
    cleaned = raw.strip().replace(" ", "")
    if cleaned.startswith("+86"):
        cleaned = cleaned[3:]
    if not _MAINLAND_MOBILE.match(cleaned):
        raise ValueError(f"非法手机号: {raw}")
    return cleaned


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
        # 按主键手机号查账户；查不到返回 None（调用方据此判断"账户不存在"）。
        # 入参先规范化（去空格/+86），保证未规范化的登录输入也能命中（docs §2.2 / B11）。
        phone = normalize_Phone(phone)
        row = self.connection.execute(
            "SELECT phone, password_hash, status, created_at, updated_at"
            " FROM accounts WHERE phone = ?",
            (phone,),
        ).fetchone()
        if row is None:
            return None
        return Account(**dict(row))

    def create_Account(self, phone: str, password_hash: str, status: str) -> None:
        # 创建账户：手机号统一规范化后入库；重复手机号拒绝（清晰错误而非裸 sqlite 异常）。
        # created_at / updated_at 都填当前时间。
        phone = normalize_Phone(phone)
        if self.get_Account(phone) is not None:
            raise ValueError(f"账户已存在: {phone}")
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
        # 改账户状态（如停用 disabled），同时刷新 updated_at；入参同样规范化
        phone = normalize_Phone(phone)
        now = datetime.now(timezone.utc).isoformat()
        self._update(
            "accounts",
            {"status": status, "updated_at": now},
            "phone",
            phone,
        )
