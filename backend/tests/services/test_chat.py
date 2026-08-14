"""缝 11：ChatService.run_Turn 的公开行为（docs/spec/chat-agent.md §9/§10）。

被测缝：ChatService.run_Turn 的 send 模式 —— 归属校验、单飞锁、流式事件转发、
回合落库、异常映射（done.error）。

验证什么、为什么：
- 发消息：事件序列以 text_delta 开头、以 done(error=None) 结尾，回合成功落库
  （落库用成功完成后的 new_messages_json，是 docs/ai-chat-storage.md §4 的规则）。
- 会话归属：会话不存在或不属于该账户 → session_not_found（不泄漏存在性）。
- 单飞锁：同账户并发第二个回合 → session_busy（按账户锁，跨会话）。
"""

import asyncio

import pytest
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel

from backend.errors import AppError
from backend.repositories.chat_sessions import ChatSessionsRepository
from backend.repositories.chat_turns import ChatTurnsRepository
from backend.services.chat import ChatService


def _test_agent_factory() -> Agent:
    # 用 TestModel 构建可运行的 Agent，避免真实模型调用（与 test_agent.py 同法）
    return Agent(TestModel(), name="test")


class _FakeResult:
    def new_messages_json(self) -> bytes:
        return b"[]"


class _FakeRun:
    # 首事件即挂起，制造"回合运行中"；release 后正常结束
    def __init__(self, release: asyncio.Event) -> None:
        self._release = release
        self._started = False
        self.result = _FakeResult()

    async def __aenter__(self) -> "_FakeRun":
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    def __aiter__(self) -> "_FakeRun":
        return self

    async def __anext__(self):
        if not self._started:
            self._started = True
            await self._release.wait()
            raise StopAsyncIteration
        raise StopAsyncIteration


class _FakeAgent:
    def __init__(self) -> None:
        self.release = asyncio.Event()

    def run_stream_events(self, message):
        return _FakeRun(self.release)


@pytest.mark.asyncio
async def test_run_Turn_streams_and_persists_turn(connection):
    # 发消息：事件以 text_delta 开头、以 done(error=None) 结尾，回合落库
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

    fake = _FakeAgent()
    service = ChatService(sessions, turns, agent_factory=lambda: fake)

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
