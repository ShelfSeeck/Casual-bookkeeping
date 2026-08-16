"""缝 9：Agent 构建（docs/spec/chat-agent.md §9 services/agent.py）。

被测缝：
- build_Agent —— 给定 ModelConfig 构建 Pydantic AI Agent：
  - 返回可运行的 Agent（TestModel override 后跑一个回合有固定输出）
  - 构建出的 agent 声明注册表中的 7 个业务工具（5 读 + 2 写草案）
  - 未传 ModelConfig 时走 get_ActiveModelConfig()（默认热读路径）
- 工具注册表（tools/registry.py）：
  - register_tool 注册后 get_registered_tool_names 可见（白名单过滤行为见 test_agent_tools.py）
"""

import pytest
from pydantic_ai import RunContext
from pydantic_ai.models.test import TestModel

import backend.tools.registry as tool_registry
from backend.services.agent import build_Agent
from backend.services.model_config import ModelConfig
from backend.tools.registry import (
    build_tools,
    get_registered_tool_names,
    register_tool,
)


@pytest.mark.asyncio
async def test_build_Agent_runs_with_TestModel():
    # 用 TestModel override：能跑通一个回合即证明 Agent 可运行
    cfg = ModelConfig(
        model_name="deepseek-chat",
        base_url="https://api.deepseek.com",
        api_key="sk-x",
    )
    agent = build_Agent(cfg)
    model = TestModel(call_tools=[])  # 不发工具调用，保留“跑通”断言
    with agent.override(model=model):
        result = await agent.run("你好")
    assert result.output == "success (no tool calls)"
    # 构建出的 agent 应声明注册表中的 7 个业务工具（5 读 + 2 写草案）
    assert {
        t.name for t in model.last_model_request_parameters.function_tools
    } == {
        "query_work_orders",
        "summarize_work_orders",
        "query_customers",
        "query_customer_code_mappings",
        "query_service_categories",
        "create_work_order",
        "update_work_order",
    }


@pytest.mark.asyncio
async def test_build_Agent_defaults_to_active_config(monkeypatch):
    # 不传 ModelConfig 时走 get_ActiveModelConfig() 热读路径
    captured = {}

    def fake_config():
        captured["called"] = True
        return ModelConfig(
            model_name="m",
            base_url="https://b.com",
            api_key="",
        )

    monkeypatch.setattr("backend.services.agent.get_ActiveModelConfig", fake_config)
    agent = build_Agent()
    assert captured["called"] is True
    model = TestModel(call_tools=[])  # 不发工具调用，保留“跑通”断言
    with agent.override(model=model):
        result = await agent.run("你好")
    assert result.output == "success (no tool calls)"


def test_register_tool_records_name(monkeypatch):
    # 注册后名字可见；未注册的普通函数不可见。
    # 在临时注册表副本上注册，避免污染 build_Agent 测试断言的 7 个业务工具。
    monkeypatch.setattr(tool_registry, "_TOOL_REGISTRY", {})
    monkeypatch.setattr(tool_registry, "_REGISTERED_TOOL_NAMES", set())

    @register_tool
    async def dummy_tool(ctx: RunContext[object]) -> str:
        """dummy tool"""
        return "ok"

    assert "dummy_tool" in get_registered_tool_names()


def test_build_tools_empty_whitelist_returns_no_tools(monkeypatch):
    # allowed=[] 表示“本轮零工具”，必须返回空列表而不是退化为全部工具
    monkeypatch.setattr(tool_registry, "_TOOL_REGISTRY", {})
    monkeypatch.setattr(tool_registry, "_REGISTERED_TOOL_NAMES", set())

    @register_tool
    async def tool_a(ctx: RunContext[object]) -> str:
        """tool a"""
        return "a"

    assert build_tools([]) == []
