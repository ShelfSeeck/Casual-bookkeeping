"""缝 4：get_Connection 依赖生成器的"自动善后"行为。

被测缝：`get_Connection(database)` 是 FastAPI 依赖，负责每个请求的连接生命周期：
- 请求正常结束 → 自动 commit（改动真正保存到库）
- 请求中途抛异常 → 自动 rollback（改动全部撤销，不留脏数据）
- 无论哪种情况 → 连接关闭

测试不经过 HTTP，直接"手搓"调用生成器来模拟 FastAPI 的注入流程：
- `next(gen)` 拿到连接 = FastAPI 在请求开始时做的注入；
- 再次 `next(gen)` = FastAPI 在请求正常结束后让生成器继续跑（触发 commit，
  生成器跑完抛 StopIteration）；
- `gen.throw(exc)` = FastAPI 在请求抛异常时把异常塞回生成器（触发 rollback）。
"""

import sqlite3

import pytest

from backend.deps import get_Connection
from backend.repositories.accounts import AccountsRepository


def test_get_Connection_commits_on_success(database):
    # 模拟"请求开始"：注入一个连接
    gen = get_Connection(database)
    connection = next(gen)

    # 在连接上做一次业务写入（建账户）
    AccountsRepository(connection).create_Account(
        "13800000000", "hash-value", "active"
    )

    # 模拟"请求正常结束"：让生成器继续执行，走到 connection.commit()。
    # 生成器跑完会抛 StopIteration，用 pytest.raises 接住。
    with pytest.raises(StopIteration):
        next(gen)

    # 用另一个独立连接验证：账户确实被持久化成功了（否则说明没 commit）
    verify = database.connect()
    try:
        assert AccountsRepository(verify).get_Account("13800000000") is not None
    finally:
        verify.close()


def test_get_Connection_rolls_back_on_exception(database):
    # 模拟"请求中途抛异常"：gen.throw 会在生成器内部的 yield 处重新抛出异常，
    # 触发 except 分支的 rollback，然后异常继续向外传播（被 pytest.raises 接住）。
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
    # 验证请求结束后连接被关闭：对已关闭的连接执行操作会抛 ProgrammingError
    gen = get_Connection(database)
    connection = next(gen)

    # 正常结束流程（触发 finally 里的 connection.close()）
    with pytest.raises(StopIteration):
        next(gen)

    # 连接已关闭，任何操作都应报错
    with pytest.raises(sqlite3.ProgrammingError):
        connection.execute("SELECT 1")
