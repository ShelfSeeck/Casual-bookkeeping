"""AccountDevicesRepository：account_devices 会话信任与 refresh 轮换状态。"""

import re
from dataclasses import dataclass
from datetime import datetime, timezone

from backend.repositories._base import BaseRepository
from backend.repositories.accounts import AccountsRepository, normalize_Phone

_DEVICE_ID = re.compile(r"^dev-[0-9a-f]{12}$")


def validate_DeviceId(device_id: str) -> str:
    """校验 device_id 符合 ``dev-`` + 12 位十六进制。"""
    if not _DEVICE_ID.match(device_id):
        raise ValueError(f"非法 device_id: {device_id}")
    return device_id


def _validate_refresh_state(
    token_hash: str | None,
    family_id: str | None,
    jti: str | None,
) -> None:
    values = (token_hash, family_id, jti)
    if any(value is not None for value in values) and not all(
        isinstance(value, str) and value for value in values
    ):
        raise ValueError("refresh 轮换状态必须同时提供")


def _validate_expires_at(value: str) -> None:
    try:
        datetime.fromisoformat(value)
    except ValueError:
        raise ValueError(f"非法过期时间: {value}") from None


@dataclass(frozen=True)
class AccountDevice:
    """一行 account_devices 记录。仅保存当前 refresh 哈希，不保存 token 明文。"""

    account_phone: str
    device_id: str
    status: str
    refresh_expires_at: str
    refresh_token_hash: str | None
    refresh_family_id: str | None
    refresh_jti: str | None
    created_at: str
    last_active_at: str


class AccountDevicesRepository(BaseRepository):
    """`account_devices` 表的受控读写接口。"""

    _SELECT = (
        "account_phone, device_id, status, refresh_expires_at,"
        " refresh_token_hash, refresh_family_id, refresh_jti,"
        " created_at, last_active_at"
    )

    def list_Devices(self, account_phone: str) -> list[AccountDevice]:
        account_phone = normalize_Phone(account_phone)
        rows = self.connection.execute(
            f"SELECT {self._SELECT} FROM account_devices"
            " WHERE account_phone = ? ORDER BY created_at",
            (account_phone,),
        ).fetchall()
        return [AccountDevice(**dict(row)) for row in rows]

    def get_Device(
        self, account_phone: str, device_id: str
    ) -> AccountDevice | None:
        account_phone = normalize_Phone(account_phone)
        validate_DeviceId(device_id)
        row = self.connection.execute(
            f"SELECT {self._SELECT} FROM account_devices"
            " WHERE account_phone = ? AND device_id = ?",
            (account_phone, device_id),
        ).fetchone()
        return AccountDevice(**dict(row)) if row else None

    def upsert_Device(
        self,
        account_phone: str,
        device_id: str,
        refresh_expires_at: str,
        *,
        refresh_token_hash: str | None = None,
        refresh_family_id: str | None = None,
        refresh_jti: str | None = None,
    ) -> None:
        """首次/重新登录登记设备，并用新 token 族替换旧族。"""
        account_phone = normalize_Phone(account_phone)
        validate_DeviceId(device_id)
        _validate_expires_at(refresh_expires_at)
        _validate_refresh_state(refresh_token_hash, refresh_family_id, refresh_jti)
        if AccountsRepository(self.connection).get_Account(account_phone) is None:
            raise ValueError(f"账户不存在: {account_phone}")
        now = datetime.now(timezone.utc).isoformat()
        self.connection.execute(
            "INSERT INTO account_devices"
            " (account_phone, device_id, status, refresh_expires_at,"
            " refresh_token_hash, refresh_family_id, refresh_jti, created_at,"
            " last_active_at) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT (account_phone, device_id) DO UPDATE SET"
            " status = 'active',"
            " refresh_expires_at = excluded.refresh_expires_at,"
            " refresh_token_hash = excluded.refresh_token_hash,"
            " refresh_family_id = excluded.refresh_family_id,"
            " refresh_jti = excluded.refresh_jti,"
            " last_active_at = excluded.last_active_at",
            (
                account_phone,
                device_id,
                refresh_expires_at,
                refresh_token_hash,
                refresh_family_id,
                refresh_jti,
                now,
                now,
            ),
        )

    def rotate_RefreshToken(
        self,
        account_phone: str,
        device_id: str,
        *,
        expected_token_hash: str,
        refresh_token_hash: str,
        refresh_family_id: str,
        refresh_jti: str,
        refresh_expires_at: str,
    ) -> bool:
        """仅当当前族/哈希仍匹配时原子替换 refresh；并发或重放返回 False。"""
        account_phone = normalize_Phone(account_phone)
        validate_DeviceId(device_id)
        _validate_expires_at(refresh_expires_at)
        _validate_refresh_state(
            refresh_token_hash, refresh_family_id, refresh_jti
        )
        now = datetime.now(timezone.utc).isoformat()
        cursor = self.connection.execute(
            "UPDATE account_devices SET refresh_token_hash = ?, refresh_jti = ?,"
            " refresh_expires_at = ?, last_active_at = ?"
            " WHERE account_phone = ? AND device_id = ? AND status = 'active'"
            " AND refresh_family_id = ? AND refresh_token_hash = ?",
            (
                refresh_token_hash,
                refresh_jti,
                refresh_expires_at,
                now,
                account_phone,
                device_id,
                refresh_family_id,
                expected_token_hash,
            ),
        )
        return cursor.rowcount == 1

    def revoke_RefreshFamily(
        self, account_phone: str, device_id: str, refresh_family_id: str
    ) -> bool:
        """只吊销匹配的 token 族，避免旧登录族误伤后来重新登录的新族。"""
        account_phone = normalize_Phone(account_phone)
        validate_DeviceId(device_id)
        cursor = self.connection.execute(
            "UPDATE account_devices SET status = 'revoked',"
            " refresh_token_hash = NULL, refresh_jti = NULL"
            " WHERE account_phone = ? AND device_id = ?"
            " AND refresh_family_id = ? AND status = 'active'",
            (account_phone, device_id, refresh_family_id),
        )
        return cursor.rowcount == 1

    def revoke_Device(self, account_phone: str, device_id: str) -> None:
        account_phone = normalize_Phone(account_phone)
        validate_DeviceId(device_id)
        self.connection.execute(
            "UPDATE account_devices SET status = 'revoked',"
            " refresh_token_hash = NULL, refresh_jti = NULL"
            " WHERE account_phone = ? AND device_id = ?",
            (account_phone, device_id),
        )

    def revoke_AllDevices(self, account_phone: str) -> None:
        account_phone = normalize_Phone(account_phone)
        self.connection.execute(
            "UPDATE account_devices SET status = 'revoked',"
            " refresh_token_hash = NULL, refresh_jti = NULL"
            " WHERE account_phone = ?",
            (account_phone,),
        )

    def get_ActiveSession(self, account_phone: str, device_id: str) -> bool:
        account_phone = normalize_Phone(account_phone)
        validate_DeviceId(device_id)
        row = self.connection.execute(
            "SELECT 1 FROM account_devices d"
            " JOIN accounts a ON a.phone = d.account_phone"
            " WHERE d.account_phone = ? AND d.device_id = ?"
            " AND d.status = 'active' AND a.status = 'active'",
            (account_phone, device_id),
        ).fetchone()
        return row is not None
