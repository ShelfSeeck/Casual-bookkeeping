"""CustomersRepository：customers 表的受控读写接口（docs/spec/sync-backend.md §4）。

继承 BusinessRepository 的版本比对 / 软删 / row_version 递增逻辑，
只补充本表字段校验（canonical_name 非空）。
"""

from backend.repositories.business_base import BusinessRepository


class CustomersRepository(BusinessRepository):
    table = "customers"
    soft_delete_column = "archived_at"
    has_soft_delete = True

    def _validate_fields(self, fields):
        if "canonical_name" in fields and not fields["canonical_name"].strip():
            return "invalid_customer_name"
        return None
