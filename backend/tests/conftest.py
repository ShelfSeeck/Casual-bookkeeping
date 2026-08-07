"""pytest 共享 fixture：为每个测试准备一个独立的一次性 SQLite 库。

所有测试复用这两个 fixture，保证每个测试互不干扰：
- `database`：在 pytest 的临时目录里建一个全新的库文件，并应用完整 schema（10 张表）。
- `connection`：从该库打开一个连接，供 Repository 测试使用；测试结束自动关闭。

"建表 → 测试 → 删除" 的循环由 pytest 的 tmp_path 自动完成：每个测试分到
唯一的临时目录，测试结束后整目录自动删除，不会留垃圾文件。
"""

import pytest

from backend.data.db import Database
from backend.data.schema import apply_schema


@pytest.fixture
def database(tmp_path):
    # tmp_path 是 pytest 内置 fixture：每个测试自动分到唯一临时目录，测完自动删除。
    # 这里用它创建一个全新空库文件，保证每个测试从零开始、互不影响。
    db = Database(str(tmp_path / "test.db"))
    apply_schema(db)  # 应用全部建表 SQL，10 张表就绪
    return db


@pytest.fixture
def connection(database):
    # 依赖 database fixture，为 Repository 测试打开一个连接。
    # yield 之前是"准备"，yield 之后是"清理"（测试结束后自动关闭连接）。
    conn = database.connect()
    yield conn
    conn.close()
