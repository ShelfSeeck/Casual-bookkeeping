"""ServiceCategoriesRepository：service_categories 表的受控读写接口。

本表校验：subcategories_json 必须可解析为数组；category_name 同账户内不重复
（UNIQUE(account_phone, category_name) 兜底，捕获 sqlite IntegrityError 转 rejected）。
"""

import json

from backend.repositories.business_base import BusinessRepository


class ServiceCategoriesRepository(BusinessRepository):
    table = "service_categories"
    soft_delete_column = "is_active"
    has_soft_delete = False  # 停用用 is_active=0 表达，不做软删时间戳

    def _validate_fields(self, fields):
        if "subcategories_json" in fields:
            try:
                parsed = json.loads(fields["subcategories_json"])
                if not isinstance(parsed, list):
                    return "invalid_subcategories"
            except ValueError:
                return "invalid_subcategories"
        if "category_name" in fields and not fields["category_name"].strip():
            return "invalid_subcategories"
        return None
