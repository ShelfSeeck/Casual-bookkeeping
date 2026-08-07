"""BaseRepository：Repository 公共基类（DRY 私有辅助）。

所有 Repository 共享：一个连接 + 几个通用的私有 SQL 方法。
这些方法是实现细节（下划线前缀表示私有），不对外暴露、不被测试直接验证——
对外只暴露具名的受控业务方法（如 get_Account），保持接口可控。
"""

import sqlite3
from typing import Any


class BaseRepository:
    """Repository 公共基类，持有连接并提供私有 SQL 辅助（DRY，不对外）。"""

    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection

    def _insert(self, table: str, values: dict[str, Any]) -> None:
        # 通用插入：列名和值都来自 values 字典（键=列名，值=字段值）。
        # 值用 ? 占位符传入，防止 SQL 注入。
        columns = ", ".join(values)
        placeholders = ", ".join("?" for _ in values)
        self.connection.execute(
            f"INSERT INTO {table} ({columns}) VALUES ({placeholders})",
            tuple(values.values()),
        )

    def _update(
        self,
        table: str,
        set_values: dict[str, Any],
        where_column: str,
        where_value: Any,
    ) -> None:
        # 通用更新：按某个条件列定位一行（如按主键 phone），更新若干字段。
        # 同样使用 ? 占位符，避免 SQL 注入。
        assignments = ", ".join(f"{col} = ?" for col in set_values)
        self.connection.execute(
            f"UPDATE {table} SET {assignments} WHERE {where_column} = ?",
            tuple(set_values.values()) + (where_value,),
        )
