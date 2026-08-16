"""缝 12：操作历史仓库测试（docs/spec/sync-backend.md §5）。

被测缝：OperationsRepository 的公开接口——
insert_Operation / get_ByOperationId / list_AfterSeq / get_MaxSeq。
期望值来自 docs/sync-protocol.md §4 与 data-model.md §5.3 的字面量。

共性契约：
- insert_Operation：写主表拿自增 server_seq + 写 changes 明细，同一事务
- get_ByOperationId：幂等查（同 operation_id 是否已处理）
- list_AfterSeq：server_seq > after 升序分页，一条操作不拆分，has_more 语义
- get_MaxSeq：bootstrap 的 snapshot_seq 来源
"""

from backend.repositories.operations import OperationsRepository


def _sample_changes():
    return [
        {
            "entity_type": "customer",
            "entity_sync_id": "sync-000000000001",
            "change_type": "create",
            "before_version": None,
            "after_version": 1,
            "before_json": None,
            "after_json": '{"sync_id": "sync-000000000001"}',
            "changed_fields_json": '{"canonical_name": "某某厂"}',
        }
    ]


def _insert_op(repo, operation_id="op-a1b2c3d4e5f6"):
    return repo.insert_Operation(
        account_phone="13800000000",
        device_id="dev-a1b2c3d4e5f6",
        operation_id=operation_id,
        request_hash="hash-1",
        actor_type="user",
        operation_type="create_customer",
        source_turn_id=None,
        reverts_operation_id=None,
        result_json='{"status": "accepted"}',
        changes=_sample_changes(),
    )


def test_insert_Operation_returns_increasing_server_seq(connection):
    # server_seq 是全局自增序号（data-model.md §5.1）：连续两条严格递增
    repo = OperationsRepository(connection)
    first = _insert_op(repo, "op-000000000001")
    second = _insert_op(repo, "op-000000000002")
    assert second > first
    assert first >= 1


def test_get_ByOperationId_returns_None_when_missing(connection):
    repo = OperationsRepository(connection)
    assert repo.get_ByOperationId("op-000000000001") is None


def test_get_ByOperationId_finds_inserted(connection):
    # 幂等查：插入后按 operation_id 能查到已处理记录
    repo = OperationsRepository(connection)
    _insert_op(repo, "op-000000000001")
    op = repo.get_ByOperationId("op-000000000001")
    assert op is not None
    assert op["operation_id"] == "op-000000000001"
    assert op["request_hash"] == "hash-1"


def test_insert_Operation_writes_changes(connection):
    # 一条操作的多条 changes 都归到同一 operation_id（data-model §5.3 归组）
    repo = OperationsRepository(connection)
    _insert_op(repo, "op-000000000001")
    rows = connection.execute(
        "SELECT entity_sync_id, change_type FROM operation_changes"
        " WHERE operation_id = 'op-000000000001'"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["entity_sync_id"] == "sync-000000000001"


def test_list_AfterSeq_returns_ops_in_ascending_order(connection):
    # Pull 契约：server_seq > after 升序返回（docs/sync-protocol.md §4.2）
    repo = OperationsRepository(connection)
    _insert_op(repo, "op-000000000001")
    _insert_op(repo, "op-000000000002")
    _insert_op(repo, "op-000000000003")

    ops, has_more = repo.list_AfterSeq("13800000000", after=0, limit=10)
    seqs = [op["server_seq"] for op in ops]
    assert seqs == sorted(seqs)
    assert has_more is False


def test_list_AfterSeq_excludes_ops_at_or_before_after(connection):
    # 游标是排他（严格大于）：after 处及之前的操作不返回
    repo = OperationsRepository(connection)
    first = _insert_op(repo, "op-000000000001")
    _insert_op(repo, "op-000000000002")

    ops, _ = repo.list_AfterSeq("13800000000", after=first, limit=10)
    assert [op["server_seq"] for op in ops] == [first + 1]


def test_list_AfterSeq_respects_account_isolation(connection):
    # 账户隔离：只返回当前账户的操作，不含其他账户
    repo = OperationsRepository(connection)
    _insert_op(repo, "op-000000000001")
    ops, _ = repo.list_AfterSeq("13900000000", after=0, limit=10)
    assert ops == []


def test_list_AfterSeq_limit_and_has_more(connection):
    # limit=2 且共有 3 条 → 返回 2 条、has_more=True
    repo = OperationsRepository(connection)
    _insert_op(repo, "op-000000000001")
    _insert_op(repo, "op-000000000002")
    _insert_op(repo, "op-000000000003")

    ops, has_more = repo.list_AfterSeq("13800000000", after=0, limit=2)
    assert len(ops) == 2
    assert has_more is True


def test_get_MaxSeq_returns_zero_when_empty(connection):
    # bootstrap 的 snapshot_seq：空库为 0
    repo = OperationsRepository(connection)
    assert repo.get_MaxSeq("13800000000") == 0


def test_get_MaxSeq_returns_latest(connection):
    # bootstrap 的 snapshot_seq：最新一条操作序号
    repo = OperationsRepository(connection)
    _insert_op(repo, "op-000000000001")
    _insert_op(repo, "op-000000000002")
    assert repo.get_MaxSeq("13800000000") == 2


def test_get_MaxSeq_respects_account_isolation(connection):
    # bootstrap 的 snapshot_seq 必须锚定当前账户：其他账户的操作序号不计入
    # （曾用全局 MAX(server_seq)，导致 A 账户 bootstrap 游标被 B 账户的操作推进）
    repo = OperationsRepository(connection)
    _insert_op(repo, "op-000000000001")
    conn = repo.connection
    conn.execute(
        "INSERT INTO database_operations"
        " (operation_id, request_hash, result_json, account_phone, device_id,"
        "  actor_type, source_turn_id, operation_type, reverts_operation_id, created_at)"
        " VALUES ('op-00000000000b', 'hash-b', '{}', '13900000000', NULL,"
        "  'user', NULL, 'create_customer', NULL, '2026-08-14T00:00:00+00:00')"
    )
    assert repo.get_MaxSeq("13800000000") == 1
