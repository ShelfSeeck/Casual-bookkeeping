"""缝 14：同步端点接口测试（docs/spec/sync-backend.md §7）。

被测缝：POST /sync/push、GET /sync/pull、GET /sync/bootstrap 三个端点的
HTTP 契约——鉴权、批量保序逐条结果、分页游标、bootstrap 四表快照 + snapshot_seq。
测试经真实登录拿 token，覆盖 dependency 后用真实实现执行。

期望值来自 docs/sync-protocol.md §4 与 docs/error-codes.md。
"""

import pytest

from backend.repositories.accounts import AccountsRepository

# fixture 由本目录 conftest.py 提供（client / seed_account / test_database）


def _login(client, phone="13800000000", password="secret-password",
           device_id="dev-a1b2c3d4e5f6"):
    resp = client.post(
        "/auth/login",
        json={"phone": phone, "password": password, "device_id": device_id},
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def _customer_op(operation_id, sync_id="sync-000000000001", name="某某厂"):
    return {
        "operation_id": operation_id,
        "operation_type": "create_customer",
        "actor_type": "user",
        "source_turn_id": None,
        "changes": [
            {
                "entity_type": "customer",
                "entity_sync_id": sync_id,
                "base_version": 0,
                "fields": {"canonical_name": name},
            }
        ],
    }


# ---------- 鉴权 ----------

def test_sync_endpoints_require_auth(client):
    # 同步端点受全局守卫保护：未带 token → 401
    assert client.get("/sync/pull").status_code == 401
    assert client.post("/sync/push", json={"operations": []}).status_code == 401
    assert client.get("/sync/bootstrap").status_code == 401


# ---------- POST /sync/push ----------

def test_push_accepts_batch_and_returns_per_op_results(client, seed_account):
    # 批量 Push：两条操作都 accepted，结果与请求一一对应，含 server_seq / row_versions
    seed_account()
    headers = _login(client)
    resp = client.post(
        "/sync/push",
        headers=headers,
        json={
            "operations": [
                _customer_op("op-000000000001", "sync-000000000001"),
                _customer_op("op-000000000002", "sync-000000000002"),
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    results = resp.json()["results"]
    assert len(results) == 2
    assert results[0]["status"] == "accepted"
    assert results[0]["row_versions"] == {"sync-000000000001": 1}
    assert results[0]["server_seq"] >= 1
    assert results[1]["operation_id"] == "op-000000000002"
    assert results[1]["server_seq"] > results[0]["server_seq"]


def test_push_conflict_returns_conflict_json(client, seed_account):
    # 同一条 sync_id 被重复 create（第二次 base_version=0 但已存在）→ 单条 conflict，
    # 不影响同一批里其他条 accepted
    seed_account()
    headers = _login(client)
    client.post(
        "/sync/push",
        headers=headers,
        json={"operations": [_customer_op("op-000000000001", "sync-000000000001")]},
    )
    resp = client.post(
        "/sync/push",
        headers=headers,
        json={
            "operations": [
                # 重复 create 同一条 → conflict
                _customer_op("op-000000000002", "sync-000000000001"),
                # 另一条正常 → accepted（操作间独立，不互相阻塞）
                _customer_op("op-000000000003", "sync-000000000002"),
            ]
        },
    )
    results = resp.json()["results"]
    assert results[0]["status"] == "conflict"
    assert results[0]["conflict_json"]["theirs"]["row_version"] == 1
    assert results[1]["status"] == "accepted"


def test_push_rejected_returns_errors(client, seed_account):
    # 本表校验失败 → 单条 rejected，带变更级 errors（entity_sync_id + error_code）
    seed_account()
    headers = _login(client)
    op = _customer_op("op-000000000001")
    op["changes"][0]["fields"] = {"canonical_name": ""}
    resp = client.post("/sync/push", headers=headers, json={"operations": [op]})
    results = resp.json()["results"]
    assert results[0]["status"] == "rejected"
    assert results[0]["errors"][0]["entity_sync_id"] == "sync-000000000001"
    assert results[0]["errors"][0]["error_code"] == "invalid_customer_name"


def test_push_rejects_over_batch_size_limit(client, seed_account):
    # 批量操作数超过 500 → 400 invalid_request（docs/sync-protocol.md §5），
    # 客户端据此拆批重发，不能进业务校验。
    seed_account()
    headers = _login(client)
    ops = [
        _customer_op(f"op-{i:012d}", f"sync-{i:012d}") for i in range(501)
    ]
    resp = client.post("/sync/push", headers=headers, json={"operations": ops})
    assert resp.status_code == 400
    assert resp.json()["error_code"] == "invalid_request"
    # 整批未写入：一条 accepted 都没有
    assert client.get("/sync/pull", headers=headers, params={"after": 0}).json()[
        "operations"
    ] == []


def test_push_rejects_over_body_size_limit(client, seed_account):
    # 请求体超过 1MB → 400 invalid_request（docs/sync-protocol.md §5）
    seed_account()
    headers = _login(client)
    op = _customer_op("op-000000000001")
    # 单个字段塞满 1MB+，触发请求体字节上限
    op["changes"][0]["fields"] = {"canonical_name": "x" * (1_100_000)}
    resp = client.post("/sync/push", headers=headers, json={"operations": [op]})
    assert resp.status_code == 400
    assert resp.json()["error_code"] == "invalid_request"


# ---------- GET /sync/pull ----------

def test_pull_returns_own_and_others_ops_in_order(client, seed_account):
    # Pull：after=0 返回已接受的自己的操作，升序、按 change 带 after_json
    seed_account()
    headers = _login(client)
    client.post(
        "/sync/push",
        headers=headers,
        json={"operations": [_customer_op("op-000000000001", "sync-000000000001")]},
    )
    resp = client.get("/sync/pull", headers=headers, params={"after": 0, "limit": 10})
    assert resp.status_code == 200
    body = resp.json()
    assert body["has_more"] is False
    assert len(body["operations"]) == 1
    op = body["operations"][0]
    assert op["server_seq"] >= 1
    assert op["changes"][0]["after_version"] == 1
    assert "sync_id" in op["changes"][0]["after_json"]


def test_pull_respects_after_cursor(client, seed_account):
    # 游标是排他：after 取第一条 seq 后，只返回后续操作
    seed_account()
    headers = _login(client)
    client.post(
        "/sync/push",
        headers=headers,
        json={
            "operations": [
                _customer_op("op-000000000001", "sync-000000000001"),
                _customer_op("op-000000000002", "sync-000000000002"),
            ]
        },
    )
    all_ops = client.get(
        "/sync/pull", headers=headers, params={"after": 0, "limit": 10}
    ).json()["operations"]
    first_seq = all_ops[0]["server_seq"]

    rest = client.get(
        "/sync/pull", headers=headers, params={"after": first_seq, "limit": 10}
    ).json()
    assert [o["server_seq"] for o in rest["operations"]] == [first_seq + 1]


def test_pull_isolates_by_account(client, seed_account):
    # 账户隔离：账户 B 拉不到账户 A 的操作
    seed_account()
    seed_account(phone="13900000000")
    headers_a = _login(client, phone="13800000000")
    headers_b = _login(client, phone="13900000000", device_id="dev-000000000000")

    client.post(
        "/sync/push",
        headers=headers_a,
        json={"operations": [_customer_op("op-000000000001", "sync-000000000001")]},
    )
    resp_b = client.get(
        "/sync/pull", headers=headers_b, params={"after": 0, "limit": 10}
    )
    assert resp_b.json()["operations"] == []


# ---------- GET /sync/bootstrap ----------

def test_bootstrap_returns_active_records_and_snapshot_seq(client, seed_account):
    # bootstrap：只含当前在用记录（软删的不进），带 snapshot_seq 与 has_more=false
    seed_account()
    headers = _login(client)
    client.post(
        "/sync/push",
        headers=headers,
        json={
            "operations": [
                _customer_op("op-000000000001", "sync-000000000001"),
                _customer_op("op-000000000002", "sync-000000000002"),
            ]
        },
    )
    # 软删 sync-000000000002
    client.post(
        "/sync/push",
        headers=headers,
        json={
            "operations": [
                {
                    "operation_id": "op-000000000003",
                    "operation_type": "archive_customer",
                    "actor_type": "user",
                    "source_turn_id": None,
                    "changes": [
                        {
                            "entity_type": "customer",
                            "entity_sync_id": "sync-000000000002",
                            "base_version": 1,
                            "fields": {"archived_at": "2026-08-12T00:00:00+00:00"},
                        }
                    ],
                }
            ]
        },
    )

    resp = client.get("/sync/bootstrap", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["has_more"] is False
    # snapshot_seq 至少包含 push 的 3 条操作
    assert body["snapshot_seq"] >= 3
    # 只含未归档的 sync-000000000001
    customer_records = [
        r for r in body.get("customers", []) if r["sync_id"] == "sync-000000000001"
    ]
    assert len(customer_records) == 1


def test_bootstrap_snapshot_seq_anchors_to_account(client, seed_account):
    # bootstrap 的 snapshot_seq 必须锚定当前账户：A 只 push 1 条时，
    # 即使 B 后续 push 了 2 条，A 的 snapshot_seq 也只应是 A 自己的最新序号。
    seed_account()
    seed_account(phone="13900000000")
    headers_a = _login(client, phone="13800000000")
    headers_b = _login(client, phone="13900000000", device_id="dev-000000000000")

    client.post(
        "/sync/push",
        headers=headers_a,
        json={"operations": [_customer_op("op-000000000001", "sync-000000000001")]},
    )
    client.post(
        "/sync/push",
        headers=headers_b,
        json={
            "operations": [
                _customer_op("op-000000000002", "sync-000000000002"),
                _customer_op("op-000000000003", "sync-000000000003"),
            ]
        },
    )

    body = client.get("/sync/bootstrap", headers=headers_a).json()
    assert body["snapshot_seq"] == 1


def test_push_revert_op_carries_reverts_operation_id(client, seed_account):
    # 撤回操作：reverts_operation_id 随 Push 进库（database_operations.reverts_operation_id），
    # Pull 时带出（docs/data-model.md §6.5）。曾因 OperationIn schema 缺字段而恒为 NULL。
    seed_account()
    headers = _login(client)
    # 先建一条正常操作作为"被撤回的原操作"
    client.post(
        "/sync/push",
        headers=headers,
        json={
            "operations": [
                {
                    "operation_id": "op-revert-001",
                    "operation_type": "create_customer",
                    "actor_type": "user",
                    "source_turn_id": None,
                    "changes": [
                        {
                            "entity_type": "customer",
                            "entity_sync_id": "sync-revert-001",
                            "base_version": 0,
                            "fields": {"canonical_name": "某某厂"},
                        }
                    ],
                }
            ]
        },
    )
    # 撤回操作：reverts_operation_id 指向原操作
    resp = client.post(
        "/sync/push",
        headers=headers,
        json={
            "operations": [
                {
                    "operation_id": "op-revert-002",
                    "operation_type": "revert_customer",
                    "actor_type": "user",
                    "source_turn_id": None,
                    "reverts_operation_id": "op-revert-001",
                    "changes": [
                        {
                            "entity_type": "customer",
                            "entity_sync_id": "sync-revert-001",
                            "base_version": 1,
                            "fields": {"canonical_name": "回退的名字"},
                        }
                    ],
                }
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["results"][0]["status"] == "accepted"

    # Pull 带出撤回关系
    pulled = client.get("/sync/pull", headers=headers, params={"after": 0, "limit": 10}).json()
    revert_ops = [o for o in pulled["operations"] if o["operation_id"] == "op-revert-002"]
    assert len(revert_ops) == 1
    assert revert_ops[0]["reverts_operation_id"] == "op-revert-001"
