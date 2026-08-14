"""CustomersRepository：customers 表的受控读写接口（docs/spec/sync-backend.md §4）。

继承 BusinessRepository 的版本比对 / 软删 / row_version 递增逻辑，
只补充本表字段校验（canonical_name 非空）。

查询（docs/spec/agent-tools.md §6）：list_Customers 分页查询，默认排除已归档。
"""

from typing import Any

from backend.repositories.business_base import BusinessRepository


class CustomersRepository(BusinessRepository):
    table = "customers"
    soft_delete_column = "archived_at"
    has_soft_delete = True

    def _validate_fields(self, fields):
        if "canonical_name" in fields and not fields["canonical_name"].strip():
            return "invalid_customer_name"
        return None

    def list_Customers(
        self,
        account_phone: str,
        *,
        keyword: str | None = None,
        include_archived: bool = False,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        """分页查询客户，默认排除归档；keyword 模糊匹配 canonical_name。"""
        conditions = ["account_phone = ?"]
        params: list[Any] = [account_phone]
        if not include_archived:
            conditions.append("archived_at IS NULL")
        if keyword:
            conditions.append("canonical_name LIKE ?")
            params.append(f"%{keyword}%")

        where = " AND ".join(conditions)
        limit = 100 if limit > 100 else max(0, limit)
        offset = max(0, offset)
        total = self.connection.execute(
            f"SELECT COUNT(*) FROM {self.table} WHERE {where}",
            params,
        ).fetchone()[0]
        rows = self.connection.execute(
            f"SELECT * FROM {self.table} WHERE {where}"
            " ORDER BY customer_id ASC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
        return [dict(row) for row in rows], total
