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


# ---------- 缝：撤回执行与 Pull 历史载荷 ----------

def _revert_op(operation_id, reverts_operation_id):
    """构造一条撤回操作：changes 为空数组，反向 changes 由服务端展开。"""
    return {
        "operation_id": operation_id,
        "operation_type": "revert_operation",
        "actor_type": "user",
        "source_turn_id": None,
        "reverts_operation_id": reverts_operation_id,
        "changes": [],
    }


def _work_order_fields(customer_id, **overrides):
    """工单 create 的合法字段；service_item 留空以跳过服务品类前置校验。"""
    fields = {
        "work_order_date": "2026-08-12",
        "customer_id": customer_id,
        "customer_code": "001",
        "customer_name": "某某厂",
        "service_category": "洗水",
        "service_item": None,
        "quantity": 12,
        "unit": "件",
    }
    fields.update(overrides)
    return fields


def _push_work_order(client, headers, *, operation_id, sync_id, customer_id,
                     base_version=0, fields=None):
    """Push 一条工单 create/update 并断言 accepted。"""
    if fields is None:
        fields = _work_order_fields(customer_id)
    resp = client.post(
        "/sync/push",
        headers=headers,
        json={
            "operations": [
                {
                    "operation_id": operation_id,
                    "operation_type": (
                        "create_work_order" if base_version == 0 else "update_work_order"
                    ),
                    "actor_type": "user",
                    "source_turn_id": None,
                    "changes": [
                        {
                            "entity_type": "work_order",
                            "entity_sync_id": sync_id,
                            "base_version": base_version,
                            "fields": fields,
                        }
                    ],
                }
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    result = resp.json()["results"][0]
    assert result["status"] == "accepted"
    return result


def _seed_customer_and_mapping(client, headers, test_database, *, customer_sync_id,
                               mapping_sync_id):
    """为工单 create 准备跨表校验前置：客户 + 客户编号映射，返回 customer_id。"""
    resp = client.post(
        "/sync/push",
        headers=headers,
        json={
            "operations": [
                {
                    "operation_id": f"op-{customer_sync_id}",
                    "operation_type": "create_customer",
                    "actor_type": "user",
                    "source_turn_id": None,
                    "changes": [
                        {
                            "entity_type": "customer",
                            "entity_sync_id": customer_sync_id,
                            "base_version": 0,
                            "fields": {"canonical_name": "某某厂"},
                        }
                    ],
                }
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["results"][0]["status"] == "accepted"

    conn = test_database.connect()
    try:
        row = conn.execute(
            "SELECT customer_id FROM customers WHERE sync_id = ?",
            (customer_sync_id,),
        ).fetchone()
        assert row is not None
        customer_id = int(row["customer_id"])
    finally:
        conn.close()

    resp = client.post(
        "/sync/push",
        headers=headers,
        json={
            "operations": [
                {
                    "operation_id": f"op-{mapping_sync_id}",
                    "operation_type": "create_customer_code_mapping",
                    "actor_type": "user",
                    "source_turn_id": None,
                    "changes": [
                        {
                            "entity_type": "customer_code_mapping",
                            "entity_sync_id": mapping_sync_id,
                            "base_version": 0,
                            "fields": {
                                "customer_id": customer_id,
                                "customer_code": "001",
                                "customer_name": "某某厂",
                                "valid_from": "2026-01-01",
                                "valid_to": None,
                            },
                        }
                    ],
                }
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["results"][0]["status"] == "accepted"
    return customer_id


def _fetch_work_order(test_database, sync_id):
    """直接读业务表断言撤回后的字段状态。"""
    conn = test_database.connect()
    try:
        row = conn.execute(
            "SELECT * FROM work_orders WHERE sync_id = ?", (sync_id,)
        ).fetchone()
        return dict(row) if row is not None else None
    finally:
        conn.close()


def _revert_error(code):
    """撤回拒绝的 errors 形状（docs/sync-protocol.md §4.1）。"""
    return [{"entity_sync_id": "", "error_code": code, "message": ""}]


def test_revert_work_order_create_soft_deletes(client, seed_account, test_database):
    # 撤回 create 工单：目标 before_json 为 NULL → 等价软删（deleted_at 非空），
    # MVP 只支持工单 create 的撤回。
    seed_account()
    headers = _login(client)
    customer_id = _seed_customer_and_mapping(
        client, headers, test_database,
        customer_sync_id="sync-cust-001",
        mapping_sync_id="sync-map-001",
    )
    _push_work_order(
        client, headers,
        operation_id="op-wo-001",
        sync_id="sync-wo-001",
        customer_id=customer_id,
    )

    resp = client.post(
        "/sync/push",
        headers=headers,
        json={"operations": [_revert_op("op-revert-001", "op-wo-001")]},
    )
    assert resp.status_code == 200, resp.text
    first_result = resp.json()["results"][0]
    assert first_result["status"] == "accepted"

    # 幂等重试：同 operation_id 同内容 → 返回首次已处理结果，不重复软删
    retry = client.post(
        "/sync/push",
        headers=headers,
        json={"operations": [_revert_op("op-revert-001", "op-wo-001")]},
    )
    assert retry.status_code == 200, retry.text
    assert retry.json()["results"][0] == first_result

    row = _fetch_work_order(test_database, "sync-wo-001")
    assert row is not None
    assert row["deleted_at"] is not None


def test_revert_work_order_update_restores_before_state(client, seed_account, test_database):
    # 撤回 update 工单：服务端用 update 操作的 before_json 作为反向 fields，
    # base_version=after_version，字段恢复到 update 前的状态（quantity 20 → 12）。
    seed_account()
    headers = _login(client)
    customer_id = _seed_customer_and_mapping(
        client, headers, test_database,
        customer_sync_id="sync-cust-001",
        mapping_sync_id="sync-map-001",
    )
    _push_work_order(
        client, headers,
        operation_id="op-wo-001",
        sync_id="sync-wo-001",
        customer_id=customer_id,
    )
    _push_work_order(
        client, headers,
        operation_id="op-wo-002",
        sync_id="sync-wo-001",
        customer_id=customer_id,
        base_version=1,
        fields={"quantity": 20},
    )

    resp = client.post(
        "/sync/push",
        headers=headers,
        json={"operations": [_revert_op("op-revert-001", "op-wo-002")]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["results"][0]["status"] == "accepted"

    row = _fetch_work_order(test_database, "sync-wo-001")
    assert row["quantity"] == 12
    assert row["row_version"] == 3


def test_revert_missing_target_rejected(client, seed_account):
    # 撤回不存在的 operation_id → rejected revert_target_not_found
    seed_account()
    headers = _login(client)
    resp = client.post(
        "/sync/push",
        headers=headers,
        json={"operations": [_revert_op("op-revert-001", "op-missing")]},
    )
    assert resp.status_code == 200, resp.text
    result = resp.json()["results"][0]
    assert result["status"] == "rejected"
    assert result["errors"] == _revert_error("revert_target_not_found")


def test_revert_already_reverted_target_rejected(client, seed_account, test_database):
    # 目标已被其他撤回操作指向（find_RevertOfOperation 命中）→ revert_target_invalid
    seed_account()
    headers = _login(client)
    customer_id = _seed_customer_and_mapping(
        client, headers, test_database,
        customer_sync_id="sync-cust-001",
        mapping_sync_id="sync-map-001",
    )
    _push_work_order(
        client, headers,
        operation_id="op-wo-001",
        sync_id="sync-wo-001",
        customer_id=customer_id,
    )
    resp = client.post(
        "/sync/push",
        headers=headers,
        json={"operations": [_revert_op("op-revert-001", "op-wo-001")]},
    )
    assert resp.json()["results"][0]["status"] == "accepted"

    resp = client.post(
        "/sync/push",
        headers=headers,
        json={"operations": [_revert_op("op-revert-002", "op-wo-001")]},
    )
    assert resp.status_code == 200, resp.text
    result = resp.json()["results"][0]
    assert result["status"] == "rejected"
    assert result["errors"] == _revert_error("revert_target_invalid")


def test_revert_other_account_operation_rejected(client, seed_account):
    # 账户隔离：A 撤回 B 的 operation → revert_target_not_found
    seed_account()
    seed_account(phone="13900000000")
    headers_a = _login(client)
    headers_b = _login(client, phone="13900000000", device_id="dev-000000000000")

    resp = client.post(
        "/sync/push",
        headers=headers_b,
        json={"operations": [_customer_op("op-b-001", "sync-b-001")]},
    )
    assert resp.json()["results"][0]["status"] == "accepted"

    resp = client.post(
        "/sync/push",
        headers=headers_a,
        json={"operations": [_revert_op("op-a-001", "op-b-001")]},
    )
    assert resp.status_code == 200, resp.text
    result = resp.json()["results"][0]
    assert result["status"] == "rejected"
    assert result["errors"] == _revert_error("revert_target_not_found")


def test_pull_includes_history_payload(client, seed_account, test_database):
    # Pull 响应扩展：operation 级 device_id + change 级 before_json / changed_fields_json
    # （str | None；旧客户端忽略未知字段保持兼容）。
    seed_account()
    headers = _login(client)
    customer_id = _seed_customer_and_mapping(
        client, headers, test_database,
        customer_sync_id="sync-cust-001",
        mapping_sync_id="sync-map-001",
    )
    _push_work_order(
        client, headers,
        operation_id="op-wo-001",
        sync_id="sync-wo-001",
        customer_id=customer_id,
    )
    _push_work_order(
        client, headers,
        operation_id="op-wo-002",
        sync_id="sync-wo-001",
        customer_id=customer_id,
        base_version=1,
        fields={"quantity": 20},
    )

    body = client.get(
        "/sync/pull", headers=headers, params={"after": 0, "limit": 10}
    ).json()
    ops = {op["operation_id"]: op for op in body["operations"]}

    create_op = ops["op-wo-001"]
    assert create_op["device_id"] == "dev-a1b2c3d4e5f6"
    assert create_op["actor_type"] == "user"
    create_change = create_op["changes"][0]
    assert create_change["before_json"] is None
    assert create_change["changed_fields_json"] is not None

    update_op = ops["op-wo-002"]
    assert update_op["device_id"] == "dev-a1b2c3d4e5f6"
    assert update_op["actor_type"] == "user"
    update_change = update_op["changes"][0]
    assert update_change["before_json"] is not None
    assert '"quantity"' in update_change["before_json"]
    assert update_change["changed_fields_json"] is not None
    assert '"quantity"' in update_change["changed_fields_json"]


def test_revert_of_revert_operation_rejected(client, seed_account, test_database):
    # 目标本身是撤回操作 → revert_target_invalid
    seed_account()
    headers = _login(client)
    customer_id = _seed_customer_and_mapping(
        client, headers, test_database,
        customer_sync_id="sync-cust-001",
        mapping_sync_id="sync-map-001",
    )
    _push_work_order(
        client, headers,
        operation_id="op-wo-001",
        sync_id="sync-wo-001",
        customer_id=customer_id,
    )
    resp = client.post(
        "/sync/push",
        headers=headers,
        json={"operations": [_revert_op("op-revert-001", "op-wo-001")]},
    )
    assert resp.json()["results"][0]["status"] == "accepted"

    resp = client.post(
        "/sync/push",
        headers=headers,
        json={"operations": [_revert_op("op-revert-002", "op-revert-001")]},
    )
    assert resp.status_code == 200, resp.text
    result = resp.json()["results"][0]
    assert result["status"] == "rejected"
    assert result["errors"] == _revert_error("revert_target_invalid")


def test_push_revert_op_carries_reverts_operation_id(client, seed_account, test_database):
    # 撤回操作：reverts_operation_id 随 Push 进库，Pull 时带出。
    # 撤回展开只支持工单 create → 软删，因此用 work_order 作为撤回目标。
    seed_account()
    headers = _login(client)
    customer_id = _seed_customer_and_mapping(
        client, headers, test_database,
        customer_sync_id="sync-cust-001",
        mapping_sync_id="sync-map-001",
    )
    _push_work_order(
        client, headers,
        operation_id="op-revert-001",
        sync_id="sync-revert-001",
        customer_id=customer_id,
    )

    resp = client.post(
        "/sync/push",
        headers=headers,
        json={"operations": [_revert_op("op-revert-002", "op-revert-001")]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["results"][0]["status"] == "accepted"

    pulled = client.get(
        "/sync/pull", headers=headers, params={"after": 0, "limit": 10}
    ).json()
    revert_ops = [o for o in pulled["operations"] if o["operation_id"] == "op-revert-002"]
    assert len(revert_ops) == 1
    assert revert_ops[0]["reverts_operation_id"] == "op-revert-001"
