"""缝 7：认证端点接口测试（docs/auth-structure.md §3.4 全部 B 层用例）。

通过 TestClient 走真实 HTTP 链路：登录/刷新/登出/鉴权守卫/防刷/踢出/停用，
token 与 cookie 全部由真实端点产生，业务逻辑不做任何 mock。
"""

import pytest

from backend.repositories.account_devices import AccountDevicesRepository
from backend.repositories.accounts import AccountsRepository

ACCESS_TTL = 24 * 3600
REFRESH_TTL = 180 * 24 * 3600
PASSWORD = "secret-password"


# ---------- 内部工具 ----------

def _revoke_device(test_database, phone: str, device_id: str) -> None:
    conn = test_database.connect()
    try:
        AccountDevicesRepository(conn).revoke_Device(phone, device_id)
        conn.commit()
    finally:
        conn.close()


def _set_account_status(test_database, phone: str, status: str) -> None:
    conn = test_database.connect()
    try:
        AccountsRepository(conn).set_AccountStatus(phone, status)
        conn.commit()
    finally:
        conn.close()


def _login(client, phone: str = "13800000000", password: str = PASSWORD,
           device_id: str = "dev-a1b2c3d4e5f6"):
    return client.post(
        "/auth/login",
        json={"phone": phone, "password": password, "device_id": device_id},
    )


def _auth_headers(access_token: str) -> dict:
    return {"Authorization": f"Bearer {access_token}"}


# ---------- B1 / B11 登录 ----------

def test_login_success_sets_cookie_and_returns_access(client, seed_account):
    seed_account()
    resp = _login(client)

    assert resp.status_code == 200
    body = resp.json()
    assert body["access_token"]
    assert body["token_type"] == "Bearer"

    set_cookie = resp.headers.get("set-cookie", "").lower()
    assert "refresh_token" in set_cookie
    assert "httponly" in set_cookie


def test_login_with_unnormalized_phone(client, seed_account):
    # B11：带空格/+86 的手机号登录仍成功（应用层规范化，docs §2.2）
    seed_account()
    resp = _login(client, phone="+86 138 0000 0000")
    assert resp.status_code == 200

    ping = client.get("/protected/ping", headers=_auth_headers(resp.json()["access_token"]))
    assert ping.status_code == 200
    assert ping.json()["account_phone"] == "13800000000"


def test_login_wrong_password_returns_401(client, seed_account):
    # B2：密码错 → 401，不泄露账户是否存在
    seed_account()
    resp = _login(client, password="wrong-password")
    assert resp.status_code == 401
    assert resp.json()["error_code"] == "invalid_credentials"


def test_login_unknown_account_returns_401(client, seed_account):
    # 账户不存在与密码错返回同一错误（不泄露账户是否存在，docs §2.14）
    seed_account()
    resp = _login(client, phone="13900000000")
    assert resp.status_code == 401
    assert resp.json()["error_code"] == "invalid_credentials"


def test_login_disabled_account_returns_403(client, seed_account):
    # 停用账户无法登录（docs §2.14 403）
    seed_account(status="disabled")
    resp = _login(client)
    assert resp.status_code == 403
    assert resp.json()["error_code"] == "account_disabled"


# ---------- B3 防刷 ----------

def test_login_rate_limiting_locks_after_5_failures(client, seed_account):
    seed_account()
    for _ in range(5):
        resp = _login(client, password="wrong-password")
        assert resp.status_code == 401
        assert resp.json()["error_code"] == "invalid_credentials"

    # 第 6 次即使密码正确也被锁定（docs 用例 B3）
    resp = _login(client)
    assert resp.status_code == 401
    assert resp.json()["error_code"] == "login_blocked"


def test_rate_limiting_is_per_phone(client, seed_account):
    # 同一手机号锁定不影响其他手机号（docs §2.11）
    seed_account()
    for _ in range(5):
        _login(client, password="wrong-password")
    assert _login(client, password="wrong-password").status_code == 401

    seed_account(phone="13900000000")
    resp = _login(client, phone="13900000000")
    assert resp.status_code == 200


# ---------- B4-B6 刷新 ----------

def test_refresh_rolls_tokens(client, seed_account, clock):
    # B4：有效 refresh → 新 access + 新 refresh（滚动续期）
    seed_account()
    login_resp = _login(client)
    old_access = login_resp.json()["access_token"]
    old_cookie = client.cookies["refresh_token"]

    clock.ts += 60  # 时间前进：滚动续期应签发带新 exp 的 token
    resp = client.post("/auth/refresh")
    assert resp.status_code == 200
    new_access = resp.json()["access_token"]
    new_cookie = client.cookies["refresh_token"]

    assert new_access != old_access
    assert new_cookie != old_cookie


def test_refresh_rejects_revoked_device(client, seed_account, test_database):
    # B5：被踢出设备的 refresh → 拒绝
    seed_account()
    _login(client)
    cookie = client.cookies["refresh_token"]
    _revoke_device(test_database, "13800000000", "dev-a1b2c3d4e5f6")

    resp = client.post("/auth/refresh")
    assert resp.status_code == 403
    assert resp.json()["error_code"] == "session_revoked"


