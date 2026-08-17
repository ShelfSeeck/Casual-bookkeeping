"""Agent 业务工具：5 个读工具 + 2 个写草案工具（docs/spec/agent-tools.md §4.2/§4.3）。

- 读工具只调 BusinessQueryService，返回结构化 dict；查不到 → items:[] / 计数字段为 0。
- 写草案工具 requires_approval=True；确认后执行时只回执，永不写库。
  draft 形状与 docs/data-model.md §6.3 一致，不含 operation_id / actor_type / source_turn_id。

Global Constraint 12：所有工具函数首参必须显式标注 RunContext[BusinessToolDeps]，
否则 Pydantic AI 2.27.1 会把 requires_approval 静默降级为直接执行。
"""

from __future__ import annotations

from datetime import date
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_ai import ModelRetry, RunContext

from backend.services.agent import BusinessToolDeps
from backend.services.business_query import DraftValidationError
from backend.tools.registry import register_tool


NonEmptyText = Annotated[str, Field(min_length=1)]
PositiveInt = Annotated[int, Field(strict=True, gt=0)]
NonZeroInt = Annotated[int, Field(strict=True)]
NonNegativeInt = Annotated[int, Field(strict=True, ge=0)]


class _DraftFields(BaseModel):
    """模型可控业务字段基类：封闭 schema，拒绝所有同步/账户/删除元字段。"""

    model_config = ConfigDict(extra="forbid")

    @field_validator("customer_id", check_fields=False)
    @classmethod
    def _validate_customer_id(cls, value: int | None) -> int | None:
        if value == 0:
            raise ValueError("customer_id 不能为 0")
        return value

    @field_validator("work_order_date", check_fields=False)
    @classmethod
    def _validate_work_order_date(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            date.fromisoformat(value)
        except ValueError as exc:
            raise ValueError("work_order_date 必须是 YYYY-MM-DD 的有效日期") from exc
        return value

    @field_validator("service_category", "unit", check_fields=False)
    @classmethod
    def _strip_required_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("字段不能为空")
        return stripped

    @field_validator("service_item", check_fields=False)
    @classmethod
    def _strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("service_item 不能为空字符串")
        return stripped


class CreateWorkOrderDraftFields(_DraftFields):
    work_order_date: str
    customer_id: NonZeroInt
    service_category: NonEmptyText
    service_item: NonEmptyText | None
    quantity: PositiveInt
    unit: NonEmptyText
    unit_price_cents: NonNegativeInt | None = None
    is_completed: Literal[0, 1] | None = None


class UpdateWorkOrderDraftFields(_DraftFields):
    work_order_date: str | None = None
    customer_id: NonZeroInt | None = None
    service_category: NonEmptyText | None = None
    service_item: NonEmptyText | None = None
    quantity: PositiveInt | None = None
    unit: NonEmptyText | None = None
    unit_price_cents: NonNegativeInt | None = None
    is_completed: Literal[0, 1] | None = None

    @model_validator(mode="after")
    def _require_patch_field(self) -> "UpdateWorkOrderDraftFields":
        if not self.model_fields_set:
            raise ValueError("修改草案至少包含一个业务字段")
        return self


class CreateWorkOrderDraftInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fields: CreateWorkOrderDraftFields


class UpdateWorkOrderDraftInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entity_sync_id: NonEmptyText
    base_version: PositiveInt
    fields: UpdateWorkOrderDraftFields


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


async def create_work_order(
    ctx: RunContext[BusinessToolDeps],
    fields: CreateWorkOrderDraftFields,
) -> dict[str, Any]:
    """生成新建工单草案。同步 ID 由前端生成；确认后只回执，不写库。"""
    return {
        "status": "draft_acknowledged",
        "operation_type": "create_work_order",
        "changes": [
            {
                "entity_type": "work_order",
                "base_version": 0,
                "fields": fields.model_dump(exclude_unset=True),
            }
        ],
    }


async def update_work_order(
    ctx: RunContext[BusinessToolDeps],
    entity_sync_id: NonEmptyText,
    base_version: PositiveInt,
    fields: UpdateWorkOrderDraftFields,
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
                "fields": fields.model_dump(exclude_unset=True),
            }
        ],
    }


async def _validate_create_work_order(
    ctx: RunContext[BusinessToolDeps], draft: CreateWorkOrderDraftInput
) -> None:
    if ctx.deps.query is None:
        return
    try:
        ctx.deps.query.prepare_WorkOrderDraft(
            ctx.deps.account_phone, "create_work_order", draft.model_dump()
        )
    except DraftValidationError as exc:
        raise ModelRetry(f"{exc.error_code}: {exc.message}") from exc


async def _validate_update_work_order(
    ctx: RunContext[BusinessToolDeps], draft: UpdateWorkOrderDraftInput
) -> None:
    if ctx.deps.query is None:
        return
    try:
        ctx.deps.query.prepare_WorkOrderDraft(
            ctx.deps.account_phone,
            "update_work_order",
            draft.model_dump(exclude_unset=True),
        )
    except DraftValidationError as exc:
        raise ModelRetry(f"{exc.error_code}: {exc.message}") from exc


async def _create_work_order_tool(
    ctx: RunContext[BusinessToolDeps], draft: CreateWorkOrderDraftInput
) -> dict[str, Any]:
    return await create_work_order(ctx, draft.fields)


async def _update_work_order_tool(
    ctx: RunContext[BusinessToolDeps], draft: UpdateWorkOrderDraftInput
) -> dict[str, Any]:
    return await update_work_order(
        ctx, draft.entity_sync_id, draft.base_version, draft.fields
    )


# Pydantic AI 对单一 BaseModel 参数会展开其字段；用包装输入模型保持 wire schema
# 为 {fields} / {entity_sync_id, base_version, fields}，同时保留公共工具函数的直接调用缝。
_create_work_order_tool.__name__ = "create_work_order"
_update_work_order_tool.__name__ = "update_work_order"
register_tool(
    _create_work_order_tool,
    requires_approval=True,
    args_validator=_validate_create_work_order,
)
register_tool(
    _update_work_order_tool,
    requires_approval=True,
    args_validator=_validate_update_work_order,
)
