"""AccountDevicesRepository：account_devices 表的受控读写接口。

一行 = 一个账户在某台设备上的会话信任状态，组合主键 (account_phone, device_id)。
设备模型：设备 = 一个 PWA 安装实例（device_id 前端生成），首次登录自动登记，
可被踢出（revoke）；token 本身不落库，本表记录"哪个(账户,设备)组合仍然受信任"。
"""

from dataclasses import dataclass
from datetime import datetime, timezone

from backend.repositories._base import BaseRepository


@dataclass(frozen=True)
class AccountDevice:
    """一行 account_devices 记录的返回值类型，字段与表列一一对应。"""

    account_phone: str
    device_id: str
    status: str
    refresh_expires_at: str
    created_at: str
    last_active_at: str


class AccountDevicesRepository(BaseRepository):
    """`account_devices` 表的受控读写接口。"""

    def list_Devices(self, account_phone: str) -> list[AccountDevice]:
        # 列出某账户登记过的全部设备，按首次登记时间排序
        rows = self.connection.execute(
            "SELECT account_phone, device_id, status, refresh_expires_at,"
            " created_at, last_active_at"
            " FROM account_devices WHERE account_phone = ?"
            " ORDER BY created_at",
            (account_phone,),
        ).fetchall()
        return [AccountDevice(**dict(row)) for row in rows]

    def upsert_Device(
        self,
        account_phone: str,
        device_id: str,
        refresh_expires_at: str,
    ) -> None:
        # 登记/续期设备会话：不存在则插入（首次登录），已存在则更新（刷新续期），
        # 不会产生重复行。
        # ON CONFLICT 冲突更新：status 重置为 active（重新登录恢复信任）、
        # 刷新 refresh_expires_at 和 last_active_at；created_at 保留首次登记时间。
        now = datetime.now(timezone.utc).isoformat()
        self.connection.execute(
            "INSERT INTO account_devices"
            " (account_phone, device_id, status, refresh_expires_at, created_at,"
            " last_active_at)"
            " VALUES (?, ?, 'active', ?, ?, ?)"
            " ON CONFLICT (account_phone, device_id) DO UPDATE SET"
            " status = 'active',"
            " refresh_expires_at = excluded.refresh_expires_at,"
            " last_active_at = excluded.last_active_at",
            (account_phone, device_id, refresh_expires_at, now, now),
        )

    def revoke_Device(self, account_phone: str, device_id: str) -> None:
        # 踢出设备：把该行 status 置为 revoked。行保留（吊销语义，可追踪），
        # 不是物理删除；已签发 access token 会在有效期（24h）内自然失效。
        self.connection.execute(
            "UPDATE account_devices SET status = 'revoked'"
            " WHERE account_phone = ? AND device_id = ?",
            (account_phone, device_id),
        )
