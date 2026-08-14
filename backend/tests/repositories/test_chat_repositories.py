"""缝 13：AI 对话仓库测试（docs/spec/chat-agent.md §3、§9、§10）。

被测缝：ChatSessionsRepository 与 ChatTurnsRepository 的公开接口——
- 会话：create_Session / get_Session / list_Sessions
- 回合：upsert_Turn / get_Turn / list_Turns
期望值来自 docs/ai-chat-storage.md 与 docs/spec/chat-agent.md §3 的字面量。

共性契约：
- 时间字段由仓库生成（ISO 8601 UTC），调用方不传
- 会话 list 按 updated_at 倒序；回合 list 按 created_at 升序（同则 turn_id 升序）
- 回合 upsert 幂等：同 turn_id 覆盖 messages_json、保留 created_at、不新增行
- list_Turns 游标 after_turn_id 排他（不含自身），next_cursor 为最后一条 turn_id 或 None
"""

from backend.repositories.chat_sessions import ChatSessionsRepository
from backend.repositories.chat_turns import ChatTurnsRepository


def _fake_now(*times):
    """返回一个按序吐出 times 的时钟；用尽后继续返回最后一个值。

    用于替代仓库默认的真实时钟，让 created_at/updated_at 可预测，
    以便确定性验证"按时间排序"与"游标分页"（时间不是本测试的断言目标）。
    """
    times = list(times)

    def now():
        return times.pop(0) if len(times) > 1 else times[0]

    return now


# ---------- 会话 ----------


def test_get_Session_returns_None_when_missing(connection):
    # 查无返回 None，供上层据此判定会话不存在（spec §4 归属校验 → 404）
    repo = ChatSessionsRepository(connection)
    assert repo.get_Session("s-000000000001") is None


def test_create_Session_then_get_returns_full_record(connection):
    # create 后按主键 get 能查到，字段与入参及生成时间一致
    repo = ChatSessionsRepository(connection)
    repo._now_factory = _fake_now("2026-08-13T00:00:01.000000+00:00")
    repo.create_Session("13800000000", "s-000000000001", "7月对账")

    s = repo.get_Session("s-000000000001")
    assert s is not None
    assert s["session_id"] == "s-000000000001"
    assert s["account_phone"] == "13800000000"
    assert s["title"] == "7月对账"
    assert s["created_at"] == "2026-08-13T00:00:01.000000+00:00"
    assert s["updated_at"] == "2026-08-13T00:00:01.000000+00:00"


def test_list_Sessions_orders_by_updated_at_desc(connection):
    # spec §4.2：会话列表按 updated_at 倒序（最近活动在前）
    repo = ChatSessionsRepository(connection)
    repo._now_factory = _fake_now(
        "2026-08-13T00:00:01.000000+00:00",
        "2026-08-13T00:00:02.000000+00:00",
        "2026-08-13T00:00:03.000000+00:00",
    )
    repo.create_Session("13800000000", "s-000000000001", "A")
    repo.create_Session("13800000000", "s-000000000002", "B")
    repo.create_Session("13800000000", "s-000000000003", "C")

    sessions = repo.list_Sessions("13800000000")
    assert [s["session_id"] for s in sessions] == [
        "s-000000000003",
        "s-000000000002",
        "s-000000000001",
    ]


def test_list_Sessions_filters_by_account(connection):
    # 账户隔离：只返回当前账户的会话，看不到其他账户（spec §4.5 归属）
    repo = ChatSessionsRepository(connection)
    repo.create_Session("13800000000", "s-000000000001", "A")
    repo.create_Session("13900000000", "s-000000000002", "B")

    sessions = repo.list_Sessions("13800000000")
    assert [s["session_id"] for s in sessions] == ["s-000000000001"]


# ---------- 回合 ----------


def test_get_Turn_returns_None_when_missing(connection):
    # 查无返回 None，供上层据此判定回合不存在
    repo = ChatTurnsRepository(connection)
    assert repo.get_Turn("t-000000000001") is None


def test_upsert_Turn_inserts_then_get(connection):
    # 首次 upsert 走插入：created_at == updated_at == 生成时间
    repo = ChatTurnsRepository(connection)
    repo._now_factory = _fake_now("2026-08-13T00:00:01.000000+00:00")
    repo.upsert_Turn("t-000000000001", "s-000000000001", "[]")

    t = repo.get_Turn("t-000000000001")
    assert t is not None
    assert t["turn_id"] == "t-000000000001"
    assert t["session_id"] == "s-000000000001"
    assert t["messages_json"] == "[]"
    assert t["created_at"] == "2026-08-13T00:00:01.000000+00:00"
    assert t["updated_at"] == "2026-08-13T00:00:01.000000+00:00"


def test_upsert_Turn_overwrites_messages_json_and_keeps_created_at(connection):
    # 同 turn_id 二次 upsert 覆盖 messages_json + updated_at，created_at 保留、不新增行
    # （docs/ai-chat-storage.md §4：重试复用同 turn_id，成功后直接替换，不保留旧版本）
    repo = ChatTurnsRepository(connection)
    repo._now_factory = _fake_now(
        "2026-08-13T00:00:01.000000+00:00",
        "2026-08-13T00:00:02.000000+00:00",
    )
    repo.upsert_Turn("t-000000000001", "s-000000000001", "[]")
    repo.upsert_Turn("t-000000000001", "s-000000000001", '[{"role": "user"}]')

    t = repo.get_Turn("t-000000000001")
    assert t["messages_json"] == '[{"role": "user"}]'
    assert t["created_at"] == "2026-08-13T00:00:01.000000+00:00"
    assert t["updated_at"] == "2026-08-13T00:00:02.000000+00:00"

    rows, _ = repo.list_Turns("s-000000000001", None, 10)
    assert len(rows) == 1


