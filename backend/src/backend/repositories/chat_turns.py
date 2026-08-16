"""ChatTurnsRepository：chat_turns 表的受控读写接口（docs/spec/chat-agent.md §3、§9）。

一行 = 一次完整的 Agent 运行（一个回合）。turn_id 同时是幂等 ID：
重试复用同 turn_id，成功后覆盖 messages_json、不保留旧版本（docs/ai-chat-storage.md §4）。
回合按 created_at 升序（同则 turn_id 升序）游标分页，供 GET /chat/sessions/{sid}/turns 用。
"""

from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from backend.repositories._base import BaseRepository


class ChatTurnsRepository(BaseRepository):
    def __init__(self, connection, now_factory: Callable[[], str] | None = None) -> None:
        # now_factory 供测试注入确定时钟；默认真实 UTC 时间（ISO 8601）
        super().__init__(connection)
        self._now_factory = now_factory or (
            lambda: datetime.now(timezone.utc).isoformat()
        )

    def upsert_Turn(
        self, turn_id: str, session_id: str, messages_json: str
    ) -> dict[str, Any]:
        # 幂等 upsert：不存在则插入（created_at == updated_at == 当前时间）；
        # 已存在则覆盖 messages_json + updated_at，created_at 保留。返回完整记录
        now = self._now_factory()
        if self.get_Turn(turn_id) is None:
            self._insert(
                "chat_turns",
                {
                    "turn_id": turn_id,
                    "session_id": session_id,
                    "messages_json": messages_json,
                    "created_at": now,
                    "updated_at": now,
                },
            )
        else:
            self._update(
                "chat_turns",
                {"messages_json": messages_json, "updated_at": now},
                "turn_id",
                turn_id,
            )
        return self.get_Turn(turn_id)

    def get_Turn(self, turn_id: str) -> dict[str, Any] | None:
        # 按主键 turn_id 查；查无返回 None
        row = self.connection.execute(
            "SELECT * FROM chat_turns WHERE turn_id = ?",
            (turn_id,),
        ).fetchone()
        if row is None:
            return None
        return dict(row)

    def list_Turns(
        self, session_id: str, after_turn_id: str | None, limit: int
    ) -> tuple[list[dict[str, Any]], str | None]:
        # 该会话回合按 (created_at, turn_id) 升序返回；after_turn_id 排他游标（不含自身）。
        # 最多 limit 条；还有更多时 next_cursor = 最后一条返回回合的 turn_id，否则 None。
        params: list[Any] = [session_id]
        where = "session_id = ?"
        if after_turn_id is not None:
            ref = self.connection.execute(
                "SELECT created_at, turn_id FROM chat_turns WHERE turn_id = ?",
                (after_turn_id,),
            ).fetchone()
            if ref is not None:
                where += " AND (created_at > ? OR (created_at = ? AND turn_id > ?))"
                params += [ref["created_at"], ref["created_at"], ref["turn_id"]]
        rows = self.connection.execute(
            f"SELECT * FROM chat_turns WHERE {where}"
            " ORDER BY created_at ASC, turn_id ASC LIMIT ?",
            params + [limit + 1],
        ).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit]
        next_cursor = rows[-1]["turn_id"] if has_more else None
        return [dict(row) for row in rows], next_cursor
