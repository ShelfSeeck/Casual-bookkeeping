"""WorkOrdersRepository：work_orders 表的受控读写接口。

本表校验（docs/spec/sync-backend.md §4）：quantity > 0、unit 非空、
unit_price_cents 为 NULL 或 >= 0。跨表规则（大小类匹配、客户存在、映射有效）
由 BusinessCommandService 负责，不在此处。
"""

from backend.repositories.business_base import BusinessRepository


class WorkOrdersRepository(BusinessRepository):
    table = "work_orders"
    soft_delete_column = "deleted_at"
    has_soft_delete = True

    def _validate_fields(self, fields):
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
