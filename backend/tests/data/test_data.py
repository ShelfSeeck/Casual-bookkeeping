"""data 层测试：建表能力（缝 1）与连接 DI（缝 4）。

- 缝 1 apply_schema：对全新临时库应用 schema 后，10 张表全部建出；
  四张业务表必须带 sync_id + row_version（docs/data-model.md §4.1）。
- 缝 4 get_Connection：请求正常结束自动 commit、异常自动 rollback、连接关闭。
"""

import sqlite3

import pytest

from backend.data.db import Database
from backend.data.schema import apply_schema
from backend.deps import get_Connection
from backend.repositories.accounts import AccountsRepository

# 10 张表的预期清单，与 docs/data-model.md 的定稿结构一一对应
EXPECTED_TABLES = {
    "accounts",                 # 认证：账户
    "account_devices",          # 认证：账户-设备会话信任状态
    "service_categories",       # 业务：服务大类/小类配置
    "customers",                # 业务：真实客户
    "customer_code_mappings",   # 业务：客户编号映射（按时期有效）
    "work_orders",              # 业务：工单
    "database_operations",      # 操作历史：正式操作主表
    "operation_changes",        # 操作历史：操作明细（撤回依据）
    "chat_sessions",            # AI：对话会话
    "chat_turns",               # AI：对话回合
}

# 四张可同步业务表（docs/data-model.md §4.1 要求带 sync_id + row_version）
EXPECTED_BUSINESS_TABLES = {
    "service_categories",
    "customers",
    "customer_code_mappings",
    "work_orders",
}


def _table_columns(database, table: str) -> set[str]:
    connection = database.connect()
    try:
        rows = connection.execute(f"PRAGMA table_info({table})").fetchall()
    finally:
        connection.close()
    return {row["name"] for row in rows}


# ---------- 缝 1：建表 ----------

def test_apply_schema_creates_all_tables(tmp_path):
    # 直接用临时路径构造 Database（不走配置文件，测试自给自足）
    database = Database(str(tmp_path / "test.db"))
    apply_schema(database)

    # 连接后查询 sqlite_master，拿到所有已建的用户表名
    connection = database.connect()
    rows = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).fetchall()
    names = {row["name"] for row in rows}

    # 断言：实际建出的表 >= 预期 10 张（子集关系）
    assert EXPECTED_TABLES <= names


def test_business_tables_carry_sync_columns(database):
    # docs/data-model.md §4.1：四张业务表必须带 sync_id（唯一）与 row_version，
    # 它们是跨设备同步定位记录和乐观并发控制的依据，漏掉会导致同步设计失效。
    for table in EXPECTED_BUSINESS_TABLES:
        columns = _table_columns(database, table)
        assert "sync_id" in columns, f"{table} 缺 sync_id"
        assert "row_version" in columns, f"{table} 缺 row_version"


# ---------- 缝 4：get_Connection 自动善后 ----------

def test_get_Connection_commits_on_success(database):
    # 模拟"请求开始"：注入一个连接；随后做一次业务写入。
    gen = get_Connection(database)
    connection = next(gen)
    AccountsRepository(connection).create_Account(
        "13800000000", "hash-value", "active"
    )

    # 模拟"请求正常结束"：让生成器继续执行，走到 commit（跑完抛 StopIteration）
    with pytest.raises(StopIteration):
        next(gen)

    # 用另一个独立连接验证：账户确实被持久化成功（说明 commit 生效）
    verify = database.connect()
    try:
        assert AccountsRepository(verify).get_Account("13800000000") is not None
    finally:
        verify.close()


def test_get_Connection_rolls_back_on_exception(database):
    # 模拟"请求中途抛异常"：gen.throw 在 yield 处重抛，触发 rollback 后继续外抛
    gen = get_Connection(database)
    connection = next(gen)
    AccountsRepository(connection).create_Account(
        "13800000000", "hash-value", "active"
    )

    with pytest.raises(RuntimeError):
        gen.throw(RuntimeError("boom"))

    # 验证：异常路径下账户没有被保存（rollback 生效）
    verify = database.connect()
    try:
        assert AccountsRepository(verify).get_Account("13800000000") is None
    finally:
        verify.close()


def test_get_Connection_closes_connection(database):
    # 请求结束后连接被关闭：对已关闭连接操作会抛 ProgrammingError
    gen = get_Connection(database)
    connection = next(gen)

    with pytest.raises(StopIteration):
        next(gen)

    with pytest.raises(sqlite3.ProgrammingError):
        connection.execute("SELECT 1")


def test_get_RateLimiter_returns_shared_instance():
    # 防刷必须进程内共享一个实例（docs §2.11）：若每请求新建，失败计数/锁定状态
    # 会被丢弃，5 次失败锁定永不生效。两次调用应为同一对象。
    from backend.deps import get_RateLimiter

    assert get_RateLimiter() is get_RateLimiter()


def test_get_Settings_returns_shared_instance():
    # 配置应只解析一次（进程内共享），避免每请求重读 config.toml。
    # 惰性单例：改 config.toml 后需重启进程生效。
    from backend.deps import get_Settings

    assert get_Settings() is get_Settings()


def test_apply_schema_migrates_legacy_account_devices_for_refresh_rotation(tmp_path):
    # 已部署数据库只有旧 6 列时，启动建表流程必须原位补齐轮换列且保留会话行。
    database = Database(str(tmp_path / "legacy.db"))
    connection = database.connect()
    connection.executescript(
        """
        CREATE TABLE accounts (
            phone TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE account_devices (
            account_phone TEXT NOT NULL,
            device_id TEXT NOT NULL,
            status TEXT NOT NULL,
            refresh_expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_active_at TEXT NOT NULL,
            PRIMARY KEY (account_phone, device_id)
        );
        INSERT INTO account_devices VALUES (
            '13800000000', 'dev-a1b2c3d4e5f6', 'active',
            '2027-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00',
            '2026-01-01T00:00:00+00:00'
        );
        """
    )
    connection.commit()
    connection.close()

    apply_schema(database)

    assert {
        "refresh_token_hash",
        "refresh_family_id",
        "refresh_jti",
    } <= _table_columns(database, "account_devices")
    verify = database.connect()
    try:
        row = verify.execute(
            "SELECT status, refresh_token_hash FROM account_devices"
        ).fetchone()
        assert dict(row) == {"status": "active", "refresh_token_hash": None}
    finally:
        verify.close()
