"""Pydantic AI Agent 构建（docs/spec/chat-agent.md §9 services/agent.py）。

- 模型来自 get_ActiveModelConfig()（每次调用热读 config.toml [model]）。
- 工具来自 build_tools(allowed)，MVP 注册表为空。
- 内循环由 Pydantic AI 黑盒完成（run / run_stream_events），本模块不手写循环。
"""

from __future__ import annotations

from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from backend.services.model_config import ModelConfig, get_ActiveModelConfig
from backend.services.prompts import INSTRUCTIONS
from backend.tools.registry import build_tools

AGENT_NAME = "bookkeeping_assistant"


def build_Agent(
    model_config: ModelConfig | None = None,
    *,
    allowed_tools: list[str] | None = None,
) -> Agent:
    """构建记账助手 Agent。

    Args:
        model_config: 显式模型配置（测试注入用）；默认走 get_ActiveModelConfig() 热读。
        allowed_tools: 本轮允许的工具白名单，None 表示使用注册表全部工具。
    """
    cfg = model_config or get_ActiveModelConfig()
    # api_key 允许为空（本地/无需密钥的兼容服务）：传 None 让 OpenAIProvider 用占位 key
    provider = OpenAIProvider(base_url=cfg.base_url, api_key=cfg.api_key or None)
    model = OpenAIChatModel(cfg.model_name, provider=provider)
    return Agent(
        model,
        name=AGENT_NAME,
        instructions=INSTRUCTIONS,
        tools=build_tools(allowed_tools),
    )
