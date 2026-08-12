"""CustomerCodeMappingsRepository：customer_code_mappings 表的受控读写接口。

本表校验：valid_to 为空或 >= valid_from（data-model.md §4.4 CHECK）。
"""

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
