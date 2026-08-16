"""缝 14（协议级全链路）：模拟客户端完整同步流程（docs/spec/sync-backend.md §8 C 层）。

被测缝：真实后端三端点组合起来是否达成协议语义——
1. bootstrap 拿到快照 + snapshot_seq
2. 离线攒批 → Push 批量 accepted
3. 两设备并发写同一记录 → 后 Push 方 conflict → 合并后收敛
4. Pull 拉回自己的 + 别人的操作，客户端可据此收敛业务表

这里用 pytest TestClient 扮演"客户端"（调用真实端点），不 mock 任何后端逻辑。
"""

import json

# fixture（client / seed_account / test_database）由本目录 conftest.py 自动加载


def _login(client, phone="13800000000", password="secret-password",
           device_id="dev-a1b2c3d4e5f6"):
    resp = client.post(
        "/auth/login",
        json={"phone": phone, "password": password, "device_id": device_id},
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def _push(client, headers, operations):
    resp = client.post("/sync/push", headers=headers, json={"operations": operations})
    assert resp.status_code == 200, resp.text
    return resp.json()["results"]


def _pull(client, headers, after=0):
    resp = client.get("/sync/pull", headers=headers, params={"after": after, "limit": 200})
    return resp.json()


def _bootstrap(client, headers):
    resp = client.get("/sync/bootstrap", headers=headers)
    return resp.json()


def _create_customer(op_id, sync_id, name="某某厂"):
    return {
        "operation_id": op_id,
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


def _update_customer(op_id, sync_id, base_version, name):
    return {
        "operation_id": op_id,
        "operation_type": "update_customer",
        "actor_type": "user",
        "source_turn_id": None,
        "changes": [
            {
                "entity_type": "customer",
                "entity_sync_id": sync_id,
                "base_version": base_version,
                "fields": {"canonical_name": name, "archived_at": None},
            }
        ],
    }


def test_full_flow_bootstrap_then_push_then_pull(client, seed_account):
    # 新设备首登：bootstrap（空库）→ snapshot_seq=0 → 离线攒 3 条 → 批量 Push
    # → accepted → Pull 全部拉回
    seed_account()
    headers = _login(client)

    # 1. bootstrap 空库
    boot = _bootstrap(client, headers)
    assert boot["snapshot_seq"] == 0
    assert boot["customers"] == []

    # 2. 离线攒 3 条 → 批量 Push
    results = _push(
        client,
        headers,
        [
            _create_customer("op-e2e-001", "sync-000000000001", "客户A"),
            _create_customer("op-e2e-002", "sync-000000000002", "客户B"),
            _create_customer("op-e2e-003", "sync-000000000003", "客户C"),
        ],
    )
    assert [r["status"] for r in results] == ["accepted"] * 3

    # 3. Pull 拉回全部，升序
    pulled = _pull(client, headers)
    assert len(pulled["operations"]) == 3
    seqs = [o["server_seq"] for o in pulled["operations"]]
    assert seqs == sorted(seqs)
    # 每条带 after_json（完整快照，JSON 字符串）
    names = {json.loads(o["changes"][0]["after_json"])["canonical_name"] for o in pulled["operations"]}
    assert names == {"客户A", "客户B", "客户C"}


def test_two_devices_conflict_then_converge(client, seed_account):
    # 设备 A 建客户；设备 B（另一 device_id）也改同一客户 → 冲突
    # → A 拿 Theirs 版本重新合并 → 双方 Pull 收敛一致
    seed_account()
    headers_a = _login(client, device_id="dev-aaaaaaaaaaaa")
    headers_b = _login(client, device_id="dev-bbbbbbbbbbbb")

    _push(client, headers_a, [_create_customer("op-e2e-020", "sync-000000000020", "原名")])

    # 设备 A 改：基于 v1 → v2
    results_a = _push(
        client,
        headers_a,
        [_update_customer("op-e2e-021", "sync-000000000020", 1, "A改的名字")],
    )
    assert results_a[0]["status"] == "accepted"

    # 设备 B 改：还基于 v1（过期）→ conflict
    results_b = _push(
        client,
        headers_b,
        [_update_customer("op-e2e-022", "sync-000000000020", 1, "B改的名字")],
    )
    assert results_b[0]["status"] == "conflict"
    theirs = results_b[0]["conflict_json"]["theirs"]
    assert theirs["row_version"] == 2
    assert theirs["canonical_name"] == "A改的名字"  # Theirs = 当前服务端状态

    # 设备 B 以 Theirs 版本(2) 合并重推 → accepted
    results_b2 = _push(
        client,
        headers_b,
        [_update_customer("op-e2e-023", "sync-000000000020", 2, "B合并的名字")],
    )
    assert results_b2[0]["status"] == "accepted"

    # 双方 Pull：都能拉到最终状态（服务端权威收敛）
    for headers in (headers_a, headers_b):
        pulled = _pull(client, headers, after=0)
        final_changes = [
            c
            for o in pulled["operations"]
            for c in o["changes"]
            if c["entity_sync_id"] == "sync-000000000020"
        ]
        last = final_changes[-1]
        assert last["after_version"] == 3
        assert json.loads(last["after_json"])["canonical_name"] == "B合并的名字"


def test_push_idempotent_retry_after_network_retry(client, seed_account):
    # 网络重试：同 operation_id 同内容重推 → 不重复写业务表，返回首次 server_seq
    seed_account()
    headers = _login(client)
    op = _create_customer("op-e2e-030", "sync-000000000030")
    first = _push(client, headers, [op])[0]
    second = _push(client, headers, [op])[0]

    assert first["status"] == "accepted"
    assert second["status"] == "accepted"
    assert second["server_seq"] == first["server_seq"]  # 幂等，不产生新 seq

    # 业务表只有一条（没重复创建）
    pulled = _pull(client, headers)
    same_sync = [
        c for o in pulled["operations"] for c in o["changes"]
        if c["entity_sync_id"] == "sync-000000000030"
    ]
    assert len(same_sync) == 1
