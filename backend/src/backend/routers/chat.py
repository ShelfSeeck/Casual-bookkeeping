"""聊天路由（docs/spec/chat-agent.md §4）：会话 / 回合 / 模型诊断。

4 个聊天端点 + 1 个模型诊断端点，全部经 get_CurrentAccount 鉴权并注入身份，
账户隔离以注入的 account_phone 为准。SSE 事件协议见 docs/spec/chat-agent.md §5。

MVP 范围：只实现 send 模式（POST /turns 发消息）。approve 模式 / 工具确认握手
不实现（工具注册表为空，tool_confirm_request 不会触发）；approve 请求因缺
turn_id/message 字段走 FastAPI 422。

MVP 已知近似：session_busy（单飞锁冲突）在 ChatService.run_Turn 内抛出，
发生在 SSE 流开始之后（客户端看到流中断）；session_not_found 由本层在流开始前
直接返回 404 统一错误，满足 spec §5。
"""

import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pydantic_ai.messages import (
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    TextPart,
)

from backend.deps import (
    CurrentAccount,
    get_CurrentAccount,
    get_ChatService,
    get_ChatSessionsRepository,
    get_ChatTurnsRepository,
)
from backend.errors import (
    ERROR_MODEL_CONFIG_MISSING,
    ERROR_SESSION_NOT_FOUND,
    AppError,
)
from backend.repositories.chat_sessions import ChatSessionsRepository
from backend.repositories.chat_turns import ChatTurnsRepository
from backend.services.chat import ChatService
from backend.services.model_config import ModelConfigError, get_ActiveModelConfig

router = APIRouter(prefix="/chat", tags=["chat"])

# 会话列表 / 回合历史的游标分页上限（docs/spec/chat-agent.md §4.3 limit 默认 50）
TURNS_DEFAULT_LIMIT = 50
TURNS_MAX_LIMIT = 500


class CreateSessionRequest(BaseModel):
    title: str


class SendTurnRequest(BaseModel):
    turn_id: str
    message: str
    # 本轮允许的工具白名单（预留；MVP 无工具，忽略）
    allowed_tools: list[str] | None = None


def _new_session_id() -> str:
    # 统一 ID 格式：业务前缀 + uuid4().hex[:12]（docs/auth-structure.md §2.7）
    return f"s-{uuid.uuid4().hex[:12]}"


def _session_public(record: dict[str, Any]) -> dict[str, Any]:
    """会话对外字段：不含 account_phone（docs/spec/chat-agent.md §4.1/§4.2）。"""
    return {
        "session_id": record["session_id"],
        "title": record["title"],
        "created_at": record["created_at"],
        "updated_at": record["updated_at"],
    }


def _flatten_messages(messages_json: str) -> list[dict[str, Any]]:
    """把一轮 ModelMessage[] 摊平成 user/assistant 展示段（docs/spec/chat-agent.md §4.3）。

    前端不认识 Pydantic AI 内部结构，只收到 {role, content, type} 文本段；
    系统指令 / 工具调用等 part 不展示（MVP 无工具，仅 text）。
    """
    messages = ModelMessagesTypeAdapter.validate_json(messages_json)
    out: list[dict[str, Any]] = []
    for message in messages:
        if isinstance(message, ModelRequest):
            content = "".join(
                p.content for p in message.parts if isinstance(p, TextPart)
            )
            if content:
                out.append({"role": "user", "content": content, "type": "text"})
        elif isinstance(message, ModelResponse):
            content = "".join(
                p.content for p in message.parts if isinstance(p, TextPart)
            )
            if content:
                out.append({"role": "assistant", "content": content, "type": "text"})
    return out


def _require_owned_session(
    sessions: ChatSessionsRepository, sid: str, account_phone: str
) -> dict[str, Any]:
    """归属校验：会话必须存在且属于当前账户，否则 404 session_not_found。"""
    record = sessions.get_Session(sid)
    if record is None or record["account_phone"] != account_phone:
        raise AppError(ERROR_SESSION_NOT_FOUND, "会话不存在", 404)
    return record


async def _sse(events: AsyncIterator[dict[str, Any]]) -> AsyncIterator[str]:
    """把 ChatService 的事件 dict 序列化为 SSE 帧（docs/spec/chat-agent.md §5）。"""
    async for event in events:
        yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


# ---------- POST /chat/sessions ----------

@router.post("/sessions")
def create_session(
    body: CreateSessionRequest,
    current: CurrentAccount = Depends(get_CurrentAccount),
    sessions: ChatSessionsRepository = Depends(get_ChatSessionsRepository),
) -> dict:
    record = sessions.create_Session(
        current.account_phone, _new_session_id(), body.title
    )
    return _session_public(record)


# ---------- GET /chat/sessions ----------

@router.get("/sessions")
def list_sessions(
    current: CurrentAccount = Depends(get_CurrentAccount),
    sessions: ChatSessionsRepository = Depends(get_ChatSessionsRepository),
) -> dict:
    return {"sessions": [_session_public(r) for r in sessions.list_Sessions(current.account_phone)]}


# ---------- GET /chat/sessions/{sid}/turns ----------

@router.get("/sessions/{sid}/turns")
def list_turns(
    sid: str,
    after_turn_id: str | None = None,
    limit: int = TURNS_DEFAULT_LIMIT,
    current: CurrentAccount = Depends(get_CurrentAccount),
    sessions: ChatSessionsRepository = Depends(get_ChatSessionsRepository),
    turns: ChatTurnsRepository = Depends(get_ChatTurnsRepository),
) -> dict:
    _require_owned_session(sessions, sid, current.account_phone)
    limit = max(1, min(limit, TURNS_MAX_LIMIT))
    rows, next_cursor = turns.list_Turns(sid, after_turn_id, limit)
    return {
        "turns": [
            {
                "turn_id": r["turn_id"],
                "created_at": r["created_at"],
                "messages": _flatten_messages(r["messages_json"]),
            }
            for r in rows
        ],
        "next_cursor": next_cursor,
    }


# ---------- POST /chat/sessions/{sid}/turns（send 模式，SSE） ----------

@router.post("/sessions/{sid}/turns")
async def send_turn(
    sid: str,
    body: SendTurnRequest,
    current: CurrentAccount = Depends(get_CurrentAccount),
    sessions: ChatSessionsRepository = Depends(get_ChatSessionsRepository),
    service: ChatService = Depends(get_ChatService),
) -> StreamingResponse:
    # 流开始前做归属校验：session_not_found 以统一 JSON 错误返回（spec §5）
    _require_owned_session(sessions, sid, current.account_phone)
    events = service.run_Turn(
        current.account_phone, sid, body.turn_id, body.message
    )
    return StreamingResponse(_sse(events), media_type="text/event-stream")


# ---------- GET /chat/model-config ----------

@router.get("/model-config")
def model_config() -> dict:
    try:
        cfg = get_ActiveModelConfig()
    except ModelConfigError as exc:
        raise AppError(ERROR_MODEL_CONFIG_MISSING, str(exc), 500) from None
    return {
        "model_name": cfg.model_name,
        "base_url": cfg.base_url,
        "api_key_configured": bool(cfg.api_key),
    }