def test_refresh_rejects_expired_cookie(client, seed_account, clock):
    # B6：过期 refresh → 拒绝
    seed_account()
    _login(client)

    clock.ts += REFRESH_TTL + 1
    resp = client.post("/auth/refresh")
    assert resp.status_code == 401
    assert resp.json()["error_code"] == "invalid_token"


def test_refresh_missing_cookie_returns_401(client, seed_account):
    # 无 cookie 直接刷新 → 401
    seed_account()
    resp = client.post("/auth/refresh")
    assert resp.status_code == 401
    assert resp.json()["error_code"] == "invalid_token"


# ---------- B7 登出 ----------

def test_logout_revokes_session(client, seed_account):
    # B7：登出 → 会话删除 + cookie 清除，原 refresh 不能再刷新
    seed_account()
    _login(client)
    old_cookie = client.cookies["refresh_token"]

    resp = client.post("/auth/logout")
    assert resp.status_code == 204
    assert "refresh_token" not in client.cookies  # 服务端清掉了 cookie

    # 客户端若仍持有旧 refresh cookie，也无法再刷新（会话已吊销）
    client.cookies.set("refresh_token", old_cookie)
    resp = client.post("/auth/refresh")
    assert resp.status_code == 403
    assert resp.json()["error_code"] == "session_revoked"


# ---------- B8-B10 鉴权守卫 ----------

def test_unauthenticated_request_to_business_endpoint_returns_401(client, seed_account):
    # B8：未认证请求业务端点 → 401
    seed_account()
    resp = client.get("/protected/ping")
    assert resp.status_code == 401
    assert resp.json()["error_code"] == "invalid_token"


def test_expired_access_token_returns_401(client, seed_account, clock):
    # B9：access 过期 → 401
    seed_account()
    access = _login(client).json()["access_token"]

    clock.ts += ACCESS_TTL + 1
    resp = client.get("/protected/ping", headers=_auth_headers(access))
    assert resp.status_code == 401
    assert resp.json()["error_code"] == "invalid_token"


def test_disabled_account_session_invalid_immediately(client, seed_account, test_database):
    # B10：停用账户 → 已登录会话立即失效（含刷新）
    seed_account()
    access = _login(client).json()["access_token"]
    _set_account_status(test_database, "13800000000", "disabled")

    resp = client.get("/protected/ping", headers=_auth_headers(access))
    assert resp.status_code == 403

    resp = client.post("/auth/refresh")
    assert resp.status_code == 403


def test_revoked_device_access_rejected(client, seed_account, test_database):
    # 设备被踢后，已签发 access 在鉴权时被拒（docs §2.14 403）
    seed_account()
    access = _login(client).json()["access_token"]
    _revoke_device(test_database, "13800000000", "dev-a1b2c3d4e5f6")

    resp = client.get("/protected/ping", headers=_auth_headers(access))
    assert resp.status_code == 403
    assert resp.json()["error_code"] == "session_revoked"


def test_access_token_identity_injected(client, seed_account):
    # 鉴权依赖注入 account_phone + device_id（docs §2.14 第 6 步）
    seed_account()
    access = _login(client).json()["access_token"]

    resp = client.get("/protected/ping", headers=_auth_headers(access))
    assert resp.status_code == 200
    assert resp.json() == {"account_phone": "13800000000", "device_id": "dev-a1b2c3d4e5f6"}


# ---------- B12 多设备 ----------

def test_two_devices_have_independent_sessions(client, seed_account, test_database):
    # B12：同一账户两台设备 → 独立会话，踢掉一台不影响另一台
    seed_account()

    resp1 = _login(client, device_id="dev-a1b2c3d4e5f6")
    assert resp1.status_code == 200
    cookie1 = client.cookies["refresh_token"]

    resp2 = _login(client, device_id="dev-f0e1d2c3b4a5")
    assert resp2.status_code == 200
    cookie2 = client.cookies["refresh_token"]

    # 两台设备各自 access 都能通过鉴权
    ping1 = client.get("/protected/ping", headers=_auth_headers(resp1.json()["access_token"]))
    assert ping1.status_code == 200
    ping2 = client.get("/protected/ping", headers=_auth_headers(resp2.json()["access_token"]))
    assert ping2.status_code == 200

    # 登出设备 1（只吊销 dev-a1b2c3d4e5f6 会话）→ 设备 1 失效，设备 2 不受影响
    client.cookies.set("refresh_token", cookie1)
    assert client.post("/auth/logout").status_code == 204

    ping1 = client.get("/protected/ping", headers=_auth_headers(resp1.json()["access_token"]))
    assert ping1.status_code == 403
    ping2 = client.get("/protected/ping", headers=_auth_headers(resp2.json()["access_token"]))
    assert ping2.status_code == 200

    client.cookies.set("refresh_token", cookie2)
    assert client.post("/auth/refresh").status_code == 200
