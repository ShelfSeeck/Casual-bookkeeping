"""chat 端点接口测试（docs/spec/chat-agent.md §4）。

被测缝：4 个聊天端点 + 模型诊断端点的 HTTP 契约——鉴权、会话创建/列表、
回合 SSE 流式、回合历史摊平、归属校验（404 不泄露存在性）。
ChatService 用 TestModel 固定输出（见 conftest.py），不走真实模型。
"""


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

    body = client.get("/chat/sessions", headers=headers).json()
    assert len(body["sessions"]) == 1
    assert body["sessions"][0]["session_id"] == created["session_id"]
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
