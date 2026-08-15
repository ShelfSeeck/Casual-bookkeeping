"""缝 11：ChatService 的公开行为（docs/spec/chat-agent.md §9/§10、docs/spec/agent-tools.md §5）。

被测缝：
- ChatService.run_Turn 的 send 模式 —— 归属校验、单飞锁、流式事件转发、回合落库、
  异常映射（done.error），以及写草案工具暂停时的 tool_confirm_request 握手。
- ChatService.approve_Turn 的 approve 模式 —— 加载部分回合 → 续跑 → 收尾落库 → 清除
  pending；拒绝（approved=False）与未知/过期 request_id 的错误码。
- 模块级共享状态 _LOCKS / _PENDING、recover_PendingApprovals 的恢复路径。

验证什么、为什么：
- 写草案暂停时 run.result.output 必须是 DeferredToolRequests（用 isinstance 判断），
  只有 approvals 非空才算待确认；暂停时只落部分回合、只发 tool_confirm_request、
  不发 done（docs/spec/agent-tools.md §5.2）。
- approve true/false 都要续跑收尾，区别是工具执行与否（后端工具永不落库）；
  成功后 pending 清除、回合整体覆盖（docs/spec/chat-agent.md §3.3）。
- _LOCKS / _PENDING 是进程级共享状态，测试必须用 autouse fixture 在每个测试
  前后调用 reset_SharedState()，否则上一个测试的 pending/锁会污染下一个测试。
"""

import asyncio
import json
from typing import Any

