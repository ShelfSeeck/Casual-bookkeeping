"""AI 工具注册表：register_tool 注册 + build_tools 过滤（docs/spec/agent-tools.md §4.4）。

工具函数签名约定：首参 `ctx: RunContext[Any]`（业务工具用
`RunContext[BusinessToolDeps]`），返回值 dict[str, Any]（成功/失败都走结构化返回）。
新增工具只需 @register_tool（或 @register_tool(requires_approval=True)），
无需改 agent 构建代码。
"""

from __future__ import annotations

from typing import Any

from pydantic_ai.tools import Tool

# 已注册工具名集合与注册表：build_tools 据此包装为 Pydantic AI Tool 列表。
# 值从函数升级为 (func, requires_approval)，兼容 §4.3 的写草案工具元数据。
_REGISTERED_TOOL_NAMES: set[str] = set()
_TOOL_REGISTRY: dict[str, tuple[Any, bool, Any | None]] = {}


def register_tool(
    func: Any = None, *, requires_approval: bool = False, args_validator: Any = None
) -> Any:
    """工具注册装饰器：函数名即工具名，原函数原样返回。

    - @register_tool：旧的无参装饰器用法（requires_approval=False）
    - @register_tool(requires_approval=True)：写草案工具（确认后才会执行）
    """

    def decorator(inner: Any) -> Any:
        tool_name = inner.__name__
        _REGISTERED_TOOL_NAMES.add(tool_name)
        _TOOL_REGISTRY[tool_name] = (inner, requires_approval, args_validator)
        return inner

    if func is None:
        return decorator
    return decorator(func)


def get_registered_tool_names() -> set[str]:
    """返回已注册工具名集合的副本，避免外部误改内部状态。"""
    return set(_REGISTERED_TOOL_NAMES)


def is_registered(tool_name: str) -> bool:
    """工具名是否已注册；供恢复待确认调用时判断工具性质。"""
    return tool_name in _REGISTERED_TOOL_NAMES


def requires_approval_for(tool_name: str) -> bool:
    """返回工具是否需要人工确认；未注册返回 False。"""
    meta = _TOOL_REGISTRY.get(tool_name)
    return meta[1] if meta is not None else False


def build_tools(allowed: list[str] | None = None) -> list[Tool[Any]]:
    """根据注册表构建 Tool 列表；allowed 为白名单过滤，None 表示全部。"""
    allowed_set = set(allowed) if allowed is not None else None
    tools: list[Tool[Any]] = []
    for tool_name, meta in _TOOL_REGISTRY.items():
        if allowed_set is not None and tool_name not in allowed_set:
            continue
        # 兼容测试或旧扩展直接写入的二元组。
        func, requires_approval = meta[:2]
        args_validator = meta[2] if len(meta) > 2 else None
        tools.append(
            Tool(
                func,
                requires_approval=requires_approval,
                args_validator=args_validator,
            )
        )
    return tools
