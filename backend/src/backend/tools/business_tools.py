"""Agent 业务工具：5 个读工具 + 2 个写草案工具（docs/spec/agent-tools.md §4.2/§4.3）。

- 读工具只调 BusinessQueryService，返回结构化 dict；查不到 → items:[] / 计数字段为 0。
- 写草案工具 requires_approval=True；确认后执行时只回执，永不写库。
  draft 形状与 docs/data-model.md §6.3 一致，不含 operation_id / actor_type / source_turn_id。

Global Constraint 12：所有工具函数首参必须显式标注 RunContext[BusinessToolDeps]，
否则 Pydantic AI 2.27.1 会把 requires_approval 静默降级为直接执行。
"""

from __future__ import annotations

from typing import Any

from pydantic_ai import RunContext

from backend.services.agent import BusinessToolDeps
from backend.tools.registry import register_tool


@register_tool
async def query_work_orders(
    ctx: RunContext[BusinessToolDeps],
    date_from: str | None = None,
    date_to: str | None = None,
    customer_code: str | None = None,
    customer_name: str | None = None,
    service_category: str | None = None,
    service_item: str | None = None,
    is_completed: int | None = None,
    unpriced_only: bool = False,
    limit: int = 50,
) -> dict[str, Any]:
    """查询工单流水：按业务日期、客户、服务、完成状态等过滤，返回 items 与 total。"""
    query = ctx.deps.query
    if query is None:
        return {"items": [], "total": 0}
    return query.query_WorkOrders(
        ctx.deps.account_phone,
        date_from=date_from,
        date_to=date_to,
        customer_code=customer_code,
        customer_name=customer_name,
        service_category=service_category,
        service_item=service_item,
        is_completed=is_completed,
        unpriced_only=unpriced_only,
        limit=limit,
    )


@register_tool
async def summarize_work_orders(
    ctx: RunContext[BusinessToolDeps],
    date_from: str | None = None,
    date_to: str | None = None,
    customer_code: str | None = None,
    customer_name: str | None = None,
    service_category: str | None = None,
    service_item: str | None = None,
    is_completed: int | None = None,
    unpriced_only: bool = False,
) -> dict[str, Any]:
    """汇总工单：单量、总数量、已定价/未定价笔数与已定价金额（单位为分）。"""
    query = ctx.deps.query
    if query is None:
        return {
            "work_order_count": 0,
            "total_quantity": 0,
            "priced_count": 0,
            "priced_amount_cents": 0,
            "unpriced_count": 0,
        }
    return query.summarize_WorkOrders(
        ctx.deps.account_phone,
        date_from=date_from,
        date_to=date_to,
        customer_code=customer_code,
        customer_name=customer_name,
        service_category=service_category,
        service_item=service_item,
        is_completed=is_completed,
        unpriced_only=unpriced_only,
    )


@register_tool
async def query_customers(
    ctx: RunContext[BusinessToolDeps],
    keyword: str | None = None,
    include_archived: bool = False,
    limit: int = 50,
) -> dict[str, Any]:
    """查询真实客户档案；keyword 模糊匹配名称，默认不含已归档客户。"""
    query = ctx.deps.query
    if query is None:
        return {"items": [], "total": 0}
    return query.query_Customers(
        ctx.deps.account_phone,
        keyword=keyword,
        include_archived=include_archived,
        limit=limit,
    )


@register_tool
async def query_customer_code_mappings(
    ctx: RunContext[BusinessToolDeps],
    customer_code: str | None = None,
    on_date: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    """查询客户编号映射；on_date 按业务日期匹配有效期（YYYY-MM-DD）。"""
    query = ctx.deps.query
    if query is None:
        return {"items": [], "total": 0}
    return query.query_CustomerCodeMappings(
        ctx.deps.account_phone,
        customer_code=customer_code,
        on_date=on_date,
        limit=limit,
    )


@register_tool
async def query_service_categories(
    ctx: RunContext[BusinessToolDeps],
    include_inactive: bool = False,
) -> dict[str, Any]:
    """查询服务大类与小类；默认只返回启用的大类。"""
    query = ctx.deps.query
    if query is None:
        return {"items": []}
    return query.query_ServiceCategories(
        ctx.deps.account_phone,
        include_inactive=include_inactive,
    )


@register_tool(requires_approval=True)
async def create_work_order(
    ctx: RunContext[BusinessToolDeps],
    entity_sync_id: str | None,
    fields: dict,
) -> dict[str, Any]:
    """生成新建工单草案。只回执，不写库；需用户确认后由前端提交。"""
    return {
        "status": "draft_acknowledged",
        "operation_type": "create_work_order",
        "changes": [
            {
                "entity_type": "work_order",
                "entity_sync_id": entity_sync_id,
                "base_version": 0,
                "fields": fields,
            }
        ],
    }


@register_tool(requires_approval=True)
async def update_work_order(
    ctx: RunContext[BusinessToolDeps],
    entity_sync_id: str,
    base_version: int,
    fields: dict,
) -> dict[str, Any]:
    """生成修改工单草案。只回执，不写库；需用户确认后由前端提交。"""
    return {
        "status": "draft_acknowledged",
        "operation_type": "update_work_order",
        "changes": [
            {
                "entity_type": "work_order",
                "entity_sync_id": entity_sync_id,
                "base_version": base_version,
                "fields": fields,
            }
        ],
    }
