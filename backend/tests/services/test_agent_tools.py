"""缝：Agent 业务工具（docs/spec/agent-tools.md §4、§6、§10 tests/services/test_agent_tools.py）。

被测缝：
- tools/registry.py 扩展：requires_approval 元数据、白名单过滤、查询辅助。
- tools/business_tools.py：5 个读工具 + 2 个写草案工具；工具名/参数名/返回字段
  与 docs/spec/agent-tools.md §4 逐字一致。
- 写草案暂停：requires_approval=True 的工具在 run_stream_events 中暂停，
  run.result.output 为 DeferredToolRequests；approve 续跑后工具才执行。

Global Constraint 12：所有工具函数与测试内 RunContext 均显式标注
`RunContext[BusinessToolDeps]`，否则 Pydantic AI 2.27.1 会静默直接执行写工具。
"""

import json
from typing import Any

import pytest
from pydantic_ai import DeferredToolRequests, RunContext
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.usage import RunUsage

from backend.repositories.customer_code_mappings import (
    CustomerCodeMappingsRepository,
)
from backend.repositories.customers import CustomersRepository
from backend.repositories.service_categories import ServiceCategoriesRepository
from backend.repositories.work_orders import WorkOrdersRepository
from backend.services.agent import BusinessToolDeps, build_Agent
from backend.services.business_query import BusinessQueryService
from backend.services.model_config import ModelConfig
from backend.tools import business_tools
from backend.tools import registry as registry_module
from backend.tools.registry import (
    build_tools,
    get_registered_tool_names,
    is_registered,
    requires_approval_for,
)

READ_TOOL_NAMES = {
    "query_work_orders",
    "summarize_work_orders",
    "query_customers",
    "query_customer_code_mappings",
    "query_service_categories",
}
WRITE_TOOL_NAMES = {"create_work_order", "update_work_order"}
ALL_TOOL_NAMES = READ_TOOL_NAMES | WRITE_TOOL_NAMES


def _make_ctx(account_phone: str, query: BusinessQueryService) -> RunContext[BusinessToolDeps]:
    """构造合成 RunContext（只用于直接调工具函数，不经过 Agent run）。"""
    return RunContext(
        deps=BusinessToolDeps(account_phone=account_phone, query=query),
        model=TestModel(call_tools=[]),
        usage=RunUsage(),
    )


def _make_service(connection) -> BusinessQueryService:
    return BusinessQueryService(
        WorkOrdersRepository(connection),
        CustomersRepository(connection),
        CustomerCodeMappingsRepository(connection),
        ServiceCategoriesRepository(connection),
    )


def _make_order_fields(**overrides):
    fields = {
        "work_order_date": "2026-08-12",
        "created_at": "2026-08-12T10:00:00+00:00",
        "updated_at": "2026-08-12T10:00:00+00:00",
        "customer_id": 1,
        "customer_code": "001",
        "customer_name": "甲",
        "service_category": "洗水",
        "service_item": "单洗",
        "quantity": 10,
        "unit": "件",
        "unit_price_cents": 1000,
        "is_completed": 0,
        "deleted_at": None,
    }
    fields.update(overrides)
    return fields


# ---------- 注册表元数据 ----------


def test_registry_requires_approval_metadata():
    # 验证：5 读工具 requires_approval=False、2 写草案工具 True（§4.3）
    assert ALL_TOOL_NAMES <= get_registered_tool_names()
    for name in READ_TOOL_NAMES:
        assert is_registered(name) is True
        assert requires_approval_for(name) is False
    for name in WRITE_TOOL_NAMES:
        assert is_registered(name) is True
        assert requires_approval_for(name) is True


def test_build_tools_filters_by_allowed_whitelist():
    # 验证：build_tools(None) 含全部注册工具；build_tools(allowed) 只保留白名单
    all_tools = build_tools()
    assert {t.name for t in all_tools} >= ALL_TOOL_NAMES

    filtered = build_tools(allowed=["query_work_orders"])
    assert [t.name for t in filtered] == ["query_work_orders"]


# ---------- 读工具直接调用：返回字段名与 §4.2 一致 ----------


@pytest.mark.asyncio
async def test_query_work_orders_tool_returns_contract_fields(connection):
    # 验证：query_work_orders 返回 {items,total}，工单快照字段与 §4.2 一致
    orders = WorkOrdersRepository(connection)
    orders.apply_Write(
        "13800000000", "sync-wo-1", _make_order_fields(), 0,
    )
    ctx = _make_ctx("13800000000", _make_service(connection))

    result = await business_tools.query_work_orders(ctx, limit=10)

    assert set(result.keys()) == {"items", "total"}
    assert result["total"] == 1
    assert result["items"][0] == {
        "sync_id": "sync-wo-1",
        "work_order_date": "2026-08-12",
        "customer_id": 1,
        "customer_code": "001",
        "customer_name": "甲",
        "service_category": "洗水",
        "service_item": "单洗",
        "quantity": 10,
        "unit": "件",
        "unit_price_cents": 1000,
        "is_completed": 0,
        "row_version": 1,
    }