import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import (
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    PartDeltaEvent,
    TextPart,
    TextPartDelta,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import DeferredToolRequests

from backend.errors import AppError
from backend.repositories.chat_sessions import ChatSessionsRepository
from backend.repositories.chat_turns import ChatTurnsRepository
from backend.services import chat as chat_module
from backend.services.chat import (
    ChatService,
    PendingApproval,
    PendingCall,
    recover_PendingApprovals,
    reset_SharedState,
)


@pytest.fixture(autouse=True)
def _reset_shared_state():
    # 进程级共享状态：每个测试前后清空，避免跨测试污染（见文件头说明）。
    reset_SharedState()
    yield
    reset_SharedState()


def _test_agent_factory(allowed_tools: list[str] | None = None) -> Agent:
    # 用 TestModel 构建可运行的 Agent，避免真实模型调用（与 test_agent.py 同法）。
    # deps_type=object：ChatService 现在会传 BusinessToolDeps，测试 agent 不关心具体类型。
    return Agent(TestModel(), name="test", deps_type=object)


# ---------- FakeAgent / FakeRun 测试缝 ----------


def _text_delta(content: str) -> PartDeltaEvent:
    return PartDeltaEvent(index=0, delta=TextPartDelta(content_delta=content))


def _user_message(content: str) -> ModelRequest:
    return ModelRequest(parts=[UserPromptPart(content=content)])


def _assistant_message(content: str) -> ModelResponse:
    return ModelResponse(parts=[TextPart(content=content)])


def _tool_call(
    tool_name: str,
    args: dict[str, Any] | str,
    tool_call_id: str,
) -> ToolCallPart:
    return ToolCallPart(tool_name=tool_name, args=args, tool_call_id=tool_call_id)


class _FakeResult:
    """可配置的 run.result：output / all_messages / new_messages_json。"""

    def __init__(
        self,
        output: Any = None,
        messages: list[Any] | None = None,
        new_messages_json: bytes | None = None,
    ) -> None:
        self.output = output
        self._messages = list(messages or [])
        self._new_messages_json = (
            new_messages_json
            if new_messages_json is not None
            else ModelMessagesTypeAdapter.dump_json(self._messages)
        )

    def all_messages(self) -> list[Any]:
        return list(self._messages)

    def new_messages_json(self) -> bytes:
        return self._new_messages_json


class _FakeRun:
    """可配置事件序列的 run 上下文：__aiter__ 返回预置事件。"""

    def __init__(self, events: list[Any], result: _FakeResult) -> None:
        self._events = list(events)
        self.result = result

    async def __aenter__(self) -> "_FakeRun":
        return self

    async def __aexit__(self, *exc) -> bool:
        return False

    def __aiter__(self) -> "_FakeRun":
        return self

    async def __anext__(self):
        if not self._events:
            raise StopAsyncIteration
        return self._events.pop(0)


class _FakeAgent:
    """模拟三种 run：文本直出（send）、写草案暂停（send）、approve 续跑（resume）。"""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.executed: list[str] = []  # approved=True 时模拟执行握手工具
        self.denied: list[str] = []  # approved=False 时不执行，只记录拒绝
        self.send_events: list[Any] = []
        self.send_result: _FakeResult | None = None
        self.resume_events: list[Any] = []
        self.resume_result: _FakeResult | None = None

    def run_stream_events(
        self,
        user_prompt: str | None = None,
        *,
        message_history: list[Any] | None = None,
        deferred_tool_results: Any = None,
        deps: Any = None,
    ) -> _FakeRun:
        self.calls.append(
            {
                "user_prompt": user_prompt,
                "message_history": message_history,
                "deferred_tool_results": deferred_tool_results,
                "deps": deps,
            }
        )
        if deferred_tool_results is not None:
            # approve 续跑：approved=True 才模拟执行握手工具（只回执、不写库）；
            # False 只记录拒绝不执行 —— 对应 Pydantic AI 的 ToolApproved/ToolDenied 语义。
            for tool_call_id, approved in deferred_tool_results.approvals.items():
                if approved is True:
                    self.executed.append(tool_call_id)
                else:
                    self.denied.append(tool_call_id)
            assert self.resume_result is not None, "resume 场景需配置 resume_result"
            return _FakeRun(self.resume_events, self.resume_result)
        assert self.send_result is not None, "send 场景需配置 send_result"
        return _FakeRun(self.send_events, self.send_result)


class _BlockingFakeRun:
    """首事件即挂起，制造"回合运行中"；release 后正常结束。"""

    def __init__(self, release: asyncio.Event) -> None:
        self._release = release
        self._started = False
        self.result = _FakeResult(output="ok", messages=[])

    async def __aenter__(self) -> "_BlockingFakeRun":
        return self

    async def __aexit__(self, *exc) -> bool:
        return False

    def __aiter__(self) -> "_BlockingFakeRun":
        return self

    async def __anext__(self):
        if not self._started:
            self._started = True
            await self._release.wait()
            raise StopAsyncIteration
        raise StopAsyncIteration


class _BlockingFakeAgent:
    def __init__(self) -> None:
        self.release = asyncio.Event()

    def run_stream_events(
        self,
        user_prompt: str | None = None,
        *,
        message_history: list[Any] | None = None,
        deferred_tool_results: Any = None,
        deps: Any = None,
    ) -> _BlockingFakeRun:
        return _BlockingFakeRun(self.release)


def _pending_approval(
    account_phone: str = "13800000000",
    session_id: str = "s-1",
    turn_id: str = "turn-1",
    request_id: str = "ar-000000000000",
) -> PendingApproval:
    return PendingApproval(
        request_id=request_id,
        account_phone=account_phone,
        session_id=session_id,
        turn_id=turn_id,
        requests=DeferredToolRequests(approvals=[]),
        calls=[PendingCall(request_id=request_id, tool_call_id="call-1",
                           tool_name="update_work_order", args={})],
    )


# ---------- send 模式：文本直出 ----------


@pytest.mark.asyncio
async def test_run_Turn_streams_and_persists_turn(connection):
    # 发消息：事件以 text_delta 开头、以 done(error=None) 结尾，回合落库。
    # 沿用 TestModel 固定输出（真实 Agent + deps_type=object 兼容 BusinessToolDeps）。
    sessions = ChatSessionsRepository(connection)
    turns = ChatTurnsRepository(connection)
    sessions.create_Session("13800000000", "s-1", "标题")

    service = ChatService(sessions, turns, agent_factory=_test_agent_factory)
    events = [
        event
        async for event in service.run_Turn("13800000000", "s-1", "turn-1", "你好")
    ]

    assert events[0]["type"] == "text_delta"
    assert events[-1] == {"type": "done", "turn_id": "turn-1", "error": None}
    assert turns.get_Turn("turn-1") is not None


@pytest.mark.asyncio
async def test_run_Turn_passes_deps_and_allowed_tools_to_agent_factory(connection):
    # send 模式：allowed_tools 透传给 agent_factory；deps 为 BusinessToolDeps 且账户正确。
    sessions = ChatSessionsRepository(connection)
    turns = ChatTurnsRepository(connection)
    sessions.create_Session("13800000000", "s-1", "标题")

    messages = [_user_message("你好"), _assistant_message("你好呀")]
    fake = _FakeAgent()
    fake.send_events = [_text_delta("你好呀")]
    fake.send_result = _FakeResult(output="你好呀", messages=messages)
    seen_allowed: list[Any] = []

    def agent_factory(allowed_tools: list[str] | None = None) -> _FakeAgent:
        seen_allowed.append(allowed_tools)
        return fake

    service = ChatService(sessions, turns, agent_factory=agent_factory)
    events = [
        event
        async for event in service.run_Turn(
            "13800000000", "s-1", "turn-1", "你好",
            allowed_tools=["query_work_orders"],
        )
    ]

    assert seen_allowed == [["query_work_orders"]]
    assert events[0] == {"type": "text_delta", "content": "你好呀"}
    assert events[-1] == {"type": "done", "turn_id": "turn-1", "error": None}
    assert fake.calls[0]["user_prompt"] == "你好"
    assert fake.calls[0]["deps"].account_phone == "13800000000"
    assert fake.calls[0]["deps"].query is None
    assert turns.get_Turn("turn-1")["messages_json"] == (
        ModelMessagesTypeAdapter.dump_json(messages).decode()
    )


@pytest.mark.asyncio
async def test_run_Turn_rejects_foreign_session(connection):
    # 会话属于另一账户 → session_not_found，不泄漏存在性
    sessions = ChatSessionsRepository(connection)
    turns = ChatTurnsRepository(connection)
    sessions.create_Session("13800000000", "s-1", "标题")

    service = ChatService(sessions, turns, agent_factory=_test_agent_factory)
    with pytest.raises(AppError) as exc:
        async for _ in service.run_Turn("13900000000", "s-1", "turn-1", "你好"):
            pass
    assert exc.value.error_code == "session_not_found"


@pytest.mark.asyncio
async def test_run_Turn_rejects_missing_session(connection):
    # 会话不存在 → session_not_found
    sessions = ChatSessionsRepository(connection)
    turns = ChatTurnsRepository(connection)

    service = ChatService(sessions, turns, agent_factory=_test_agent_factory)
    with pytest.raises(AppError) as exc:
        async for _ in service.run_Turn("13800000000", "nope", "turn-1", "你好"):
            pass
    assert exc.value.error_code == "session_not_found"


@pytest.mark.asyncio
async def test_run_Turn_rejects_concurrent_turn_same_account(connection):
    # 单飞锁：同账户第一个回合运行中，第二个回合 → session_busy
    sessions = ChatSessionsRepository(connection)
    turns = ChatTurnsRepository(connection)
    sessions.create_Session("13800000000", "s-1", "标题")

    fake = _BlockingFakeAgent()
    service = ChatService(sessions, turns, agent_factory=lambda allowed_tools=None: fake)

    async def consume(agen):
        return [event async for event in agen]

    first = service.run_Turn("13800000000", "s-1", "turn-1", "你好")
    task = asyncio.create_task(consume(first))
    # 让第一个回合先拿到锁并在首事件挂起，锁进入"已占用"状态
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    with pytest.raises(AppError) as exc:
        async for _ in service.run_Turn("13800000000", "s-1", "turn-2", "你好"):
            pass
    assert exc.value.error_code == "session_busy"

    # 清理：释放挂起事件，让第一个回合正常收尾并释放锁
    fake.release.set()
    await task


# ---------- send 模式：写草案暂停（tool_confirm_request） ----------


@pytest.mark.asyncio
async def test_run_Turn_pauses_on_approval_requests(connection):
    # 写草案暂停：事件序列 text_delta → tool_confirm_request（draft=解析后的参数）、
    # 无 done；chat_turns 有部分落库；_PENDING 有值。
    sessions = ChatSessionsRepository(connection)
    turns = ChatTurnsRepository(connection)
    sessions.create_Session("13800000000", "s-1", "标题")

    draft = {
        "entity_sync_id": "sync-wo-1",
        "base_version": 4,
        "fields": {"quantity": 12},
    }
    tool_call = _tool_call(
        "update_work_order",
        json.dumps(draft, ensure_ascii=False),  # args 为 str，服务层需 json.loads
        "call-1",
    )
    requests = DeferredToolRequests(approvals=[tool_call])
    pause_messages = [_user_message("把 sync-wo-1 的数量改成 12"), ModelResponse(parts=[tool_call])]

    fake = _FakeAgent()
    fake.send_events = [_text_delta("我来生成修改草案")]
    fake.send_result = _FakeResult(output=requests, messages=pause_messages)
    service = ChatService(sessions, turns, agent_factory=lambda allowed_tools=None: fake)

    events = [
        event
        async for event in service.run_Turn(
            "13800000000", "s-1", "turn-1", "把 sync-wo-1 的数量改成 12"
        )
    ]

    assert events[0] == {"type": "text_delta", "content": "我来生成修改草案"}
    assert len(events) == 2  # 没有 done：回合暂停，等待确认
    confirm = events[1]
    assert confirm["type"] == "tool_confirm_request"
    assert confirm["request_id"].startswith("ar-")
    assert confirm["tool_call_id"] == "call-1"
    assert confirm["tool_name"] == "update_work_order"
    assert confirm["draft"] == draft

    pending = chat_module._PENDING.get("13800000000")
    assert pending is not None
    assert pending.session_id == "s-1"
    assert pending.turn_id == "turn-1"
    assert pending.request_id == confirm["request_id"]
    assert pending.calls == [
        PendingCall(
            request_id=confirm["request_id"],
            tool_call_id="call-1",
            tool_name="update_work_order",
            args=draft,
        )
    ]

    stored = turns.get_Turn("turn-1")
    assert stored is not None
    assert stored["messages_json"] == ModelMessagesTypeAdapter.dump_json(pause_messages).decode()


@pytest.mark.asyncio
async def test_run_Turn_treats_empty_deferred_requests_as_normal_finish(connection):
    # DeferredToolRequests 但 approvals 为空 → 按正常完成处理：落库 + done（不暂停）。
    sessions = ChatSessionsRepository(connection)
    turns = ChatTurnsRepository(connection)
    sessions.create_Session("13800000000", "s-1", "标题")

    messages = [_user_message("你好"), _assistant_message("你好呀")]
    fake = _FakeAgent()
    fake.send_events = [_text_delta("你好呀")]
    fake.send_result = _FakeResult(
        output=DeferredToolRequests(approvals=[]),
        messages=messages,
    )
    service = ChatService(sessions, turns, agent_factory=lambda allowed_tools=None: fake)

    events = [
        event
        async for event in service.run_Turn("13800000000", "s-1", "turn-1", "你好")
    ]

    assert events[0] == {"type": "text_delta", "content": "你好呀"}
    assert events[-1] == {"type": "done", "turn_id": "turn-1", "error": None}
    assert "13800000000" not in chat_module._PENDING
    assert turns.get_Turn("turn-1") is not None


# ---------- send 模式：pending 前置校验 ----------


@pytest.mark.asyncio
async def test_run_Turn_with_pending_raises_tool_approval_required(connection):
    # 该账户存在未处理确认时，新 send 必须先处理确认 → tool_approval_required 409
    # （该检查先于锁检查，语义准确，docs/spec/agent-tools.md §5.2 step 2）。
    sessions = ChatSessionsRepository(connection)
    turns = ChatTurnsRepository(connection)
    sessions.create_Session("13800000000", "s-1", "标题")

    chat_module._PENDING["13800000000"] = _pending_approval()
    service = ChatService(sessions, turns, agent_factory=_test_agent_factory)

    with pytest.raises(AppError) as exc:
        async for _ in service.run_Turn("13800000000", "s-1", "turn-2", "新消息"):
            pass
    assert exc.value.error_code == "tool_approval_required"


# ---------- approve 模式 ----------


@pytest.mark.asyncio
async def test_approve_Turn_true_resumes_and_clears_pending(connection):
    # approve true：加载部分回合 → 续跑 → text_delta + done(error=None)、
    # 最终回合整体覆盖、pending 清除、fake 工具执行且业务表无写入。
    sessions = ChatSessionsRepository(connection)
    turns = ChatTurnsRepository(connection)
    sessions.create_Session("13800000000", "s-1", "标题")

    draft = {"entity_sync_id": "sync-wo-1", "base_version": 4, "fields": {"quantity": 12}}
    tool_call = _tool_call("update_work_order", draft, "call-1")
    requests = DeferredToolRequests(approvals=[tool_call])
    pause_messages = [_user_message("把数量改成 12"), ModelResponse(parts=[tool_call])]
    final_messages = pause_messages + [_assistant_message("已确认，请前端提交后同步。")]

    fake = _FakeAgent()
    fake.send_events = [_text_delta("我来生成修改草案")]
    fake.send_result = _FakeResult(output=requests, messages=pause_messages)
    fake.resume_events = [_text_delta("已确认，请前端提交后同步。")]
    fake.resume_result = _FakeResult(output="已确认", messages=final_messages)
    service = ChatService(sessions, turns, agent_factory=lambda allowed_tools=None: fake)

    send_events = [
        event
        async for event in service.run_Turn(
            "13800000000", "s-1", "turn-1", "把数量改成 12"
        )
    ]
    request_id = send_events[1]["request_id"]

    approve_events = [
        event
        async for event in service.approve_Turn(
            "13800000000", "s-1", request_id, True
        )
    ]

    assert approve_events[0] == {"type": "text_delta", "content": "已确认，请前端提交后同步。"}
    assert approve_events[-1] == {"type": "done", "turn_id": "turn-1", "error": None}
    assert fake.executed == ["call-1"]
    assert fake.denied == []
    assert "13800000000" not in chat_module._PENDING
    stored = turns.get_Turn("turn-1")
    assert stored["messages_json"] == ModelMessagesTypeAdapter.dump_json(final_messages).decode()
    # 后端工具永不落库：业务表无写入
    assert connection.execute("SELECT COUNT(*) FROM work_orders").fetchone()[0] == 0


@pytest.mark.asyncio
async def test_approve_Turn_false_denies_tool_and_finishes(connection):
    # approve false：同样收尾（done），但 fake 工具不被执行。
    sessions = ChatSessionsRepository(connection)
    turns = ChatTurnsRepository(connection)
    sessions.create_Session("13800000000", "s-1", "标题")

    tool_call = _tool_call("update_work_order", {"entity_sync_id": "sync-wo-1", "base_version": 4, "fields": {}}, "call-1")
    requests = DeferredToolRequests(approvals=[tool_call])
    pause_messages = [_user_message("改单"), ModelResponse(parts=[tool_call])]
    final_messages = pause_messages + [_assistant_message("好的，已取消该草案。")]

    fake = _FakeAgent()
    fake.send_events = [_text_delta("我来生成修改草案")]
    fake.send_result = _FakeResult(output=requests, messages=pause_messages)
    fake.resume_events = [_text_delta("好的，已取消该草案。")]
    fake.resume_result = _FakeResult(output="已取消", messages=final_messages)
    service = ChatService(sessions, turns, agent_factory=lambda allowed_tools=None: fake)

    send_events = [
        event
        async for event in service.run_Turn("13800000000", "s-1", "turn-1", "改单")
    ]
    request_id = send_events[1]["request_id"]

    approve_events = [
        event
        async for event in service.approve_Turn(
            "13800000000", "s-1", request_id, False
        )
    ]

    assert approve_events[-1] == {"type": "done", "turn_id": "turn-1", "error": None}
    assert fake.executed == []
    assert fake.denied == ["call-1"]
    assert "13800000000" not in chat_module._PENDING


@pytest.mark.asyncio
async def test_approve_Turn_unknown_request_raises_approval_not_found(connection):
    # 无 pending、也无部分回合可恢复 → approval_not_found 404
    sessions = ChatSessionsRepository(connection)
    turns = ChatTurnsRepository(connection)
    sessions.create_Session("13800000000", "s-1", "标题")

    service = ChatService(sessions, turns, agent_factory=_test_agent_factory)
    with pytest.raises(AppError) as exc:
        service.approve_Turn("13800000000", "s-1", "ar-000000000000", True)
    assert exc.value.error_code == "approval_not_found"


@pytest.mark.asyncio
async def test_approve_Turn_wrong_request_id_raises_tool_approval_required(connection):
    # pending 存在但 request_id 不是最新未处理请求 → tool_approval_required 409
    sessions = ChatSessionsRepository(connection)
    turns = ChatTurnsRepository(connection)
    sessions.create_Session("13800000000", "s-1", "标题")

    chat_module._PENDING["13800000000"] = _pending_approval(request_id="ar-old")
    service = ChatService(sessions, turns, agent_factory=_test_agent_factory)

    with pytest.raises(AppError) as exc:
        service.approve_Turn("13800000000", "s-1", "ar-new", True)
    assert exc.value.error_code == "tool_approval_required"


@pytest.mark.asyncio
async def test_approve_Turn_wrong_session_raises_session_not_found(connection):
    # approve 前用 pending.session_id 做归属校验：与路径 sid 不一致 → session_not_found
    sessions = ChatSessionsRepository(connection)
    turns = ChatTurnsRepository(connection)
    sessions.create_Session("13800000000", "s-1", "标题")
    sessions.create_Session("13800000000", "s-2", "另一个会话")

    pending = _pending_approval(session_id="s-2")
    chat_module._PENDING["13800000000"] = pending
    service = ChatService(sessions, turns, agent_factory=_test_agent_factory)

    with pytest.raises(AppError) as exc:
        service.approve_Turn("13800000000", "s-1", pending.request_id, True)
    assert exc.value.error_code == "session_not_found"


@pytest.mark.asyncio
async def test_approve_Turn_missing_partial_turn_raises_turn_not_found(connection):
    # pending 在内存，但对应部分回合记录不存在 → turn_not_found 404（§5.3 step 3）。
    sessions = ChatSessionsRepository(connection)
    turns = ChatTurnsRepository(connection)
    sessions.create_Session("13800000000", "s-1", "标题")

    pending = _pending_approval(turn_id="turn-gone")
    chat_module._PENDING["13800000000"] = pending
    service = ChatService(sessions, turns, agent_factory=_test_agent_factory)

    with pytest.raises(AppError) as exc:
        service.approve_Turn("13800000000", "s-1", pending.request_id, True)
    assert exc.value.error_code == "turn_not_found"


# ---------- 进程重启后的恢复 ----------


def test_recover_PendingApprovals_finds_unreturned_approval_tool_call():
    # 直接从消息历史还原：只取「无回执」且注册表 requires_approval 的 ToolCallPart。
    tool_call = _tool_call(
        "update_work_order",
        {"entity_sync_id": "sync-wo-1", "base_version": 4, "fields": {"quantity": 12}},
        "call-1",
    )
    messages = [_user_message("改单"), ModelResponse(parts=[tool_call])]

    requests = recover_PendingApprovals(messages)

    assert requests is not None
    assert len(requests.approvals) == 1
    assert requests.approvals[0].tool_name == "update_work_order"
    assert requests.approvals[0].tool_call_id == "call-1"


def test_recover_PendingApprovals_ignores_returned_and_non_approval_calls():
    # 「无回执」与「requires_approval」两个条件必须同时满足才恢复：
    # 已回执的写工具调用不算待确认；未回执的读工具调用也不恢复。
    approval_call = _tool_call(
        "update_work_order",
        {"entity_sync_id": "sync-wo-1", "base_version": 4, "fields": {"quantity": 12}},
        "call-approved",
    )
    returned = ToolReturnPart(
        tool_name="update_work_order",
        content={"status": "draft_acknowledged"},
        tool_call_id="call-approved",
    )
    read_call = _tool_call("query_work_orders", {"limit": 10}, "call-read")
    messages = [
        _user_message("改单并查单"),
        ModelResponse(parts=[approval_call, read_call]),
        ModelRequest(parts=[returned]),
    ]

    assert recover_PendingApprovals(messages) is None


@pytest.mark.asyncio
async def test_approve_Turn_recovers_from_stored_partial_turn(connection):
    # 模拟进程重启：_PENDING 丢失，但部分回合已落库。
    # approve 时从 messages_json 还原 pending、重新生成 request_id 并发新的
    # tool_confirm_request，随后续跑收尾。
    sessions = ChatSessionsRepository(connection)
    turns = ChatTurnsRepository(connection)
    sessions.create_Session("13800000000", "s-1", "标题")

    draft = {"entity_sync_id": "sync-wo-1", "base_version": 4, "fields": {"quantity": 12}}
    tool_call = _tool_call("update_work_order", draft, "call-1")
    partial_messages = [_user_message("把数量改成 12"), ModelResponse(parts=[tool_call])]
    turns.upsert_Turn(
        "turn-1",
        "s-1",
        ModelMessagesTypeAdapter.dump_json(partial_messages).decode(),
    )

    final_messages = partial_messages + [_assistant_message("已确认，请前端提交后同步。")]
    fake = _FakeAgent()
    fake.resume_events = [_text_delta("已确认，请前端提交后同步。")]
    fake.resume_result = _FakeResult(output="已确认", messages=final_messages)
    service = ChatService(sessions, turns, agent_factory=lambda allowed_tools=None: fake)

    approve_events = [
        event
        async for event in service.approve_Turn(
            "13800000000", "s-1", "ar-old", True
        )
    ]

    assert approve_events[0]["type"] == "tool_confirm_request"
    assert approve_events[0]["request_id"].startswith("ar-")
    assert approve_events[0]["tool_call_id"] == "call-1"
    assert approve_events[0]["tool_name"] == "update_work_order"
    assert approve_events[0]["draft"] == draft
    assert approve_events[-1] == {"type": "done", "turn_id": "turn-1", "error": None}
    assert fake.executed == ["call-1"]
    assert fake.denied == []
    assert "13800000000" not in chat_module._PENDING
    stored = turns.get_Turn("turn-1")
    assert stored["messages_json"] == ModelMessagesTypeAdapter.dump_json(final_messages).decode()


# ---------- 共享状态复位 ----------


def test_reset_SharedState_clears_locks_and_pending():
    # 测试缝：清空进程级共享状态，避免串测试。
    chat_module._LOCKS["13800000000"] = asyncio.Lock()
    chat_module._PENDING["13800000000"] = _pending_approval()

    reset_SharedState()

    assert chat_module._LOCKS == {}
    assert chat_module._PENDING == {}
