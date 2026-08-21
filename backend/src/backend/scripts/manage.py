"""后台管理 CLI：创建账户、登记设备等（仅后端本机使用，不走 API 认证）。

命令动作是独立的纯函数（add_Account / add_Device），接收连接、复用仓库；
argparse 只负责参数解析，main() 负责开连接、提交、打印结果。

用法（两种等价）：
    uv run python -m backend.scripts.manage add-account 13800000000 --password xxx
    uv run cb-manage add-account 13800000000 --password xxx
"""

import argparse
import getpass
import json
import os
from datetime import datetime, timedelta, timezone

from backend.config import Settings
from backend.data.db import Database
from backend.data.schema import apply_schema
from backend.repositories.account_devices import AccountDevicesRepository
from backend.repositories.accounts import AccountsRepository
from backend.services.password import PasswordService


def add_Account(connection, phone: str, password: str, status: str = "active") -> None:
    """创建账户：密码用 Argon2id 哈希后入库，绝不允许存明文。

    PasswordService 默认即 Argon2id（与认证文档定案一致）。
    """
    password_hash = PasswordService().hash(password)
    AccountsRepository(connection).create_Account(phone, password_hash, status)


def add_Device(
    connection,
    phone: str,
    device_id: str,
    expires_at: str | None = None,
) -> None:
    """登记设备会话：无则插入、有则更新（复用 upsert_Device）。

    refresh 过期时间缺省为"当前时间 + 配置的 refresh_token_ttl_seconds"（ISO 8601 UTC），
    与认证层签发 refresh 的有效期保持一致（config.toml [auth]）。
    账户存在性校验由仓库层 upsert_Device 保证（应用层校验），这里不重复。
    """
    if expires_at is None:
        ttl_seconds = Settings().refresh_token_ttl_seconds
        expires_at = (
            datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
        ).isoformat()
    AccountDevicesRepository(connection).upsert_Device(phone, device_id, expires_at)


def set_AccountPassword(connection, phone: str, password: str) -> None:
    """改密码：用 Argon2id 重新哈希后入库（复用 AccountsRepository.set_Password）。"""
    password_hash = PasswordService().hash(password)
    AccountsRepository(connection).set_Password(phone, password_hash)
    AccountDevicesRepository(connection).revoke_AllDevices(phone)


def set_AccountStatus(connection, phone: str, status: str) -> None:
    """停用/启用账户：停用后无法登录、已登录会话立即失效（docs §2.12）。"""
    AccountsRepository(connection).set_AccountStatus(phone, status)


def list_Devices(connection, phone: str) -> list:
    """列出某账户登记过的全部设备（供查看信任清单）。"""
    return AccountDevicesRepository(connection).list_Devices(phone)


def revoke_Device(connection, phone: str, device_id: str) -> None:
    """踢出设备：该设备已签发 token 立即失效（复用 revoke_Device）。"""
    AccountDevicesRepository(connection).revoke_Device(phone, device_id)


# ---------- 账户与库维护（新增维护子命令的纯函数） ----------

# delete_Account 的级联删除顺序：先删子表、最后删 accounts。
# chat_turns / operation_changes 没有 account_phone 列，经会话/操作主表定位。
_ACCOUNT_CASCADE = [
    ("chat_turns", "session_id IN (SELECT session_id FROM chat_sessions WHERE account_phone = ?)"),
    ("chat_sessions", "account_phone = ?"),
    ("operation_changes", "operation_id IN (SELECT operation_id FROM database_operations WHERE account_phone = ?)"),
    ("database_operations", "account_phone = ?"),
    ("work_orders", "account_phone = ?"),
    ("customer_code_mappings", "account_phone = ?"),
    ("customers", "account_phone = ?"),
    ("service_categories", "account_phone = ?"),
    ("account_devices", "account_phone = ?"),
    ("accounts", "phone = ?"),
]

# db-rows 支持的过滤列：列不存在时该过滤条件自动跳过。
_ROW_FILTERS = (
    ("account_phone", "phone"),
    ("sync_id", "sync_id"),
)


def list_Accounts(connection) -> list:
    """列出全部账户（phone / status / created_at），按创建时间升序。"""
    rows = connection.execute(
        "SELECT phone, status, created_at FROM accounts ORDER BY created_at ASC"
    ).fetchall()
    return [dict(row) for row in rows]


