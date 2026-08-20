"""ServiceCategoriesRepository：service_categories 表的受控读写接口。

本表校验：subcategories_json 必须可解析为数组，且每个小类都是
{name, default_unit, is_active} 的合法对象（name/default_unit 非空字符串、
is_active 为 bool）；小类 name 同数组内不重复；category_name 同账户内不重复
（UNIQUE(account_phone, category_name) 兜底，捕获 sqlite IntegrityError 转 rejected）。

查询（docs/spec/agent-tools.md §6）：list_Categories 默认只返回启用大类。
"""

import json
import sqlite3
from typing import Any

from backend.repositories.business_base import ApplyResult, BusinessRepository


class ServiceCategoriesRepository(BusinessRepository):
    table = "service_categories"
    soft_delete_column = "is_active"
    has_soft_delete = False  # 停用用 is_active=0 表达，不做软删时间戳

    def _validate_fields(self, fields):
        if "sort_order" in fields and (
            not isinstance(fields["sort_order"], int) or fields["sort_order"] < 0
        ):
            return "invalid_request"
        if "subcategories_json" in fields:
            try:
                parsed = json.loads(fields["subcategories_json"])
            except (ValueError, TypeError):
                return "invalid_subcategories"
            if not isinstance(parsed, list):
                return "invalid_subcategories"
            names = []
            for item in parsed:
                if (
                    not isinstance(item, dict)
                    or not isinstance(item.get("name"), str)
                    or not item["name"].strip()
                    or not isinstance(item.get("default_unit"), str)
                    or not item["default_unit"].strip()
                    or not isinstance(item.get("is_active"), bool)
                ):
                    return "invalid_subcategories"
                names.append(item["name"])
            if len(names) != len(set(names)):
                return "subcategory_name_duplicate"
        return None

    def _integrity_error_code(self):
        # UNIQUE(account_phone, category_name) 兜底：同账户大类重名
        return "category_name_duplicate"

    def get_ByCategoryName(
        self, account_phone: str, category_name: str
    ) -> dict[str, Any] | None:
        """按大类名称读取配置；供草案预校验使用。"""
        row = self.connection.execute(
            "SELECT * FROM service_categories"
            " WHERE account_phone = ? AND category_name = ?",
            (account_phone, category_name),
        ).fetchone()
        return dict(row) if row is not None else None

    def apply_Write(
        self,
        account_phone: str,
        sync_id: str,
        fields: dict[str, Any],
        base_version: int,
    ) -> ApplyResult:
        """针对服务品类：采用最新覆盖（LWW），弱化版本比对，消除品类冲突与重复创建阻断。"""
        error = self._validate_fields(fields)
        if error is not None:
            return ApplyResult("rejected", error_code=error)

        now = self._now_factory()
        existing_by_sync_id = self.get_BySyncId(account_phone, sync_id)

        # 1. 尝试按 sync_id 匹配
        if existing_by_sync_id is not None:
            set_values: dict[str, Any] = {"updated_at": now}
            for key, value in fields.items():
                if key in self._columns() and key not in ("account_phone", "sync_id", "row_version"):
                    set_values[key] = value
            new_version = existing_by_sync_id["row_version"] + 1
            set_values["row_version"] = new_version
            try:
                self._update(self.table, set_values, "sync_id", sync_id)
            except sqlite3.IntegrityError:
                return ApplyResult("rejected", error_code=self._integrity_error_code())
            return ApplyResult("applied", new_version)

        # 2. sync_id 未匹配，但若 category_name 相同，视为同名覆盖/就地更新，采用已有记录的 sync_id
        cat_name = fields.get("category_name")
        if cat_name:
            existing_by_name = self.get_ByCategoryName(account_phone, cat_name)
            if existing_by_name is not None:
                set_values: dict[str, Any] = {"updated_at": now}
                for key, value in fields.items():
                    if key in self._columns() and key not in ("account_phone", "sync_id", "row_version"):
                        set_values[key] = value
                new_version = existing_by_name["row_version"] + 1
                set_values["row_version"] = new_version
                self._update(self.table, set_values, "sync_id", existing_by_name["sync_id"])
                return ApplyResult("applied", new_version)

        # 3. 都不存在，全新插入
        values: dict[str, Any] = {"account_phone": account_phone, "sync_id": sync_id}
        for key, value in fields.items():
            if key in self._columns() and key not in ("account_phone", "sync_id", "row_version"):
                values[key] = value
        values.setdefault("created_at", now)
        values["updated_at"] = now
        values["row_version"] = 1
        try:
            self._insert(self.table, values)
        except sqlite3.IntegrityError:
            return ApplyResult("rejected", error_code=self._integrity_error_code())
        return ApplyResult("applied", 1)

    def list_Categories(
        self,
        account_phone: str,
        *,
        include_inactive: bool = False,
    ) -> list[dict[str, Any]]:
        """查询服务大类；默认只返回启用（is_active=1）的大类。"""
        conditions = ["account_phone = ?"]
        params: list[Any] = [account_phone]
        if not include_inactive:
            conditions.append("is_active = 1")

        where = " AND ".join(conditions)
        rows = self.connection.execute(
            f"SELECT * FROM {self.table} WHERE {where}"
            " ORDER BY sort_order ASC, category_name ASC",
            params,
        ).fetchall()
        return [dict(row) for row in rows]
