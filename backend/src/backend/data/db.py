"""Database：SQLite 连接工厂。

只负责"按路径打开一个连接并设置统一 PRAGMA"，不持有连接、不建表、不做事务。
- 无状态（只存路径），所以进程内可以安全地共享同一个实例（见 deps.get_Database 单例）。
- 连接的生命周期（commit/rollback/close）由 deps.get_Connection 每请求统一管理。
"""

import sqlite3
from pathlib import Path


class Database:
    """SQLite 连接工厂，负责按路径打开连接并设置统一 PRAGMA。"""

    def __init__(self, database_path: str, busy_timeout_ms: int = 5000) -> None:
        self.database_path = Path(database_path)
        self.busy_timeout_ms = busy_timeout_ms

    def connect(self) -> sqlite3.Connection:
        # 目录不存在时先创建（首次运行时 data/ 目录尚未存在）
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.database_path)
        # row_factory = Row：SQL 返回的每行可按列名取值（row["phone"]），
        # 方便转成 dict/dataclass
        connection.row_factory = sqlite3.Row
        # WAL 模式：读和写互不阻塞，适合多个请求并发访问同一个库文件
        connection.execute("PRAGMA journal_mode = WAL")
        # 设计约定：业务表之间不声明外键，完整性校验在应用层
        # （docs/data-model.md 原则 13），故显式关闭外键强制
        connection.execute("PRAGMA foreign_keys = OFF")
        # 写锁冲突时排队等待（毫秒，来自 config busy_timeout_ms），
        # 而不是立刻报 "database is locked"
        connection.execute(f"PRAGMA busy_timeout = {self.busy_timeout_ms}")
        return connection
