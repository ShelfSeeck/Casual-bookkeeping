"""chat 端点接口测试（docs/spec/chat-agent.md §4、docs/spec/agent-tools.md §5.5）。

被测缝：4 个聊天端点 + 模型诊断端点的 HTTP 契约——鉴权、会话创建/列表、
回合 SSE 流式、回合历史摊平、归属校验（404 不泄露存在性）、POST /turns 的
send / approve 双模式校验（invalid_request 400 / invalid_approval 400 /
approval_not_found 404）。
ChatService 用 TestModel 固定输出（见 conftest.py），不走真实模型。
"""

import asyncio
import threading
import time

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import (
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.tools import DeferredToolRequests

from backend.main import app
from backend.repositories.chat_turns import ChatTurnsRepository
from backend.routers.chat import TurnRequest
from backend.services import chat as chat_module
from backend.services.chat import PendingApproval, PendingCall


def _login(client, phone="13800000000", password="secret-password",
           device_id="dev-a1b2c3d4e5f6"):
    resp = client.post(
        "/auth/login",
        json={"phone": phone, "password": password, "device_id": device_id},
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def _create_session(client, headers, title="7月对账"):
    resp = client.post("/chat/sessions", headers=headers, json={"title": title})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _pending_approval(
    session_id: str,
    account_phone: str = "13800000000",
    turn_id: str = "turn-000000000001",
    request_id: str = "ar-000000000000",
) -> PendingApproval:
    return PendingApproval(
        request_id=request_id,
        account_phone=account_phone,
        session_id=session_id,
        turn_id=turn_id,
        requests=DeferredToolRequests(approvals=[]),
        calls=[
            PendingCall(
                request_id=request_id,
                tool_call_id="call-1",
                tool_name="update_work_order",
                args={},
            )
        ],
    )


class _BusyRunResult:
    """给阻塞 fake run 的 result：release 后 run_Turn 正常收尾落库。"""

    output = "ok"

    def new_messages_json(self) -> bytes:
        return b"[]"


class _BusyRun:
    """首个事件前挂起，模拟"回合运行中"；release 后立即结束。"""

    def __init__(self, release: threading.Event) -> None:
        self._release = release
        self._started = False
        self.result = _BusyRunResult()

    async def __aenter__(self) -> "_BusyRun":
        return self

    async def __aexit__(self, *exc) -> bool:
        return False

    def __aiter__(self) -> "_BusyRun":
        return self

    async def __anext__(self):
        if not self._started:
            self._started = True
            # 用 threading.Event 配合 to_thread：主线程 set 即释放，跨线程安全。
            await asyncio.to_thread(self._release.wait)
            raise StopAsyncIteration
        raise StopAsyncIteration


class _BusyAgent:
    def __init__(self) -> None:
        self.release = threading.Event()

    def run_stream_events(
        self,
        user_prompt: str | None = None,
        *,
        message_history: list | None = None,
        deferred_tool_results=None,
        deps=None,
    ) -> _BusyRun:
        return _BusyRun(self.release)



def test_turn_request_accepts_per_call_approval_decisions():
    # 路由请求契约：一批确认按 tool_call_id 分别表达 approve/reject/regenerate。
    body = TurnRequest.model_validate(
        {
            "approval_request_id": "ar-1",
            "decisions": [
                {"tool_call_id": "call-1", "decision": "approve"},
                {
                    "tool_call_id": "call-2",
                    "decision": "regenerate",
                    "reason": "数量应为 12",
                },
            ],
        }
    )
    assert body.approval_request_id == "ar-1"
    assert [item.decision for item in body.decisions or []] == [
        "approve",
        "regenerate",
    ]
    assert not hasattr(body, "approved")


# ---------- 鉴权 ----------

def test_chat_endpoints_require_auth(client):
    # 聊天端点受全局守卫保护：未带 token → 401
    assert client.post("/chat/sessions", json={"title": "x"}).status_code == 401
    assert client.get("/chat/sessions").status_code == 401
    assert client.get("/chat/sessions/s-000000000000/turns").status_code == 401
    assert client.post(
        "/chat/sessions/s-000000000000/turns",
        json={"turn_id": "turn-1", "message": "hi"},
    ).status_code == 401
    assert client.get("/chat/model-config").status_code == 401


# ---------- 会话 ----------

def test_create_and_list_sessions(client, seed_account):
    # 创建会话返回 s- 前缀 session_id；列表含它，且不泄露 account_phone
    seed_account()
    headers = _login(client)
    created = _create_session(client, headers)
    assert created["session_id"].startswith("s-")
    assert created["title"] == "7月对账"
    assert created["created_at"]
    assert created["turn_count"] == 0

    body = client.get("/chat/sessions", headers=headers).json()
    assert len(body["sessions"]) == 1
    assert body["sessions"][0]["session_id"] == created["session_id"]
    assert body["sessions"][0]["turn_count"] == 0
    assert "account_phone" not in body["sessions"][0]


# ---------- 发消息（SSE）与回合历史 ----------

def test_send_turn_streams_sse_and_persists(client, seed_account):
    # 发消息 → SSE 流含 text_delta + done(error=null)；回合落库，历史可摊平拉取
    seed_account()
    headers = _login(client)
    sid = _create_session(client, headers)["session_id"]

    resp = client.post(
        f"/chat/sessions/{sid}/turns",
        headers=headers,
        json={"turn_id": "turn-000000000001", "message": "你好"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/event-stream")
    body = resp.text
    assert '"type": "text_delta"' in body
    assert '"type": "done"' in body
    assert '"error": null' in body

    turns = client.get(f"/chat/sessions/{sid}/turns", headers=headers).json()["turns"]
    assert len(turns) == 1
    assert turns[0]["turn_id"] == "turn-000000000001"
    assert turns[0]["messages"]
    assert turns[0]["messages"][0]["role"] in ("user", "assistant")


def test_list_turns_flattens_only_text_parts_for_tool_messages(
    client, seed_account, test_database
):
    # 含工具消息的回合（tool_call / tool_return）只摊平 user/assistant 文本段，
    # 不崩、不泄露 Pydantic AI 内部结构（docs/spec/agent-tools.md §5.5）。
    # 绕过 SSE 直接落一条含工具 part 的回合，避免依赖真实模型调工具。
    seed_account()
    headers = _login(client)
    sid = _create_session(client, headers)["session_id"]

    messages = [
        ModelRequest(parts=[UserPromptPart(content="把数量改成 12")]),
        ModelResponse(
            parts=[
                ToolCallPart(
                    tool_name="update_work_order",
                    args={
                        "entity_sync_id": "sync-wo-1",
                        "base_version": 4,
                        "fields": {"quantity": 12},
                    },
                    tool_call_id="call-1",
                )
            ]
        ),
        ModelRequest(
            parts=[
                ToolReturnPart(
                    tool_name="update_work_order",
                    content={"status": "draft_acknowledged"},
                    tool_call_id="call-1",
                )
            ]
        ),
        ModelResponse(parts=[TextPart(content="已确认，请前端提交后同步。")]),
    ]
    conn = test_database.connect()
    try:
        ChatTurnsRepository(conn).upsert_Turn(
            "turn-1",
            sid,
            ModelMessagesTypeAdapter.dump_json(messages).decode(),
        )
        conn.commit()
    finally:
        conn.close()

    resp = client.get(f"/chat/sessions/{sid}/turns", headers=headers)
    assert resp.status_code == 200, resp.text
    turns = resp.json()["turns"]
    assert len(turns) == 1
    assert turns[0]["messages"] == [
        {"role": "user", "content": "把数量改成 12", "type": "text"},
        {"role": "assistant", "content": "已确认，请前端提交后同步。", "type": "text"},
    ]


def test_send_turn_session_not_found(client, seed_account):
    # 会话不存在 → 404 session_not_found（流开始前统一 JSON 错误，spec §5）
    seed_account()
    headers = _login(client)
    resp = client.post(
        "/chat/sessions/s-000000000000/turns",
        headers=headers,
        json={"turn_id": "turn-1", "message": "hi"},
    )
    assert resp.status_code == 404
    assert resp.json()["error_code"] == "session_not_found"


def test_send_turn_isolates_by_account(client, seed_account):
    # 账户 B 访问账户 A 的会话 → 404（不泄露存在性）
    seed_account()
    seed_account(phone="13900000000")
    headers_a = _login(client, phone="13800000000")
    headers_b = _login(client, phone="13900000000", device_id="dev-000000000000")
    sid = _create_session(client, headers_a)["session_id"]

    resp = client.post(
        f"/chat/sessions/{sid}/turns",
        headers=headers_b,
        json={"turn_id": "turn-1", "message": "hi"},
    )
    assert resp.status_code == 404
    assert resp.json()["error_code"] == "session_not_found"


# ---------- POST /turns 双模式校验（send / approve） ----------

def test_send_turn_missing_fields_returns_invalid_request(client, seed_account):
    # send 模式（approval_request_id 为空）缺 turn_id/message → invalid_request 400
    seed_account()
    headers = _login(client)
    sid = _create_session(client, headers)["session_id"]

    resp = client.post(
        f"/chat/sessions/{sid}/turns",
        headers=headers,
        json={"turn_id": "turn-000000000001"},
    )
    assert resp.status_code == 400
    assert resp.json()["error_code"] == "invalid_request"


def test_send_turn_with_pending_returns_409_json_before_sse(client, seed_account):
    # send 模式 HTTP 契约：存在未处理工具确认时，POST /turns 必须在 SSE 流
    # 开始前返回非 200 JSON（tool_approval_required 409），不能先回 200
    # text/event-stream 再断流（docs/spec/agent-tools.md §5.2 step 2）。
    seed_account()
    headers = _login(client)
    sid = _create_session(client, headers)["session_id"]

    chat_module._PENDING["13800000000"] = _pending_approval(sid)

    resp = client.post(
        f"/chat/sessions/{sid}/turns",
        headers=headers,
        json={"turn_id": "turn-000000000002", "message": "新消息"},
    )
    assert resp.status_code == 409
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.json()["error_code"] == "tool_approval_required"
    # 没有任何 SSE 字节流过：body 是统一错误 JSON，而不是 event-stream 帧
    assert "text/event-stream" not in resp.headers["content-type"]
    assert '"type": "text_delta"' not in resp.text
    assert "data:" not in resp.text


def test_send_turn_when_busy_returns_409_json_before_sse(
    client, seed_account, chat_agent_factory
):
    # send 模式 HTTP 契约：同账户已有回合在跑时，第二个 POST /turns 必须在
    # SSE 流开始前返回 session_busy 409 JSON；用首事件前阻塞的 fake run 制造
    # 单飞锁占用（tests/services/test_chat.py 同款 seam，但走 HTTP）。
    seed_account()
    headers = _login(client)
    sid = _create_session(client, headers)["session_id"]

    busy = _BusyAgent()
    chat_agent_factory.factory = lambda allowed_tools=None: busy

    # 第二个 TestClient 用同一 app 与依赖覆盖，从独立 portal 并发发起请求；
    # 第一个请求占住 ChatService 单飞锁后，第二个请求应被 preflight 拦截。
    client2 = TestClient(app)
    first_result: dict = {}

    def _first_post() -> None:
        first_result["resp"] = client.post(
            f"/chat/sessions/{sid}/turns",
            headers=headers,
            json={"turn_id": "turn-000000000001", "message": "阻塞中的回合"},
        )

    thread = threading.Thread(target=_first_post)
    thread.start()
    try:
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            lock = chat_module._LOCKS.get("13800000000")
            if lock is not None and lock.locked():
                break
            time.sleep(0.01)
        else:
            pytest.fail("第一个回合未在超时前获取单飞锁")

        resp = client2.post(
            f"/chat/sessions/{sid}/turns",
            headers=headers,
            json={"turn_id": "turn-000000000002", "message": "并发消息"},
        )
        assert resp.status_code == 409
        assert resp.headers["content-type"].startswith("application/json")
        assert resp.json()["error_code"] == "session_busy"
        assert '"type": "text_delta"' not in resp.text
    finally:
        busy.release.set()
        thread.join(timeout=10)
        client2.close()

    assert first_result["resp"].status_code == 200
    assert thread.is_alive() is False


def test_approve_turn_missing_decisions_returns_invalid_approval(client, seed_account):
    # approve 模式缺 decisions 字段 → invalid_approval 400（流开始前统一 JSON）
    seed_account()
    headers = _login(client)
    sid = _create_session(client, headers)["session_id"]

    resp = client.post(
        f"/chat/sessions/{sid}/turns",
        headers=headers,
        json={"approval_request_id": "ar-000000000000"},
    )
    assert resp.status_code == 400
    assert resp.json()["error_code"] == "invalid_approval"


def test_approve_turn_unknown_request_returns_approval_not_found(client, seed_account):
    # 无 pending、无部分回合可恢复 → approval_not_found 404（流开始前统一 JSON）
    seed_account()
    headers = _login(client)
    sid = _create_session(client, headers)["session_id"]

    resp = client.post(
        f"/chat/sessions/{sid}/turns",
        headers=headers,
        json={
            "approval_request_id": "ar-000000000000",
            "decisions": [
                {"tool_call_id": "call-1", "decision": "approve"}
            ],
        },
    )
    assert resp.status_code == 404
    assert resp.json()["error_code"] == "approval_not_found"


def test_list_turns_session_not_found(client, seed_account):
    # 拉历史同样做归属校验 → 404
    seed_account()
    headers = _login(client)
    resp = client.get("/chat/sessions/s-000000000000/turns", headers=headers)
    assert resp.status_code == 404
    assert resp.json()["error_code"] == "session_not_found"


# ---------- 模型诊断 ----------

def test_model_config_endpoint(client, seed_account):
    # 只读诊断：读当前生效 [model] 配置；config.toml 有 [model] 则 200
    seed_account()
    headers = _login(client)
    resp = client.get("/chat/model-config", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["model_name"]
    assert body["base_url"]
    assert "api_key_configured" in body
