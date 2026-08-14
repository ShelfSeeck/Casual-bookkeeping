"""WorkOrdersRepository：work_orders 表的受控读写接口。

本表校验（docs/spec/sync-backend.md §4）：quantity > 0、unit 非空、
unit_price_cents 为 NULL 或 >= 0、service_item 为 NULL 或字符串
（docs/spec/business-p0p1.md §5.1）。跨表规则（大小类匹配、客户存在、映射有效）
由 BusinessCommandService 负责，不在此处。

查询（docs/spec/agent-tools.md §6）：
- query_Orders：分页查询，排除软删，work_order_date DESC, created_at DESC。
- summarize_Orders：同过滤参数的汇总，金额只算已定价。
"""

from typing import Any

from backend.repositories.business_base import BusinessRepository


class WorkOrdersRepository(BusinessRepository):
    table = "work_orders"
    soft_delete_column = "deleted_at"
    has_soft_delete = True

    def _validate_fields(self, fields):
        if "service_item" in fields:
            service_item = fields["service_item"]
            if service_item is not None and not isinstance(service_item, str):
                return "invalid_service_item"
        if "quantity" in fields:
            quantity = fields["quantity"]
            if quantity is None or not isinstance(quantity, int) or quantity <= 0:
                return "invalid_quantity"
        if "unit" in fields:
            unit = fields["unit"]
            if unit is None or not isinstance(unit, str) or not unit.strip():
                return "invalid_unit"
        if "unit_price_cents" in fields:
            price = fields["unit_price_cents"]
            if price is not None and (not isinstance(price, int) or price < 0):
                return "invalid_unit_price"
        return None

    def query_Orders(
        self,
        account_phone: str,
        *,
        date_from: str | None = None,
        date_to: str | None = None,
        customer_code: str | None = None,
        customer_name: str | None = None,
        service_category: str | None = None,
        service_item: str | None = None,
        is_completed: int | None = None,
        unpriced_only: bool = False,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        """分页查询工单（只读，排除软删），返回 (rows, total)。"""
        if date_from is not None and not self._is_valid_date(date_from):
            return [], 0
        if date_to is not None and not self._is_valid_date(date_to):
            return [], 0

        conditions = ["account_phone = ?", "deleted_at IS NULL"]
        params: list[Any] = [account_phone]
        if date_from is not None:
            conditions.append("work_order_date >= ?")
            params.append(date_from)
        if date_to is not None:
            conditions.append("work_order_date <= ?")
            params.append(date_to)
        if customer_code is not None:
            conditions.append("customer_code = ?")
            params.append(customer_code)
        if customer_name is not None:
            conditions.append("customer_name = ?")
            params.append(customer_name)
        if service_category is not None:
            conditions.append("service_category = ?")
            params.append(service_category)
        if service_item is not None:
            conditions.append("service_item = ?")
            params.append(service_item)
        if is_completed is not None:
            conditions.append("is_completed = ?")
            params.append(is_completed)
        if unpriced_only:
            conditions.append("unit_price_cents IS NULL")

        where = " AND ".join(conditions)
        limit = 100 if limit > 100 else max(0, limit)
        offset = max(0, offset)
        total = self.connection.execute(
            f"SELECT COUNT(*) FROM {self.table} WHERE {where}",
            params,
        ).fetchone()[0]
        rows = self.connection.execute(
            f"SELECT * FROM {self.table} WHERE {where}"
            " ORDER BY work_order_date DESC, created_at DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
        return [dict(row) for row in rows], total

    def summarize_Orders(
        self,
        account_phone: str,
        *,
        date_from: str | None = None,
        date_to: str | None = None,
        customer_code: str | None = None,
        customer_name: str | None = None,
        service_category: str | None = None,
        service_item: str | None = None,
        is_completed: int | None = None,
        unpriced_only: bool = False,
    ) -> dict[str, int]:
        """汇总工单（只读，排除软删）；金额只算已定价，未定价单独计数。"""
        zero = {
            "work_order_count": 0,
            "total_quantity": 0,
            "priced_count": 0,
            "priced_amount_cents": 0,
            "unpriced_count": 0,
        }
        if date_from is not None and not self._is_valid_date(date_from):
            return zero
        if date_to is not None and not self._is_valid_date(date_to):
            return zero

        conditions = ["account_phone = ?", "deleted_at IS NULL"]
        params: list[Any] = [account_phone]
        if date_from is not None:
            conditions.append("work_order_date >= ?")
            params.append(date_from)
        if date_to is not None:
            conditions.append("work_order_date <= ?")
            params.append(date_to)
        if customer_code is not None:
            conditions.append("customer_code = ?")
            params.append(customer_code)
        if customer_name is not None:
            conditions.append("customer_name = ?")
            params.append(customer_name)
        if service_category is not None:
            conditions.append("service_category = ?")
            params.append(service_category)
        if service_item is not None:
            conditions.append("service_item = ?")
            params.append(service_item)
        if is_completed is not None:
            conditions.append("is_completed = ?")
            params.append(is_completed)
        if unpriced_only:
            conditions.append("unit_price_cents IS NULL")

        where = " AND ".join(conditions)
        row = self.connection.execute(
            f"SELECT"
            " COUNT(*) AS work_order_count,"
            " COALESCE(SUM(quantity), 0) AS total_quantity,"
            " COALESCE(SUM(CASE WHEN unit_price_cents IS NOT NULL THEN 1 ELSE 0 END), 0)"
            "   AS priced_count,"
            " COALESCE(SUM(CASE WHEN unit_price_cents IS NOT NULL"
            "   THEN quantity * unit_price_cents ELSE 0 END), 0) AS priced_amount_cents,"
            " COALESCE(SUM(CASE WHEN unit_price_cents IS NULL THEN 1 ELSE 0 END), 0)"
            "   AS unpriced_count"
            f" FROM {self.table} WHERE {where}",
            params,
        ).fetchone()
        return {
            "work_order_count": row["work_order_count"],
            "total_quantity": row["total_quantity"],
            "priced_count": row["priced_count"],
            "priced_amount_cents": row["priced_amount_cents"],
            "unpriced_count": row["unpriced_count"],
        }
