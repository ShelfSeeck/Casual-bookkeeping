"""BusinessQueryService：只读查询门面（docs/spec/agent-tools.md §6）。

只做编排与防御：账户过滤、limit 收窄透传、日期字符串透传；SQL 在仓库层。
工具层只依赖本门面，不直接碰仓库；本模块不 import FastAPI，保持服务层纯净。
"""

from __future__ import annotations

import json
from typing import Any

from backend.repositories.customer_code_mappings import (
    CustomerCodeMappingsRepository,
)
from backend.repositories.customers import CustomersRepository
from backend.repositories.service_categories import ServiceCategoriesRepository
from backend.repositories.work_orders import WorkOrdersRepository

class DraftValidationError(ValueError):
    """AI 工单草案预校验失败；error_code 可稳定返回模型与前端。"""

    def __init__(self, error_code: str, message: str) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.message = message


_WORK_ORDER_SNAPSHOT_FIELDS = (
    "sync_id",
    "work_order_date",
    "customer_id",
    "customer_code",
    "customer_name",
    "service_category",
    "service_item",
    "quantity",
    "unit",
    "unit_price_cents",
    "is_completed",
    "row_version",
)


class BusinessQueryService:
    """四张业务表的只读查询门面。"""

    def __init__(
        self,
        work_orders: WorkOrdersRepository,
        customers: CustomersRepository,
        mappings: CustomerCodeMappingsRepository,
        categories: ServiceCategoriesRepository,
    ) -> None:
        self._work_orders = work_orders
        self._customers = customers
        self._mappings = mappings
        self._categories = categories

    def query_WorkOrders(
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
    ) -> dict[str, Any]:
        """查询工单（只读，排除软删）；返回 {items, total}。"""
        rows, total = self._work_orders.query_Orders(
            account_phone,
            date_from=date_from,
            date_to=date_to,
            customer_code=customer_code,
            customer_name=customer_name,
            service_category=service_category,
            service_item=service_item,
            is_completed=is_completed,
            unpriced_only=unpriced_only,
            limit=limit,
            offset=offset,
        )
        items = [
            {field: row[field] for field in _WORK_ORDER_SNAPSHOT_FIELDS}
            for row in rows
        ]
        return {"items": items, "total": total}

    def summarize_WorkOrders(
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
    ) -> dict[str, Any]:
        """汇总工单（只读，排除软删）；金额只算已定价，未定价单独计数。"""
        return self._work_orders.summarize_Orders(
            account_phone,
            date_from=date_from,
            date_to=date_to,
            customer_code=customer_code,
            customer_name=customer_name,
            service_category=service_category,
            service_item=service_item,
            is_completed=is_completed,
            unpriced_only=unpriced_only,
        )

    def query_Customers(
        self,
        account_phone: str,
        *,
        keyword: str | None = None,
        include_archived: bool = False,
        limit: int = 50,
        offset: int = 0,
    ) -> dict[str, Any]:
        """查询客户（只读）；默认排除归档，keyword 模糊匹配 canonical_name。"""
        rows, total = self._customers.list_Customers(
            account_phone,
            keyword=keyword,
            include_archived=include_archived,
            limit=limit,
            offset=offset,
        )
        items = [
            {
                "customer_id": row["customer_id"],
                "sync_id": row["sync_id"],
                "canonical_name": row["canonical_name"],
                "archived_at": row["archived_at"],
            }
            for row in rows
        ]
        return {"items": items, "total": total}

    def query_CustomerCodeMappings(
        self,
        account_phone: str,
        *,
        customer_code: str | None = None,
        on_date: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> dict[str, Any]:
        """查询客户编号映射（只读）；on_date 按有效期间过滤。"""
        rows, total = self._mappings.list_Mappings(
            account_phone,
            customer_code=customer_code,
            on_date=on_date,
            limit=limit,
            offset=offset,
        )
        items = [
            {
                "mapping_id": row["mapping_id"],
                "sync_id": row["sync_id"],
                "customer_id": row["customer_id"],
                "customer_code": row["customer_code"],
                "customer_name": row["customer_name"],
                "valid_from": row["valid_from"],
                "valid_to": row["valid_to"],
            }
            for row in rows
        ]
        return {"items": items, "total": total}

    def query_ServiceCategories(
        self,
        account_phone: str,
        *,
        include_inactive: bool = False,
    ) -> dict[str, Any]:
        """查询服务大类（只读）；subcategories_json 解析为列表。"""
        rows = self._categories.list_Categories(
            account_phone,
            include_inactive=include_inactive,
        )
        items = [
            {
                "sync_id": row["sync_id"],
                "category_name": row["category_name"],
                "subcategories": self._parse_subcategories(row["subcategories_json"]),
                "is_active": row["is_active"],
            }
            for row in rows
        ]
        return {"items": items}

    def prepare_WorkOrderDraft(
        self, account_phone: str, tool_name: str, args: dict[str, Any]
    ) -> dict[str, Any]:
        """统一解析封闭 schema、只读预校验并补齐工单快照字段。"""
        # 正常模型调用和进程重启恢复都必须经过同一组 Pydantic 模型；
        # 局部导入避免 business_tools -> BusinessQueryService 的模块初始化环。
        from pydantic import ValidationError
        from backend.tools.business_tools import (
            CreateWorkOrderDraftInput,
            UpdateWorkOrderDraftInput,
        )

        try:
            if tool_name == "create_work_order":
                args = CreateWorkOrderDraftInput.model_validate(args).model_dump(
                    exclude_unset=True
                )
            elif tool_name == "update_work_order":
                args = UpdateWorkOrderDraftInput.model_validate(args).model_dump(
                    exclude_unset=True
                )
            else:
                raise DraftValidationError("draft_tool_invalid", "不支持的写草案工具")
        except ValidationError as exc:
            raise DraftValidationError(
                "draft_fields_invalid", "草案字段不符合封闭业务模型"
            ) from exc
        if tool_name == "create_work_order":
            fields = dict(args.get("fields") or {})
            mapping = self._resolve_customer_mapping(
                account_phone, fields.get("customer_id"), fields.get("work_order_date")
            )
            self._validate_service_option(
                account_phone, fields.get("service_category"), fields.get("service_item")
            )
            normalized = {
                **fields,
                "customer_code": mapping["customer_code"],
                "customer_name": mapping["customer_name"],
                "is_completed": fields.get("is_completed")
                if fields.get("is_completed") is not None
                else 0,
            }
            return {"fields": normalized}

        if tool_name != "update_work_order":
            raise DraftValidationError("draft_tool_invalid", "不支持的写草案工具")

        sync_id = args.get("entity_sync_id")
        base_version = args.get("base_version")
        existing = self._work_orders.get_BySyncId(account_phone, sync_id)
        if existing is None or existing.get("deleted_at") is not None:
            raise DraftValidationError("entity_not_found", "要修改的工单不存在或已删除")
        if existing["row_version"] != base_version:
            raise DraftValidationError(
                "draft_base_version_conflict", "工单版本已变化，请重新查询后生成草案"
            )

        fields = dict(args.get("fields") or {})
        merged = {**existing, **fields}
        if "customer_id" in fields or "work_order_date" in fields:
            mapping = self._resolve_customer_mapping(
                account_phone, merged.get("customer_id"), merged.get("work_order_date")
            )
            fields["customer_code"] = mapping["customer_code"]
            fields["customer_name"] = mapping["customer_name"]
        if "service_category" in fields or "service_item" in fields:
            self._validate_service_option(
                account_phone, merged.get("service_category"), merged.get("service_item")
            )
        return {
            "entity_sync_id": sync_id,
            "base_version": base_version,
            "fields": fields,
        }

    def _resolve_customer_mapping(
        self, account_phone: str, customer_id: Any, work_order_date: Any
    ) -> dict[str, Any]:
        if not isinstance(customer_id, int) or isinstance(customer_id, bool):
            raise DraftValidationError("customer_not_found", "客户 ID 无效")
        customer = self._customers.get_ByCustomerId(account_phone, customer_id)
        if customer is None or customer.get("archived_at") is not None:
            raise DraftValidationError("customer_not_found", "客户不存在或已归档")
        if not isinstance(work_order_date, str):
            raise DraftValidationError("customer_mapping_invalid", "工单日期无效")
        mappings = self._mappings.list_ActiveByCustomerId(
            account_phone, customer_id, work_order_date
        )
        if not mappings:
            raise DraftValidationError(
                "customer_mapping_invalid", "该客户在工单日期没有有效编号映射"
            )
        if len(mappings) > 1:
            raise DraftValidationError(
                "customer_mapping_ambiguous", "该客户在工单日期存在多个有效编号映射"
            )
        return mappings[0]

    def _validate_service_option(
        self, account_phone: str, category_name: Any, item_name: Any
    ) -> None:
        if not isinstance(category_name, str) or not category_name.strip():
            raise DraftValidationError("service_option_disabled", "服务大类无效")
        category = self._categories.get_ByCategoryName(account_phone, category_name)
        if category is None or category.get("is_active") != 1:
            raise DraftValidationError("service_option_disabled", "服务大类不存在或已停用")
        if item_name is None:
            return
        subcategories = self._parse_subcategories(category.get("subcategories_json"))
        for item in subcategories:
            if item.get("name") == item_name:
                if item.get("is_active") is True:
                    return
                raise DraftValidationError("service_option_disabled", "服务小类已停用")
        raise DraftValidationError("service_item_mismatch", "服务小类不属于所选大类")

    @staticmethod
    def _parse_subcategories(raw: str | None) -> list[dict[str, Any]]:
        """解析小类 JSON；读工具容错：非法 JSON 返回空列表而非抛错。"""
        try:
            parsed = json.loads(raw or "[]")
        except (TypeError, ValueError):
            return []
        if not isinstance(parsed, list):
            return []
        return [item for item in parsed if isinstance(item, dict)]
