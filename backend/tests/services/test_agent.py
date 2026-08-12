"""缝 9：Agent 构建（docs/spec/chat-agent.md §9 services/agent.py）。

被测缝：
- build_Agent —— 给定 ModelConfig 构建 Pydantic AI Agent：
  - 返回可运行的 Agent（TestModel override 后跑一个回合有固定输出）
  - MVP 工具注册表为空 → 构建出的 agent 无 function tools
  - 未传 ModelConfig 时走 get_ActiveModelConfig()（默认热读路径）
- 工具注册表（tools/registry.py）：
  - register_tool 注册后 get_registered_tool_names 可见
  - build_tools(allowed) 按白名单过滤
"""

import pytest
from pydantic_ai import RunContext
from pydantic_ai.models.test import TestModel

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
    model = TestModel()
    with agent.override(model=model):
        result = await agent.run("你好")
    assert result.output == "success (no tool calls)"
    # MVP 无工具：构建出的 agent 不应声明任何 function tool
    assert model.last_model_request_parameters.function_tools == []


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
    model = TestModel()
    with agent.override(model=model):
        result = await agent.run("你好")
    assert result.output == "success (no tool calls)"


def test_register_tool_records_name():
    # 注册后名字可见；未注册的普通函数不可见
    @register_tool
    async def dummy_tool(ctx: RunContext[object]) -> str:
        """dummy tool"""
        return "ok"

    assert "dummy_tool" in get_registered_tool_names()


def test_build_tools_filters_by_allowed():
    # build_tools(None) 返回全部；build_tools(allowed) 只保留白名单内的
    @register_tool
    async def tool_a(ctx: RunContext[object]) -> str:
        """tool a"""
        return "a"

    @register_tool
    async def tool_b(ctx: RunContext[object]) -> str:
        """tool b"""
        return "b"

    all_tools = build_tools()
    assert {t.name for t in all_tools} >= {"tool_a", "tool_b"}

    filtered = build_tools(allowed=["tool_a"])
    assert [t.name for t in filtered] == ["tool_a"]
