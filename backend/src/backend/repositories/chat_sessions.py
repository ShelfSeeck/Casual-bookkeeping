"""ChatSessionsRepository：chat_sessions 表的受控读写接口（docs/spec/chat-agent.md §3、§9）。

一行 = 一个 AI 对话会话。时间字段由仓库生成（ISO 8601 UTC），调用方不传。
归属校验（session 是否属于某账户）在 service 层做，本仓库只按主键 / 账户读写。
"""

from datetime import datetime, timezone
from typing import Any

from backend.repositories._base import BaseRepository


class ChatSessionsRepository(BaseRepository):
    def __init__(self, connection) -> None:
        super().__init__(connection)
        self._now_factory = lambda: datetime.now(timezone.utc).isoformat()

    def create_Session(
        self, account_phone: str, session_id: str, title: str
    ) -> dict[str, Any]:
        # 创建会话：created_at / updated_at 都填当前时间；返回完整记录
        now = self._now_factory()
        self._insert(
            "chat_sessions",
            {
                "session_id": session_id,
                "account_phone": account_phone,
                "title": title,
                "created_at": now,
                "updated_at": now,
            },
        )
        return self.get_Session(session_id)

    def get_Session(self, session_id: str) -> dict[str, Any] | None:
        # 按主键 session_id 查；查无返回 None（调用方据此判断"会话不存在"）
        row = self.connection.execute(
            "SELECT * FROM chat_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None:
            return None
        return dict(row)

    def list_Sessions(self, account_phone: str) -> list[dict[str, Any]]:
        # 该账户全部会话，按 updated_at 倒序（最近活动在前，spec §4.2）
        rows = self.connection.execute(
            "SELECT * FROM chat_sessions WHERE account_phone = ?"
            " ORDER BY updated_at DESC",
            (account_phone,),
        ).fetchall()
        return [dict(row) for row in rows]