def test_list_Turns_returns_in_ascending_created_at_order(connection):
    # spec §4.3：回合按 created_at 升序（插入顺序≠时间顺序，验证按时间排）
    repo = ChatTurnsRepository(connection)
    repo._now_factory = _fake_now(
        "2026-08-13T00:00:01.000000+00:00",
        "2026-08-13T00:00:02.000000+00:00",
        "2026-08-13T00:00:03.000000+00:00",
    )
    repo.upsert_Turn("t-000000000002", "s-000000000001", "second")
    repo.upsert_Turn("t-000000000003", "s-000000000001", "third")
    repo.upsert_Turn("t-000000000001", "s-000000000001", "first")

    rows, next_cursor = repo.list_Turns("s-000000000001", None, 10)
    assert [t["turn_id"] for t in rows] == [
        "t-000000000002",
        "t-000000000003",
        "t-000000000001",
    ]
    assert next_cursor is None


def test_list_Turns_orders_by_turn_id_when_created_at_equal(connection):
    # 相同 created_at 时按 turn_id 升序，保证游标顺序稳定（spec §3 / 列表排序）
    repo = ChatTurnsRepository(connection)
    same = "2026-08-13T00:00:01.000000+00:00"
    repo._now_factory = _fake_now(same, same, same)
    repo.upsert_Turn("t-000000000002", "s-000000000001", "b")
    repo.upsert_Turn("t-000000000001", "s-000000000001", "a")
    repo.upsert_Turn("t-000000000003", "s-000000000001", "c")

    rows, _ = repo.list_Turns("s-000000000001", None, 10)
    assert [t["turn_id"] for t in rows] == [
        "t-000000000001",
        "t-000000000002",
        "t-000000000003",
    ]


def test_list_Turns_after_cursor_excludes_self_and_earlier(connection):
    # 游标排他：after_turn_id 之后（不含自身）的回合（spec §4.3 查询参数语义）
    repo = ChatTurnsRepository(connection)
    repo._now_factory = _fake_now(
        "2026-08-13T00:00:01.000000+00:00",
        "2026-08-13T00:00:02.000000+00:00",
        "2026-08-13T00:00:03.000000+00:00",
    )
    repo.upsert_Turn("t-000000000001", "s-000000000001", "a")
    repo.upsert_Turn("t-000000000002", "s-000000000001", "b")
    repo.upsert_Turn("t-000000000003", "s-000000000001", "c")

    rows, next_cursor = repo.list_Turns("s-000000000001", "t-000000000001", 10)
    assert [t["turn_id"] for t in rows] == [
        "t-000000000002",
        "t-000000000003",
    ]
    assert next_cursor is None


def test_list_Turns_limit_and_next_cursor(connection):
    # limit 截断 + 还有更多时 next_cursor = 最后一条返回回合的 turn_id（spec §4.3 分页）
    repo = ChatTurnsRepository(connection)
    repo._now_factory = _fake_now(
        "2026-08-13T00:00:01.000000+00:00",
        "2026-08-13T00:00:02.000000+00:00",
        "2026-08-13T00:00:03.000000+00:00",
    )
    repo.upsert_Turn("t-000000000001", "s-000000000001", "a")
    repo.upsert_Turn("t-000000000002", "s-000000000001", "b")
    repo.upsert_Turn("t-000000000003", "s-000000000001", "c")

    rows, next_cursor = repo.list_Turns("s-000000000001", None, 2)
    assert [t["turn_id"] for t in rows] == ["t-000000000001", "t-000000000002"]
    assert next_cursor == "t-000000000002"


def test_list_Turns_next_cursor_None_when_no_more(connection):
    # 恰好取完（limit == 总数）时 next_cursor 为 None（spec §4.3）
    repo = ChatTurnsRepository(connection)
    repo._now_factory = _fake_now(
        "2026-08-13T00:00:01.000000+00:00",
        "2026-08-13T00:00:02.000000+00:00",
    )
    repo.upsert_Turn("t-000000000001", "s-000000000001", "a")
    repo.upsert_Turn("t-000000000002", "s-000000000001", "b")

    rows, next_cursor = repo.list_Turns("s-000000000001", None, 2)
    assert len(rows) == 2
    assert next_cursor is None


def test_list_Turns_filters_by_session(connection):
    # 只返回该会话的回合，不含其他会话（spec §4.3 按 sid 查历史）
    repo = ChatTurnsRepository(connection)
    repo.upsert_Turn("t-000000000001", "s-000000000001", "a")
    repo.upsert_Turn("t-000000000002", "s-000000000002", "b")

    rows, _ = repo.list_Turns("s-000000000001", None, 10)
    assert [t["turn_id"] for t in rows] == ["t-000000000001"]