@pytest.mark.asyncio
async def test_summarize_work_orders_tool_returns_contract_fields(connection):
    # 验证：summarize_work_orders 返回 §4.2 的五个汇总字段
    orders = WorkOrdersRepository(connection)
    orders.apply_Write(
        "13800000000", "sync-wo-1",
        _make_order_fields(quantity=10, unit_price_cents=1000), 0,
    )
    orders.apply_Write(
        "13800000000", "sync-wo-2",
        _make_order_fields(quantity=5, unit_price_cents=None), 0,
    )
    ctx = _make_ctx("13800000000", _make_service(connection))

    result = await business_tools.summarize_work_orders(ctx)

    assert result == {
        "work_order_count": 2,
        "total_quantity": 15,
        "priced_count": 1,
        "priced_amount_cents": 10000,
        "unpriced_count": 1,
    }


@pytest.mark.asyncio
async def test_query_customers_tool_returns_contract_fields(connection):
    # 验证：query_customers 返回 {items,total}，快照字段与 §4.2 一致
    customers = CustomersRepository(connection)
    customers.apply_Write(
        "13800000000", "sync-c-1",
        {
            "canonical_name": "广州阿强制衣厂",
            "created_at": "2026-08-01T00:00:00+00:00",
            "updated_at": "2026-08-01T00:00:00+00:00",
        },
        0,
    )
    ctx = _make_ctx("13800000000", _make_service(connection))

    result = await business_tools.query_customers(ctx, keyword="阿强", limit=10)

    assert set(result.keys()) == {"items", "total"}
    assert result["total"] == 1
    assert result["items"][0] == {
        "customer_id": 1,
        "sync_id": "sync-c-1",
        "canonical_name": "广州阿强制衣厂",
        "archived_at": None,
    }


@pytest.mark.asyncio
async def test_query_customer_code_mappings_tool_returns_contract_fields(connection):
    # 验证：query_customer_code_mappings 返回 {items,total}，快照字段与 §4.2 一致
    mappings = CustomerCodeMappingsRepository(connection)
    mappings.apply_Write(
        "13800000000", "sync-m-1",
        {
            "customer_id": 1, "customer_code": "001", "customer_name": "甲",
            "valid_from": "2026-08-01", "valid_to": None,
            "created_at": "2026-08-01T00:00:00+00:00",
            "updated_at": "2026-08-01T00:00:00+00:00",
        },
        0,
    )
    ctx = _make_ctx("13800000000", _make_service(connection))

    result = await business_tools.query_customer_code_mappings(
        ctx, customer_code="001", limit=10
    )

    assert set(result.keys()) == {"items", "total"}
    assert result["total"] == 1
    assert result["items"][0] == {
        "mapping_id": 1,
        "sync_id": "sync-m-1",
        "customer_id": 1,
        "customer_code": "001",
        "customer_name": "甲",
        "valid_from": "2026-08-01",
        "valid_to": None,
    }


@pytest.mark.asyncio
async def test_query_service_categories_tool_returns_contract_fields(connection):
    # 验证：query_service_categories 返回 {items}，快照字段与 §4.2 一致
    categories = ServiceCategoriesRepository(connection)
    categories.apply_Write(
        "13800000000", "sync-sc-1",
        {
            "category_name": "洗水",
            "subcategories_json": json.dumps(
                [{"name": "单洗", "default_unit": "件", "is_active": True}],
                ensure_ascii=False,
            ),
            "is_active": 1,
            "created_at": "2026-08-01T00:00:00+00:00",
            "updated_at": "2026-08-01T00:00:00+00:00",
        },
        0,
    )
    ctx = _make_ctx("13800000000", _make_service(connection))

    result = await business_tools.query_service_categories(ctx)

    assert set(result.keys()) == {"items"}
    assert result["items"] == [
        {
            "sync_id": "sync-sc-1",
            "category_name": "洗水",
            "subcategories": [
                {"name": "单洗", "default_unit": "件", "is_active": True}
            ],
            "is_active": 1,
        }
    ]


