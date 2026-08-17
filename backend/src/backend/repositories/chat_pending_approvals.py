"""AI 工具待确认批次的持久化索引。每个账户最多一条未决批次。"""

from datetime import datetime, timezone
from typing import Any

from backend.repositories._base import BaseRepository
from backend.repositories.accounts import normalize_Phone


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _require_text(value: str, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} 不能为空")
    return value


class ChatPendingApprovalsRepository(BaseRepository):
    """`chat_pending_approvals` 的受控读写接口。"""

    def get_ByAccount(self, account_phone: str) -> dict[str, Any] | None:
        account_phone = normalize_Phone(account_phone)
        row = self.connection.execute(
            "SELECT account_phone, approval_request_id, session_id, turn_id,"
            " created_at, updated_at FROM chat_pending_approvals"
            " WHERE account_phone = ?",
            (account_phone,),
        ).fetchone()
        return dict(row) if row else None

    def upsert_Pending(
        self,
        account_phone: str,
        approval_request_id: str,
        session_id: str,
        turn_id: str,
    ) -> None:
        account_phone = normalize_Phone(account_phone)
        approval_request_id = _require_text(approval_request_id, "approval_request_id")
        session_id = _require_text(session_id, "session_id")
        turn_id = _require_text(turn_id, "turn_id")
        now = _now()
        self.connection.execute(
            "INSERT INTO chat_pending_approvals"
            " (account_phone, approval_request_id, session_id, turn_id, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(account_phone) DO UPDATE SET"
            " approval_request_id = excluded.approval_request_id,"
            " session_id = excluded.session_id, turn_id = excluded.turn_id,"
            " updated_at = excluded.updated_at",
            (account_phone, approval_request_id, session_id, turn_id, now, now),
        )

    def delete_ByAccount(self, account_phone: str) -> None:
        account_phone = normalize_Phone(account_phone)
        self.connection.execute(
            "DELETE FROM chat_pending_approvals WHERE account_phone = ?",
            (account_phone,),
        )
