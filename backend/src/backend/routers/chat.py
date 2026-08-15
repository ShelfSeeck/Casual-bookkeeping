"""聊天路由（docs/spec/chat-agent.md §4、docs/spec/agent-tools.md §5.5）：会话 / 回合 / 模型诊断。

4 个聊天端点 + 1 个模型诊断端点，全部经 get_CurrentAccount 鉴权并注入身份，
账户隔离以注入的 account_phone 为准。SSE 事件协议见 docs/spec/chat-agent.md §5。

POST /turns 单模型双模式：
- approval_request_id 非空 → approve 模式：缺 approved → invalid_approval 400；
  归属校验由 ChatService.approve_Turn 用 pending.session_id 完成（本层不做
  sessions 查询），错误在流开始前以统一 JSON 返回。
- 否则 send 模式：缺 turn_id / message → invalid_request 400；流开始前做
  会话归属校验（session_not_found 404 直接返回）与 ChatService.preflight_Send
  （tool_approval_required / session_busy 409 直接返回）。
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
    UserPromptPart,
)

from backend.deps import (
    CurrentAccount,
    get_CurrentAccount,
    get_ChatService,
    get_ChatSessionsRepository,
    get_ChatTurnsRepository,
)
from backend.errors import (
    ERROR_INVALID_APPROVAL,
    ERROR_INVALID_REQUEST,
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


class TurnRequest(BaseModel):
    """POST /turns 单模型双模式（docs/spec/agent-tools.md §5.5）。"""

    turn_id: str | None = None
    message: str | None = None
    # 本轮允许的工具白名单（send 模式透传；approve 模式忽略）
    allowed_tools: list[str] | None = None
    approval_request_id: str | None = None
    approved: bool | None = None


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
        # list_Sessions 带回合数；get_Session / create_Session 无该字段时按 0 输出
        "turn_count": record.get("turn_count", 0),
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
            # 用户消息 part 是 UserPromptPart；工具回执（ToolReturnPart）等不展示。
            content = "".join(
                p.content
                for p in message.parts
                if isinstance(p, (UserPromptPart, TextPart))
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


# ---------- POST /chat/sessions/{sid}/turns（send / approve 双模式，SSE） ----------

@router.post("/sessions/{sid}/turns")
async def post_turn(
    sid: str,
    body: TurnRequest,
    current: CurrentAccount = Depends(get_CurrentAccount),
    sessions: ChatSessionsRepository = Depends(get_ChatSessionsRepository),
    service: ChatService = Depends(get_ChatService),
) -> StreamingResponse:
    if body.approval_request_id is not None:
        # approve 模式：缺 approved → invalid_approval 400；归属校验由
        # ChatService.approve_Turn 用 pending.session_id 完成（流开始前）。
        if body.approved is None:
            raise AppError(ERROR_INVALID_APPROVAL, "确认请求缺少 approved 字段", 400)
        events = service.approve_Turn(
            current.account_phone, sid, body.approval_request_id, body.approved
        )
        return StreamingResponse(_sse(events), media_type="text/event-stream")

    # send 模式：缺字段 → invalid_request 400；流开始前做归属校验
    if body.turn_id is None or body.message is None:
        raise AppError(ERROR_INVALID_REQUEST, "缺少 turn_id 或 message", 400)
    _require_owned_session(sessions, sid, current.account_phone)
    # 流前 preflight：pending 未处理 / 同账户回合运行中时，必须在 SSE 流开始
    # 前以统一 JSON 返回 409（docs/spec/chat-agent.md §5）。run_Turn 内保留
    # 同样的幂等检查作为直接服务调用方的防御纵深。
    service.preflight_Send(current.account_phone)
    events = service.run_Turn(
        current.account_phone, sid, body.turn_id, body.message, body.allowed_tools
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
