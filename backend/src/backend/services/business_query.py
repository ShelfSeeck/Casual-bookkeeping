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