@pytest.mark.asyncio
async def test_write_draft_tools_return_ack_shape():
    # 验证：两个写草案工具直接调用时只回执、不写库，返回 §4.3 的草案形状
    ctx = RunContext(
        deps=BusinessToolDeps(account_phone="13800000000", query=None),
        model=TestModel(call_tools=[]),
        usage=RunUsage(),
    )

    create = await business_tools.create_work_order(
        ctx, entity_sync_id=None, fields={"work_order_date": "2026-08-12"}
    )
    assert create == {
        "status": "draft_acknowledged",
        "operation_type": "create_work_order",
        "changes": [
            {
                "entity_type": "work_order",
                "entity_sync_id": None,
                "base_version": 0,
                "fields": {"work_order_date": "2026-08-12"},
            }
        ],
    }

    update = await business_tools.update_work_order(
        ctx,
        entity_sync_id="sync-wo-1",
        base_version=4,
        fields={"quantity": 12},
    )
    assert update == {
        "status": "draft_acknowledged",
        "operation_type": "update_work_order",
        "changes": [
            {
                "entity_type": "work_order",
                "entity_sync_id": "sync-wo-1",
                "base_version": 4,
                "fields": {"quantity": 12},
            }
        ],
    }


# ---------- 写草案暂停与 approve 续跑 ----------


@pytest.mark.asyncio
async def test_update_work_order_pauses_for_approval_then_runs_after_approval(
    connection, monkeypatch
):
    # 验证：requires_approval=True 的 update_work_order 在流式运行中暂停，
    # 工具函数不执行、业务表不写入；approve 续跑后工具执行、输出收尾文本、
    # 业务表仍无写入（后端工具永不落库，§4.3）。
    executed: list[dict[str, Any]] = []

    async def spy_update_work_order(
        ctx: RunContext[BusinessToolDeps],
        entity_sync_id: str,
        base_version: int,
        fields: dict,
    ) -> dict[str, Any]:
        executed.append(
            {
                "entity_sync_id": entity_sync_id,
                "base_version": base_version,
                "fields": fields,
            }
        )
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

    # 用 spy 替换注册表中的 update_work_order，以便观察“工具函数是否执行”；
    # Tool 名称取自函数 __name__，因此 spy 必须与注册键同名。
    spy_update_work_order.__name__ = "update_work_order"
    monkeypatch.setitem(
        registry_module._TOOL_REGISTRY,
        "update_work_order",
        (spy_update_work_order, True),
    )

    cfg = ModelConfig(
        model_name="deepseek-chat",
        base_url="https://api.deepseek.com",
        api_key="sk-x",
    )
    agent = build_Agent(cfg, allowed_tools=["update_work_order"])

    calls = 0

    async def stream_fn(messages, agent_info):
        nonlocal calls
        calls += 1
        if calls == 1:
            # 第一轮：模型只发一个 requires_approval 工具调用
            yield {
                0: DeltaToolCall(
                    name="update_work_order",
                    json_args=json.dumps(
                        {
                            "entity_sync_id": "sync-wo-1",
                            "base_version": 4,
                            "fields": {"quantity": 12},
                        }
                    ),
                    tool_call_id="call-1",
                )
            }
        else:
            # 第二轮：approve 续跑后输出收尾文本
            yield "已生成工单修改草案，等你确认后由前端提交。"

    function_model = FunctionModel(stream_function=stream_fn)
    deps = BusinessToolDeps(account_phone="13800000000", query=None)

    with agent.override(model=function_model):
        # ---- 第一轮：应暂停并产出 DeferredToolRequests ----
        async with agent.run_stream_events(
            "把 sync-wo-1 的数量改成 12", deps=deps
        ) as run:
            async for _event in run:
                pass
        output = run.result.output
        assert isinstance(output, DeferredToolRequests)
        assert len(output.approvals) == 1
        assert output.approvals[0].tool_name == "update_work_order"
        assert executed == []  # 未确认前工具函数不执行
        assert connection.execute(
            "SELECT COUNT(*) FROM work_orders"
        ).fetchone()[0] == 0

        # ---- 第二轮：approve 后工具执行，输出收尾文本 ----
        results = output.build_results(
            approvals={output.approvals[0].tool_call_id: True}
        )
        async with agent.run_stream_events(
            None,
            message_history=run.result.all_messages(),
            deferred_tool_results=results,
            deps=deps,
        ) as run2:
            async for _event in run2:
                pass
        assert run2.result.output == "已生成工单修改草案，等你确认后由前端提交。"
        assert executed == [
            {
                "entity_sync_id": "sync-wo-1",
                "base_version": 4,
                "fields": {"quantity": 12},
            }
        ]
        # 写草案工具只回执不写库
        assert connection.execute(
            "SELECT COUNT(*) FROM work_orders"
        ).fetchone()[0] == 0