def delete_Account(connection, phone: str) -> dict[str, int]:
    """物理删除账户及其关联行（设备/业务/操作/聊天，账户维度全清）。

    返回各表删除行数；账户不存在时抛 ValueError（避免误以为已删除）。
    """
    account = AccountsRepository(connection).get_Account(phone)
    if account is None:
        raise ValueError(f"账户不存在: {phone}")
    deleted: dict[str, int] = {}
    for table, where in _ACCOUNT_CASCADE:
        cursor = connection.execute(f"DELETE FROM {table} WHERE {where}", (account.phone,))
        deleted[table] = cursor.rowcount
    return deleted


def list_Tables(connection) -> list:
    """列出全部业务表名与行数（排除 sqlite_ 内部表），供库维护排查。"""
    rows = connection.execute(
        "SELECT name FROM sqlite_master"
        " WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        " ORDER BY name"
    ).fetchall()
    tables: list[dict] = []
    for row in rows:
        name = row["name"]
        count = connection.execute(f"SELECT COUNT(*) AS n FROM {name}").fetchone()["n"]
        tables.append({"table": name, "rows": count})
    return tables


def list_Rows(
    connection,
    table: str,
    *,
    phone: str | None = None,
    sync_id: str | None = None,
    limit: int = 20,
) -> list:
    """按表查询具体数据行（JSON 输出），支持按 account_phone / sync_id 过滤。

    表名必须是库里真实存在的表（防 SQL 注入，白名单 = sqlite_master 实际表名）；
    目标表没有对应列时该过滤条件跳过；limit 收窄到 [1, 500]。
    """
    table_rows = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchall()
    if not table_rows:
        raise ValueError(f"表不存在: {table}")
    columns = [row["name"] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()]
    where: list[str] = []
    params: list[str] = []
    for column, param in _ROW_FILTERS:
        value = {"phone": phone, "sync_id": sync_id}[param]
        if value is not None and column in columns:
            where.append(f"{column} = ?")
            params.append(value)
    where_sql = f" WHERE {' AND '.join(where)}" if where else ""
    limit = max(1, min(limit, 500))
    rows = connection.execute(
        f"SELECT * FROM {table}{where_sql} LIMIT ?",
        params + [limit],
    ).fetchall()
    return [dict(row) for row in rows]


def _resolve_Password(args) -> str:
    """解析密码来源，避免明文留在 shell history / ps 输出：
    优先 --password 参数；否则读环境变量 CB_MANAGE_PASSWORD；
    再否则交互式输入（getpass，不回显）。"""
    if getattr(args, "password", None):
        return args.password
    from_env = os.environ.get("CB_MANAGE_PASSWORD")
    if from_env:
        return from_env
    return getpass.getpass("请输入密码: ")


