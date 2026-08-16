"""OperationsRepository：database_operations + operation_changes 的受控读写接口。

服务端正式操作历史（docs/spec/sync-backend.md §5）：
- insert_Operation：写主表（拿自增 server_seq）+ 写 changes 明细，同一事务。
- get_ByOperationId：幂等查（同 operation_id 是否已处理）。
- list_AfterSeq：Pull 用，server_seq > after 升序分页，一条操作不拆分。
- get_MaxSeq：bootstrap 的 snapshot_seq 来源。
"""

from datetime import datetime, timezone
from typing import Any

from backend.repositories._base import BaseRepository


class OperationsRepository(BaseRepository):
    def __init__(self, connection) -> None:
        super().__init__(connection)
        self._now_factory = lambda: datetime.now(timezone.utc).isoformat()

    def insert_Operation(
        self,
        account_phone: str,
        device_id: str | None,
        operation_id: str,
        request_hash: str,
        actor_type: str,
        operation_type: str,
        source_turn_id: str | None,
        reverts_operation_id: str | None,
        result_json: str,
        changes: list[dict[str, Any]],
    ) -> int:
        """写一条正式操作 + 其全部 changes，同一事务；返回新 server_seq。"""
        now = self._now_factory()
        self._insert(
            "database_operations",
            {
                "operation_id": operation_id,
                "request_hash": request_hash,
                "result_json": result_json,
                "account_phone": account_phone,
                "device_id": device_id,
                "actor_type": actor_type,
                "source_turn_id": source_turn_id,
                "operation_type": operation_type,
                "reverts_operation_id": reverts_operation_id,
                "created_at": now,
            },
        )
        row = self.connection.execute(
            "SELECT server_seq FROM database_operations"
            " WHERE operation_id = ?",
            (operation_id,),
        ).fetchone()
        server_seq = int(row["server_seq"])

        for change in changes:
            self._insert(
                "operation_changes",
                {
                    "operation_id": operation_id,
                    "entity_type": change["entity_type"],
                    "entity_sync_id": change["entity_sync_id"],
                    "change_type": change["change_type"],
                    "before_version": change.get("before_version"),
                    "after_version": change.get("after_version"),
                    "before_json": change.get("before_json"),
                    "after_json": change.get("after_json"),
                    "changed_fields_json": change.get("changed_fields_json"),
                },
            )
        return server_seq

    def get_ByOperationId(self, operation_id: str) -> dict[str, Any] | None:
        """幂等查：该 operation_id 是否已处理过。"""
        row = self.connection.execute(
            "SELECT * FROM database_operations WHERE operation_id = ?",
            (operation_id,),
        ).fetchone()
        if row is None:
            return None
        return dict(row)

    def list_AfterSeq(
        self, account_phone: str, after: int, limit: int
    ) -> tuple[list[dict[str, Any]], bool]:
        """Pull：server_seq > after 且属于当前账户，升序，最多 limit 条。

        一条操作不拆分到两个响应（按 server_seq 取整条操作）。返回 (ops, has_more)。
        ops 每条含 server_seq 与完整主表字段；changes 明细由调用方按需补查。
        """
        rows = self.connection.execute(
            "SELECT * FROM database_operations"
            " WHERE account_phone = ? AND server_seq > ?"
            " ORDER BY server_seq ASC"
            " LIMIT ?",
            (account_phone, after, limit + 1),
        ).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit]
        return [dict(row) for row in rows], has_more

    def get_ChangesByOperationId(self, operation_id: str) -> list[dict[str, Any]]:
        """一条操作的 changes 明细（Pull 响应载荷的 changes 来源）。"""
        rows = self.connection.execute(
            "SELECT * FROM operation_changes WHERE operation_id = ?"
            " ORDER BY change_id ASC",
            (operation_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def find_RevertOfOperation(
        self, account_phone: str, operation_id: str
    ) -> dict[str, Any] | None:
        """查当前账户下是否已有撤回操作指向目标操作（docs/data-model.md §6.5）。

        用于撤回校验：一个操作只能被撤回一次；查到任意行即视为已撤回。
        """
        row = self.connection.execute(
            "SELECT * FROM database_operations"
            " WHERE account_phone = ? AND reverts_operation_id = ?",
            (account_phone, operation_id),
        ).fetchone()
        return dict(row) if row is not None else None

    def get_MaxSeq(self, account_phone: str) -> int:
        """bootstrap 的 snapshot_seq：当前账户最新 server_seq；空库为 0。

        必须按账户过滤：server_seq 是全局自增序号，其他账户的操作会推高全局
        MAX(server_seq)，若直接作为本账户快照锚点，会把前端 appliedServerSeq
        推进到超过本账户实际进度的位置（docs/auth-structure.md §2.10 账户隔离）。
        """
        row = self.connection.execute(
            "SELECT MAX(server_seq) AS m FROM database_operations"
            " WHERE account_phone = ?",
            (account_phone,),
        ).fetchone()
        return int(row["m"] or 0)
