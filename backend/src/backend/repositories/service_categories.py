"""ServiceCategoriesRepository：service_categories 表的受控读写接口。

本表校验：subcategories_json 必须可解析为数组，且每个小类都是
{name, default_unit, is_active} 的合法对象（name/default_unit 非空字符串、
is_active 为 bool）；小类 name 同数组内不重复；category_name 同账户内不重复
（UNIQUE(account_phone, category_name) 兜底，捕获 sqlite IntegrityError 转 rejected）。

查询（docs/spec/agent-tools.md §6）：list_Categories 默认只返回启用大类。
"""

import json
from typing import Any

from backend.repositories.business_base import BusinessRepository


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
