"""BusinessRepository：业务仓库共享基类（docs/spec/sync-backend.md §4）。

四张业务表共用同一套"版本比对 + 软删 + row_version 递增"逻辑，
本表字段校验通过子类钩子 `validate_Fields` 注入。

- `apply_Write`：create/update/delete 的统一入口，返回 ApplyResult。
- `get_BySyncId`：按 sync_id 查记录（含 row_version），强制带 account_phone。
- `list_Active`：当前在用（未软删）记录，bootstrap 用。
- 软删字段名由子类声明（work_orders → deleted_at，customers → archived_at 等）。
"""

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from backend.repositories._base import BaseRepository


@dataclass(frozen=True)
class ApplyResult:
    """apply_Write 的结果。

    - status: applied / conflict / rejected / not_found
    - new_row_version: applied 时的新版本；其他状态为 None
    - error_code: rejected 时的具体业务错误码（docs/error-codes.md §4.2）；其他状态为 None
    """

    status: str
    new_row_version: int | None = None
    error_code: str | None = None


class BusinessRepository(BaseRepository):
    # 子类声明
    table: str = ""            # 表名
    soft_delete_column: str = ""  # 软删字段名（deleted_at / archived_at / 无）
    has_soft_delete: bool = True  # 该表是否有软删概念

    def __init__(self, connection: sqlite3.Connection) -> None:
        super().__init__(connection)
        self._now_factory = lambda: datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _is_valid_date(value: str) -> bool:
        """严格校验 YYYY-MM-DD；读查询对非法日期返回空结果而非抛错。"""
        try:
            datetime.strptime(value, "%Y-%m-%d")
        except (TypeError, ValueError):
            return False
        return True

    def get_BySyncId(self, account_phone: str, sync_id: str) -> dict[str, Any] | None:
        """按 sync_id 查一条记录（含 row_version）；强制按账户过滤，查无返回 None。"""
        row = self.connection.execute(
            f"SELECT * FROM {self.table}"
            " WHERE account_phone = ? AND sync_id = ?",
            (account_phone, sync_id),
        ).fetchone()
        if row is None:
            return None
        return dict(row)

    def apply_Write(
        self,
        account_phone: str,
        sync_id: str,
        fields: dict[str, Any],
        base_version: int,
    ) -> ApplyResult:
        """create / update / delete 的统一入口。

        - base_version == 0：create。记录已存在 → conflict；否则插入，row_version=1。
        - base_version > 0：update。记录不存在 → not_found；
          版本不等 → conflict；版本一致 → 更新字段 + row_version 递增。
        - 本表字段校验失败（validate_Fields 抛 ValueError）→ rejected。
        """
        error = self._validate_fields(fields)
        if error is not None:
            return ApplyResult("rejected", error_code=error)

        if base_version == 0:
            existing = self.get_BySyncId(account_phone, sync_id)
            if existing is not None:
                return ApplyResult("conflict")
            now = self._now_factory()
            values: dict[str, Any] = {"account_phone": account_phone, "sync_id": sync_id}
            for key, value in fields.items():
                if key in self._columns():
                    values[key] = value
            values.setdefault("created_at", now)
            values["updated_at"] = now
            values["row_version"] = 1
            try:
                self._insert(self.table, values)
            except sqlite3.IntegrityError:
                # 唯一/CHECK 约束冲突（如 category_name 同账户重名）→ rejected，不裸抛
                return ApplyResult("rejected", error_code=self._integrity_error_code())
            return ApplyResult("applied", 1)

        existing = self.get_BySyncId(account_phone, sync_id)
        if existing is None:
            return ApplyResult("not_found")
        if existing["row_version"] != base_version:
            return ApplyResult("conflict")
        now = self._now_factory()
        set_values: dict[str, Any] = {"updated_at": now}
        for key, value in fields.items():
            if key in self._columns() and key != "account_phone" and key != "sync_id":
                set_values[key] = value
        new_version = existing["row_version"] + 1
        set_values["row_version"] = new_version
        self._update(
            self.table,
            set_values,
            "sync_id",
            sync_id,
        )
        return ApplyResult("applied", new_version)

    def list_Active(self, account_phone: str) -> list[dict[str, Any]]:
        """当前在用记录（未软删），bootstrap 下载用。"""
        if self.has_soft_delete:
            rows = self.connection.execute(
                f"SELECT * FROM {self.table}"
                f" WHERE account_phone = ? AND {self.soft_delete_column} IS NULL"
                " ORDER BY row_version ASC",
                (account_phone,),
            ).fetchall()
        else:
            rows = self.connection.execute(
                f"SELECT * FROM {self.table} WHERE account_phone = ? ORDER BY row_version ASC",
                (account_phone,),
            ).fetchall()
        return [dict(row) for row in rows]

    # ---------- 私有辅助 ----------

    def _columns(self) -> set[str]:
        rows = self.connection.execute(f"PRAGMA table_info({self.table})").fetchall()
        return {row["name"] for row in rows}

    def _validate_fields(self, fields: dict[str, Any]) -> str | None:
        """本表字段校验：子类覆写，返回 error_code 或 None。"""
        return None

    def _integrity_error_code(self) -> str:
        """create 时触发 DB 约束冲突（UNIQUE/CHECK）映射的业务错误码；子类覆写。"""
        return "invalid_request"
