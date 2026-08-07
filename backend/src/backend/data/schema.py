"""apply_schema：按模块化 SQL 文件幂等建表。

设计约定（用户要求）：每张表一个独立 .sql 文件，按"域目录 + 文件名序号"排序执行，
表与表互不耦合，单表坏了不影响其他表。
用 `CREATE TABLE IF NOT EXISTS` 保证幂等，重复执行不会报错。
"""

from pathlib import Path

from backend.data.db import Database

# schema 目录就在本文件旁边：src/backend/data/schema/
# 结构：auth/ 认证、business/ 业务、operations/ 操作历史、chat/ AI 对话
_SCHEMA_DIR = Path(__file__).parent / "schema"


def apply_schema(database: Database) -> None:
    """按目录+文件名顺序幂等执行全部建表 SQL，一次建齐所有表。"""
    connection = database.connect()
    try:
        # sorted + rglob 保证执行顺序：auth < business < operations < chat，
        # 每组内再按 01_、02_ 序号执行
        for sql_file in sorted(_SCHEMA_DIR.rglob("*.sql")):
            connection.executescript(sql_file.read_text(encoding="utf-8"))
        connection.commit()
    finally:
        connection.close()
