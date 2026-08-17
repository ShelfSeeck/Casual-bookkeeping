"""CustomerCodeMappingsRepository：customer_code_mappings 表的受控读写接口。

本表校验：valid_to 为空或 >= valid_from（data-model.md §4.4 CHECK）。

查询（docs/spec/agent-tools.md §6）：list_Mappings 按 customer_code / on_date 过滤。
"""

from typing import Any

from backend.repositories.business_base import BusinessRepository


class CustomerCodeMappingsRepository(BusinessRepository):
    table = "customer_code_mappings"
    soft_delete_column = "valid_to"
    has_soft_delete = False  # 编号映射无软删概念（有效期表达生命周期）

    def _validate_fields(self, fields):
        valid_to = fields.get("valid_to")
        valid_from = fields.get("valid_from")
        if valid_to is not None and valid_from is not None and valid_to < valid_from:
            return "invalid_mapping_period"
        return None

    def list_ActiveByCustomerId(
        self, account_phone: str, customer_id: int, on_date: str
    ) -> list[dict[str, Any]]:
        """按稳定客户身份与业务日期读取有效编号映射。"""
        if not self._is_valid_date(on_date):
            return []
        rows = self.connection.execute(
            "SELECT * FROM customer_code_mappings"
            " WHERE account_phone = ? AND customer_id = ?"
            " AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)"
            " ORDER BY valid_from DESC, mapping_id DESC",
            (account_phone, customer_id, on_date, on_date),
        ).fetchall()
        return [dict(row) for row in rows]

    def list_Mappings(
        self,
        account_phone: str,
        *,
        customer_code: str | None = None,
        on_date: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        """分页查询客户编号映射；on_date 非法时返回空结果而非抛错。"""
        if on_date is not None and not self._is_valid_date(on_date):
            return [], 0

        conditions = ["account_phone = ?"]
        params: list[Any] = [account_phone]
        if customer_code is not None:
            conditions.append("customer_code = ?")
            params.append(customer_code)
        if on_date is not None:
            conditions.append("valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)")
            params.append(on_date)
            params.append(on_date)

        where = " AND ".join(conditions)
        limit = 100 if limit > 100 else max(0, limit)
        offset = max(0, offset)
        total = self.connection.execute(
            f"SELECT COUNT(*) FROM {self.table} WHERE {where}",
            params,
        ).fetchone()[0]
        rows = self.connection.execute(
            f"SELECT * FROM {self.table} WHERE {where}"
            " ORDER BY valid_from ASC, mapping_id ASC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
        return [dict(row) for row in rows], total
