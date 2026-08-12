"""AI 工具注册表：register_tool 注册 + build_tools 过滤（docs/spec/chat-agent.md §9）。

MVP 注册表为空，结构预留。工具函数签名约定：首参 `ctx: RunContext[Any]`，
返回值 dict[str, Any]（成功/失败都走结构化返回）。新增工具只需 @register_tool，
无需改 agent 构建代码。
"""

from __future__ import annotations

from typing import Any

from pydantic_ai.tools import Tool

# 已注册工具名集合与注册表：build_tools 据此包装为 Pydantic AI Tool 列表
_REGISTERED_TOOL_NAMES: set[str] = set()
_TOOL_REGISTRY: dict[str, Any] = {}


def register_tool(func: Any) -> Any:
    """工具注册装饰器：函数名即工具名，原函数原样返回。"""
    tool_name = func.__name__
    _REGISTERED_TOOL_NAMES.add(tool_name)
    _TOOL_REGISTRY[tool_name] = func
    return func


def get_registered_tool_names() -> set[str]:
    """返回已注册工具名集合的副本，避免外部误改内部状态。"""
    return set(_REGISTERED_TOOL_NAMES)


def build_tools(allowed: list[str] | None = None) -> list[Tool[Any]]:
    """根据注册表构建 Tool 列表；allowed 为白名单过滤，None 表示全部。"""
    allowed_set = set(allowed) if allowed else None
    tools: list[Tool[Any]] = []
    for tool_name, func in _TOOL_REGISTRY.items():
        if allowed_set is not None and tool_name not in allowed_set:
            continue
        tools.append(Tool(func))
    return tools
