"""ChatService：AI 对话编排（docs/spec/chat-agent.md §9 services/chat.py）。

- 单飞锁：按 account_phone 维护进程内 asyncio.Lock 字典，同账户同时只跑一个回合。
- run_stream_events 事件转发：只透传文本增量（PartDeltaEvent + TextPartDelta），
  其余事件（工具调用/确认握手等，MVP 不触发）不转发。
- 回合落库：成功完成的事件流结束后用 run.result.new_messages_json() 保存。
- 异常映射：模型配置缺失 / 其他异常映射为 done.error 的 error_code，不落库、不重抛。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from typing import Any

from pydantic_ai import Agent
from pydantic_ai.messages import PartDeltaEvent, TextPartDelta

from backend.errors import (
    ERROR_MODEL_CALL_FAILED,
    ERROR_MODEL_CONFIG_MISSING,
    ERROR_SESSION_BUSY,
    ERROR_SESSION_NOT_FOUND,
    AuthError,
)
from backend.services.agent import build_Agent
from backend.services.model_config import ModelConfigError


class ChatService:
    """聊天编排门面：send 模式的单回合流式执行与落库。"""

    def __init__(
        self,
        sessions,
        turns,
        agent_factory: Callable[[], Agent] | None = None,
    ) -> None:
        self._sessions = sessions
        self._turns = turns
        self._agent_factory = agent_factory or build_Agent
        self._locks: dict[str, asyncio.Lock] = {}

    async def run_Turn(
        self,
        account_phone: str,
        session_id: str,
        turn_id: str,
        message: str,
    ) -> AsyncIterator[dict[str, Any]]:
        """执行一个回合：归属校验 → 单飞锁 → 流式事件 → 落库 → done 帧。"""
        record = self._sessions.get_Session(session_id)
        if record is None or record["account_phone"] != account_phone:
            raise AuthError(ERROR_SESSION_NOT_FOUND, "会话不存在", 404)

        lock = self._locks.get(account_phone)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[account_phone] = lock
        if lock.locked():
            raise AuthError(ERROR_SESSION_BUSY, "已有回合在运行", 409)

        await lock.acquire()
        try:
            try:
                agent = self._agent_factory()
                async with agent.run_stream_events(message) as run:
                    async for event in run:
                        if isinstance(event, PartDeltaEvent) and isinstance(
                            event.delta, TextPartDelta
                        ):
                            yield {
                                "type": "text_delta",
                                "content": event.delta.content_delta,
                            }
                self._turns.upsert_Turn(
                    turn_id, session_id, run.result.new_messages_json().decode()
                )
                yield {"type": "done", "turn_id": turn_id, "error": None}
            except ModelConfigError as exc:
                yield {
                    "type": "done",
                    "turn_id": turn_id,
                    "error": {
                        "error_code": ERROR_MODEL_CONFIG_MISSING,
                        "message": str(exc),
                    },
                }
            except Exception as exc:  # noqa: BLE001 - 模型调用失败统一映射
                yield {
                    "type": "done",
                    "turn_id": turn_id,
                    "error": {
                        "error_code": ERROR_MODEL_CALL_FAILED,
                        "message": str(exc),
                    },
                }
        finally:
            lock.release()
