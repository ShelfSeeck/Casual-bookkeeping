"""依赖注入组装层：把 Database、连接、Repository 用 FastAPI Depends 串起来。

这是全项目唯一 import FastAPI 的层；仓库层（repositories/）和 data 层保持纯净，
便于单元测试和复用。

依赖关系链：
    get_AccountsRepository ──Depends──► get_Connection ──Depends──► get_Database
    端点只声明 get_AccountsRepository 等，连接/数据库细节全部隐藏。
"""

import sqlite3
from collections.abc import Iterator

from fastapi import Depends

from backend.config import Settings
from backend.data.db import Database
from backend.repositories.account_devices import AccountDevicesRepository
from backend.repositories.accounts import AccountsRepository

# 模块级惰性单例：Database 无状态（只含路径+连接工厂），进程内共享一个即可。
# 首次 get_Database() 才读 config.toml 并创建，避免每个请求重复解析配置
# （参照 Learnova 的 db_dep.py 单例模式，但改为惰性，测试不依赖 config.toml 存在）。
_database: Database | None = None


def get_Database() -> Database:
    """惰性单例：Database 无状态（只含路径+连接工厂），进程内共享一个。"""
    global _database
    if _database is None:
        settings = Settings()
        _database = Database(settings.database_path)
    return _database


def get_Connection(
    database: Database = Depends(get_Database),
) -> Iterator[sqlite3.Connection]:
    """每请求一个连接，统一管理事务边界：
    正常结束自动 commit；抛异常自动 rollback；无论怎样最后关闭。
    连接永不跨请求共享（与 Learnova 的 db_cursor() 语义一致）。
    """
    connection = database.connect()
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def get_AccountsRepository(
    connection: sqlite3.Connection = Depends(get_Connection),
) -> AccountsRepository:
    # 端点声明依赖后直接拿到仓库对象，无需关心连接怎么来怎么走
    return AccountsRepository(connection)


def get_AccountDevicesRepository(
    connection: sqlite3.Connection = Depends(get_Connection),
) -> AccountDevicesRepository:
    return AccountDevicesRepository(connection)
