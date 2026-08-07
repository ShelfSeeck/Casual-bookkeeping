"""缝 1：apply_schema 的建表能力。

被测缝：`apply_schema(database)` —— 对一个全新临时库应用 schema 后，10 张表全部建出。

验证方式：通过 Database 连接查询 sqlite_master（SQLite 的系统表，记录所有已建的表），
断言实际建出的表包含了预期的 10 张。
这是整个数据库地基的验证——任何一张建表 SQL 写错（少逗号、列名拼错）都会在这里被抓出来。
"""

from backend.data.db import Database
from backend.data.schema import apply_schema

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
