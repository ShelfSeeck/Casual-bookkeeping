"""ChatService：AI 对话编排（docs/spec/chat-agent.md §9、docs/spec/agent-tools.md §5）。

- 共享状态：单飞锁 _LOCKS 与待确认 _PENDING 按 account_phone 维护在模块级
  （FastAPI 每请求新建 ChatService，实例字段锁不住并发）。
- send 模式：归属校验 → pending 前置校验 → 单飞锁 → run_stream_events 转发
  text_delta → 写草案暂停时落部分回合 + tool_confirm_request、不发 done；
  正常结束落库 + done。
- approve 模式：内存 pending 缺失时从已落库的部分回合恢复
  （recover_PendingApprovals）；加载部分回合 → DeferredToolResults → 续跑 →
  最终回合整体覆盖 + done；成功后清除 pending，模型异常时保留 pending。
- 异常映射：模型配置缺失 / 其他异常映射为 done.error 的 error_code。
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

from pydantic_ai import Agent
from pydantic_ai.messages import (
    ModelMessagesTypeAdapter,
    PartDeltaEvent,
    TextPartDelta,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.tools import DeferredToolRequests

from backend.errors import (
    ERROR_APPROVAL_NOT_FOUND,
    ERROR_MODEL_CALL_FAILED,
    ERROR_MODEL_CONFIG_MISSING,
    ERROR_SESSION_BUSY,
    ERROR_SESSION_NOT_FOUND,
    ERROR_TOOL_APPROVAL_REQUIRED,
    ERROR_TURN_NOT_FOUND,
    AuthError,
)
from backend.services.agent import BusinessToolDeps, build_Agent
from backend.services.business_query import BusinessQueryService
from backend.services.model_config import ModelConfigError
from backend.tools import registry as tools_registry

# 每账户至多一个未处理确认；单飞锁与 pending 必须跨请求进程级共享。
_LOCKS: dict[str, asyncio.Lock] = {}
_PENDING: dict[str, "PendingApproval"] = {}

# 恢复扫描上限：与 GET /turns 的分页上限对齐，避免无界扫库。
_RECOVERY_SCAN_LIMIT = 500


@dataclass
class PendingCall:
    """一次待确认工具调用的前端事件载荷。"""

    request_id: str
    tool_call_id: str
    tool_name: str
    args: dict[str, Any]


@dataclass
class PendingApproval:
    """按账户保存的待确认批（docs/spec/agent-tools.md §5.1）。"""

    request_id: str  # ar-<uuid4().hex[:12]>
    account_phone: str
    session_id: str
    turn_id: str
    requests: DeferredToolRequests
    calls: list[PendingCall]


def reset_SharedState() -> None:
    """测试缝：清空进程级共享状态，避免测试串扰。"""
    _LOCKS.clear()
    _PENDING.clear()


def recover_PendingApprovals(messages: list[Any]) -> DeferredToolRequests | None:
    """从消息历史重建未回执的 requires_approval 工具调用（docs/spec/agent-tools.md §5.4）。

    遍历所有 ToolCallPart / ToolReturnPart：只取「无回执」且工具名在注册表中
    requires_approval=True 的调用，重新构造 DeferredToolRequests；无则返回 None。
    """
    tool_calls: dict[str, ToolCallPart] = {}
    returned: set[str] = set()
    for message in messages:
        for part in getattr(message, "parts", []):
            if isinstance(part, ToolCallPart):
                tool_calls[part.tool_call_id] = part
            elif isinstance(part, ToolReturnPart):
                returned.add(part.tool_call_id)

    approvals = [
        call
        for call_id, call in tool_calls.items()
        if call_id not in returned and tools_registry.requires_approval_for(call.tool_name)
    ]
    if not approvals:
        return None
    return DeferredToolRequests(approvals=approvals)


def _new_ApprovalRequestId() -> str:
    return f"ar-{uuid.uuid4().hex[:12]}"


def _parse_CallArgs(args: str | dict[str, Any] | None) -> dict[str, Any]:
    """tool_call.args 为 str 时按 JSON 解析成 dict；dict 原样返回（§5.2）。"""
    if isinstance(args, dict):
        return args
    if isinstance(args, str):
        return json.loads(args)
    return {}


def _make_PendingApproval(
    account_phone: str,
    session_id: str,
    turn_id: str,
    requests: DeferredToolRequests,
) -> PendingApproval:
    request_id = _new_ApprovalRequestId()
    calls = [
        PendingCall(
            request_id=request_id,
            tool_call_id=call.tool_call_id,
            tool_name=call.tool_name,
            args=_parse_CallArgs(call.args),
        )
        for call in requests.approvals
    ]
    return PendingApproval(
        request_id=request_id,
        account_phone=account_phone,
        session_id=session_id,
        turn_id=turn_id,
        requests=requests,
        calls=calls,
    )


def _tool_confirm_event(
    pending: PendingApproval, call: PendingCall
) -> dict[str, Any]:
    return {
        "type": "tool_confirm_request",
        "request_id": pending.request_id,
        "tool_call_id": call.tool_call_id,
        "tool_name": call.tool_name,
        "draft": call.args,
    }


class ChatService:
    """聊天编排门面：send / approve 两种模式的流式执行与落库。"""

    def __init__(
        self,
        sessions,
        turns,
        agent_factory: Callable[[list[str] | None], Agent] | None = None,
        business_query: BusinessQueryService | None = None,
    ) -> None:
        self._sessions = sessions
        self._turns = turns
        # 默认工厂需要包一层：build_Agent 的 allowed_tools 是 keyword-only，
        # ChatService 统一按位置调用 agent_factory(allowed_tools)（任务约定）。
        self._agent_factory = agent_factory or (
            lambda allowed_tools=None: build_Agent(allowed_tools=allowed_tools)
        )
        self._business_query = business_query

    async def run_Turn(
        self,
        account_phone: str,
        session_id: str,
        turn_id: str,
        message: str,
        allowed_tools: list[str] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """send 模式：归属校验 → pending 前置校验 → 单飞锁 → 流式事件 → 落库/暂停。"""
        record = self._sessions.get_Session(session_id)
        if record is None or record["account_phone"] != account_phone:
            raise AuthError(ERROR_SESSION_NOT_FOUND, "会话不存在", 404)

        # 先于锁检查：pending 意味着存在未处理确认，新消息一律 409。
        if account_phone in _PENDING:
            raise AuthError(ERROR_TOOL_APPROVAL_REQUIRED, "存在未处理的工具确认请求", 409)

        lock = _LOCKS.get(account_phone)
        if lock is None:
            lock = asyncio.Lock()
            _LOCKS[account_phone] = lock
        if lock.locked():
            raise AuthError(ERROR_SESSION_BUSY, "已有回合在运行", 409)

        await lock.acquire()
        try:
            try:
                agent = self._agent_factory(allowed_tools)
                deps = BusinessToolDeps(account_phone, self._business_query)
                async with agent.run_stream_events(message, deps=deps) as run:
                    async for event in run:
                        if isinstance(event, PartDeltaEvent) and isinstance(
                            event.delta, TextPartDelta
                        ):
                            yield {
                                "type": "text_delta",
                                "content": event.delta.content_delta,
                            }

                output = run.result.output
                if isinstance(output, DeferredToolRequests) and output.approvals:
                    # 写草案暂停：部分落库 + tool_confirm_request，不发 done。
                    pending = _make_PendingApproval(
                        account_phone, session_id, turn_id, output
                    )
                    _PENDING[account_phone] = pending
                    try:
                        self._turns.upsert_Turn(
                            turn_id,
                            session_id,
                            ModelMessagesTypeAdapter.dump_json(
                                run.result.all_messages()
                            ).decode(),
                        )
                        for call in pending.calls:
                            yield _tool_confirm_event(pending, call)
                    except Exception:
                        # 落库/发事件失败不能留半截 pending。
                        _PENDING.pop(account_phone, None)
                        raise
                else:
                    # 正常完成（含 approvals 为空的 DeferredToolRequests）。
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

    def approve_Turn(
        self,
        account_phone: str,
        session_id: str,
        approval_request_id: str,
        approved: bool,
    ) -> AsyncIterator[dict[str, Any]]:
        """approve 模式（docs/spec/agent-tools.md §5.3）。

        所有同步校验（pending 归属 / 恢复 / 回合读取）在返回流之前完成，
        让 HTTP 层错误能以统一 JSON 在流开始前返回（docs/spec/chat-agent.md §5）。
        返回一个异步迭代器，由路由包装为 SSE。
        """
        pending = _PENDING.get(account_phone)
        fresh_events: list[dict[str, Any]] = []
        if pending is None:
            # 进程重启后内存 pending 丢失：从已落库的部分回合恢复。
            pending = self._recover_PendingApproval(account_phone, session_id)
            fresh_events = [
                _tool_confirm_event(pending, call) for call in pending.calls
            ]
        else:
            if pending.session_id != session_id:
                raise AuthError(ERROR_SESSION_NOT_FOUND, "会话不存在", 404)
            if pending.request_id != approval_request_id:
                raise AuthError(ERROR_TOOL_APPROVAL_REQUIRED, "存在未处理的工具确认请求", 409)

        record = self._turns.get_Turn(pending.turn_id)
        if record is None or record["session_id"] != pending.session_id:
            raise AuthError(ERROR_TURN_NOT_FOUND, "回合不存在", 404)
        messages = ModelMessagesTypeAdapter.validate_json(record["messages_json"])
        results = pending.requests.build_results(
            approvals={call.tool_call_id: approved for call in pending.calls}
        )

        # 校验通过后再写入共享 pending（恢复路径；内存路径幂等覆盖）。
        _PENDING[account_phone] = pending
        return self._resume_Approval(
            account_phone, pending, messages, results, fresh_events
        )

    def _recover_PendingApproval(
        self, account_phone: str, session_id: str
    ) -> PendingApproval:
        """从该会话已落库回合中恢复 pending；找不到可恢复调用 → approval_not_found。"""
        record = self._sessions.get_Session(session_id)
        if record is None or record["account_phone"] != account_phone:
            raise AuthError(ERROR_SESSION_NOT_FOUND, "会话不存在", 404)

        rows, _ = self._turns.list_Turns(session_id, None, _RECOVERY_SCAN_LIMIT)
        for row in rows:
            messages = ModelMessagesTypeAdapter.validate_json(row["messages_json"])
            requests = recover_PendingApprovals(messages)
            if requests is not None:
                return _make_PendingApproval(
                    account_phone, session_id, row["turn_id"], requests
                )
        raise AuthError(ERROR_APPROVAL_NOT_FOUND, "确认请求不存在或已处理", 404)

    async def _resume_Approval(
        self,
        account_phone: str,
        pending: PendingApproval,
        messages: list[Any],
        results: Any,
        fresh_events: list[dict[str, Any]],
    ) -> AsyncIterator[dict[str, Any]]:
        """加载部分回合后的续跑流：转发 text_delta → 整体覆盖落库 → done。"""
        lock = _LOCKS.get(account_phone)
        if lock is None:
            lock = asyncio.Lock()
            _LOCKS[account_phone] = lock
        if lock.locked():
            raise AuthError(ERROR_SESSION_BUSY, "已有回合在运行", 409)

        await lock.acquire()
        try:
            # 恢复路径：先把重新生成的 tool_confirm_request 发给前端，再续跑。
            for event in fresh_events:
                yield event

            try:
                agent = self._agent_factory(None)
                deps = BusinessToolDeps(account_phone, self._business_query)
                async with agent.run_stream_events(
                    None,
                    message_history=messages,
                    deferred_tool_results=results,
                    deps=deps,
                ) as run:
                    async for event in run:
                        if isinstance(event, PartDeltaEvent) and isinstance(
                            event.delta, TextPartDelta
                        ):
                            yield {
                                "type": "text_delta",
                                "content": event.delta.content_delta,
                            }

                # 成功后整体覆盖：all_messages 才是「本轮完整消息」。
                # 注意：续跑 run 的 new_messages_json 只含新增消息（工具回执+收尾文本），
                # 直接覆盖会丢原始 user prompt 与 tool_call（docs/spec/chat-agent.md §3.3）。
                self._turns.upsert_Turn(
                    pending.turn_id,
                    pending.session_id,
                    ModelMessagesTypeAdapter.dump_json(
                        run.result.all_messages()
                    ).decode(),
                )
                _PENDING.pop(account_phone, None)
                yield {"type": "done", "turn_id": pending.turn_id, "error": None}
            except ModelConfigError as exc:
                yield {
                    "type": "done",
                    "turn_id": pending.turn_id,
                    "error": {
                        "error_code": ERROR_MODEL_CONFIG_MISSING,
                        "message": str(exc),
                    },
                }
            except Exception as exc:  # noqa: BLE001 - 模型调用失败统一映射
                # 保留 pending：允许前端用同一 request_id 重发 approve。
                yield {
                    "type": "done",
                    "turn_id": pending.turn_id,
                    "error": {
                        "error_code": ERROR_MODEL_CALL_FAILED,
                        "message": str(exc),
                    },
                }
        finally:
            lock.release()