def _connection():
    """打开数据库连接并确保表就绪（应用 schema 幂等建表）。"""
    settings = Settings()
    database = Database(settings.database_path)
    apply_schema(database)
    return database.connect()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Casual-bookkeeping 后台管理 CLI（本机使用）")
    sub = parser.add_subparsers(dest="command", required=True)

    # add-account：创建账户
    p_account = sub.add_parser("add-account", help="创建账户")
    p_account.add_argument("phone", help="11 位手机号")
    p_account.add_argument("--password", help="明文密码（缺省时读 CB_MANAGE_PASSWORD 或交互输入），将用 Argon2id 哈希入库")
    p_account.add_argument("--status", choices=["active", "disabled"], default="active")
    p_account.set_defaults(func=add_Account)

    # add-device：登记设备会话
    p_device = sub.add_parser("add-device", help="登记设备会话")
    p_device.add_argument("phone", help="所属账户手机号")
    p_device.add_argument("device_id", help="设备标识（dev- + 12 位十六进制）")
    p_device.add_argument("--expires-at", help="refresh 过期时间 ISO 8601，缺省 180 天后")
    p_device.set_defaults(func=add_Device)

    # set-password：改密码
    p_password = sub.add_parser("set-password", help="修改账户密码")
    p_password.add_argument("phone", help="11 位手机号")
    p_password.add_argument("--password", help="新密码（缺省时读 CB_MANAGE_PASSWORD 或交互输入），将用 Argon2id 哈希入库")
    p_password.set_defaults(func=set_AccountPassword)

    # set-account-status：停用/启用账户
    p_status = sub.add_parser("set-account-status", help="停用/启用账户")
    p_status.add_argument("phone", help="11 位手机号")
    p_status.add_argument("--status", required=True, choices=["active", "disabled"])
    p_status.set_defaults(func=set_AccountStatus)

    # list-devices：列出账户设备
    p_devices = sub.add_parser("list-devices", help="列出账户登记的设备")
    p_devices.add_argument("phone", help="11 位手机号")
    p_devices.set_defaults(func=list_Devices)

    # revoke-device：踢出设备
    p_revoke = sub.add_parser("revoke-device", help="踢出设备（会话立即失效）")
    p_revoke.add_argument("phone", help="11 位手机号")
    p_revoke.add_argument("device_id", help="设备标识（dev- + 12 位十六进制）")
    p_revoke.set_defaults(func=revoke_Device)

    # list-accounts：列出全部账户
    p_accounts = sub.add_parser("list-accounts", help="列出全部账户")
    p_accounts.set_defaults(func=list_Accounts)

    # delete-account：物理删除账户（--yes 防误删，级联清空关联行）
    p_delete = sub.add_parser("delete-account", help="物理删除账户及其关联行")
    p_delete.add_argument("phone", help="11 位手机号")
    p_delete.add_argument("--yes", action="store_true", required=True,
                          help="确认物理删除（不可恢复，会级联清空该账户全部数据）")
    p_delete.set_defaults(func=delete_Account)

    # db-tables：表与行数
    p_tables = sub.add_parser("db-tables", help="列出全部业务表与行数")
    p_tables.set_defaults(func=list_Tables)

    # db-rows：查具体数据行
    p_rows = sub.add_parser("db-rows", help="按表查询数据行（JSON 输出）")
    p_rows.add_argument("table", help="表名（如 work_orders / customers）")
    p_rows.add_argument("--phone", help="按 account_phone 过滤（列存在时生效）")
    p_rows.add_argument("--sync-id", help="按 sync_id 过滤（列存在时生效）")
    p_rows.add_argument("--limit", type=int, default=20, help="最多返回行数，范围 1-500")
    p_rows.set_defaults(func=list_Rows)

    args = parser.parse_args(argv)

    connection = _connection()
    try:
        if args.command == "add-account":
            args.func(connection, args.phone, _resolve_Password(args), args.status)
            print(f"账户已创建: {args.phone} (status={args.status})")
        elif args.command == "add-device":
            args.func(connection, args.phone, args.device_id, args.expires_at)
            print(f"设备已登记: {args.phone} / {args.device_id}")
        elif args.command == "set-password":
            args.func(connection, args.phone, _resolve_Password(args))
            print(f"密码已修改: {args.phone}")
        elif args.command == "set-account-status":
            args.func(connection, args.phone, args.status)
            print(f"账户状态已更新: {args.phone} → {args.status}")
        elif args.command == "list-devices":
            for device in args.func(connection, args.phone):
                print(f"  {device.device_id}  status={device.status}"
                      f"  expires={device.refresh_expires_at}")
        elif args.command == "revoke-device":
            args.func(connection, args.phone, args.device_id)
            print(f"设备已踢出: {args.phone} / {args.device_id}")
        elif args.command == "list-accounts":
            for account in args.func(connection):
                print(f"  {account['phone']}  status={account['status']}"
                      f"  created={account['created_at']}")
        elif args.command == "delete-account":
            deleted = args.func(connection, args.phone)
            for table, count in deleted.items():
                if count:
                    print(f"  已删除 {table}: {count} 行")
            print(f"账户已物理删除: {args.phone}")
        elif args.command == "db-tables":
            for table in args.func(connection):
                print(f"  {table['table']:<24} {table['rows']} 行")
        elif args.command == "db-rows":
            rows = args.func(connection, args.table, phone=args.phone,
                             sync_id=args.sync_id, limit=args.limit)
            print(json.dumps(rows, ensure_ascii=False, indent=2))
        connection.commit()
    except ValueError as exc:
        connection.rollback()
        print(f"错误: {exc}")
        raise SystemExit(1)
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


if __name__ == "__main__":
    main()
