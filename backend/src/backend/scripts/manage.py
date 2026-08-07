"""后台管理 CLI：创建账户、登记设备等（仅后端本机使用，不走 API 认证）。

命令动作是独立的纯函数（add_Account / add_Device），接收连接、复用仓库；
argparse 只负责参数解析，main() 负责开连接、提交、打印结果。

用法（两种等价）：
    uv run python -m backend.scripts.manage add-account 13800000000 --password xxx
    uv run acs-manage add-account 13800000000 --password xxx
"""

import argparse
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher

from backend.config import Settings
from backend.data.db import Database
from backend.data.schema import apply_schema
from backend.repositories.account_devices import AccountDevicesRepository
from backend.repositories.accounts import AccountsRepository

# refresh token 有效期：180 天（docs/auth-structure.md §2.5）
REFRESH_VALIDITY_DAYS = 180


def add_Account(connection, phone: str, password: str, status: str = "active") -> None:
    """创建账户：密码用 Argon2id 哈希后入库，绝不允许存明文。

    argon2.PasswordHasher 默认即 Argon2id（与认证文档定案一致）。
    """
    password_hash = PasswordHasher().hash(password)
    AccountsRepository(connection).create_Account(phone, password_hash, status)


def add_Device(
    connection,
    phone: str,
    device_id: str,
    expires_at: str | None = None,
) -> None:
    """登记设备会话：无则插入、有则更新（复用 upsert_Device）。

    refresh 过期时间缺省为"当前时间 + 180 天"（ISO 8601 UTC）。
    账户存在性校验由仓库层 upsert_Device 保证（应用层校验），这里不重复。
    """
    if expires_at is None:
        expires_at = (
            datetime.now(timezone.utc) + timedelta(days=REFRESH_VALIDITY_DAYS)
        ).isoformat()
    AccountDevicesRepository(connection).upsert_Device(phone, device_id, expires_at)


def _connection():
    """打开数据库连接并确保表就绪（应用 schema 幂等建表）。"""
    settings = Settings()
    database = Database(settings.database_path)
    apply_schema(database)
    return database.connect()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="AcS 后台管理 CLI（本机使用）")
    sub = parser.add_subparsers(dest="command", required=True)

    # add-account：创建账户
    p_account = sub.add_parser("add-account", help="创建账户")
    p_account.add_argument("phone", help="11 位手机号")
    p_account.add_argument("--password", required=True, help="明文密码，将用 Argon2id 哈希入库")
    p_account.add_argument("--status", choices=["active", "disabled"], default="active")
    p_account.set_defaults(func=add_Account)

    # add-device：登记设备会话
    p_device = sub.add_parser("add-device", help="登记设备会话")
    p_device.add_argument("phone", help="所属账户手机号")
    p_device.add_argument("device_id", help="设备标识（如 dev-xxx）")
    p_device.add_argument("--expires-at", help="refresh 过期时间 ISO 8601，缺省 180 天后")
    p_device.set_defaults(func=add_Device)

    args = parser.parse_args(argv)

    connection = _connection()
    try:
        if args.command == "add-account":
            args.func(connection, args.phone, args.password, args.status)
            print(f"账户已创建: {args.phone} (status={args.status})")
        elif args.command == "add-device":
            args.func(connection, args.phone, args.device_id, args.expires_at)
            print(f"设备已登记: {args.phone} / {args.device_id}")
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
