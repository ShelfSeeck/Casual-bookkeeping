"""Pydantic AI Agent 构建（docs/spec/chat-agent.md §9 services/agent.py）。

- 模型来自 get_ActiveModelConfig()（每次调用热读 config.toml [model]）。
- 工具来自 build_tools(allowed)，业务工具在 tools/business_tools.py 注册。
- deps_type=BusinessToolDeps：账户身份 + 只读查询门面（ChatService 注入）。
- output_type=[str, DeferredToolRequests]：文本正常输出；写草案暂停时输出
  DeferredToolRequests 等待前端确认（docs/spec/agent-tools.md §4.4）。
- 内循环由 Pydantic AI 黑盒完成（run / run_stream_events），本模块不手写循环。
"""

from __future__ import annotations

from dataclasses import dataclass

from pydantic_ai import Agent, DeferredToolRequests
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from backend.services.business_query import BusinessQueryService
from backend.services.model_config import ModelConfig, get_ActiveModelConfig
from backend.services.prompts import render_Instructions
from backend.tools.registry import build_tools

AGENT_NAME = "bookkeeping_assistant"


@dataclass(frozen=True)
class BusinessToolDeps:
    """工具运行时依赖：当前账户 + 只读查询门面。

    query 允许为 None（测试 fake 可传 None）；真实运行由 ChatService 注入
    BusinessQueryService（docs/spec/agent-tools.md §4.1）。
    """

    account_phone: str
    query: BusinessQueryService | None


def build_Agent(
    model_config: ModelConfig | None = None,
    *,
    allowed_tools: list[str] | None = None,
) -> Agent[BusinessToolDeps, str | DeferredToolRequests]:
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
        instructions=render_Instructions(),
        deps_type=BusinessToolDeps,
        output_type=[str, DeferredToolRequests],
        tools=build_tools(allowed_tools),
    )


# 导入即注册 7 个业务工具（5 读 + 2 写草案）。
# 放在文件末尾：business_tools 反向 import BusinessToolDeps，需先完成定义。
from backend.tools import business_tools  # noqa: E402, F401
