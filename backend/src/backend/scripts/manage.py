"""后台管理 CLI：创建账户、登记设备等（仅后端本机使用，不走 API 认证）。

命令动作是独立的纯函数（add_Account / add_Device），接收连接、复用仓库；
argparse 只负责参数解析，main() 负责开连接、提交、打印结果。

用法（两种等价）：
    uv run python -m backend.scripts.manage add-account 13800000000 --password xxx
    uv run acs-manage add-account 13800000000 --password xxx
"""

import argparse
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


def set_AccountStatus(connection, phone: str, status: str) -> None:
    """停用/启用账户：停用后无法登录、已登录会话立即失效（docs §2.12）。"""
    AccountsRepository(connection).set_AccountStatus(phone, status)


def list_Devices(connection, phone: str) -> list:
    """列出某账户登记过的全部设备（供查看信任清单）。"""
    return AccountDevicesRepository(connection).list_Devices(phone)


def revoke_Device(connection, phone: str, device_id: str) -> None:
    """踢出设备：该设备已签发 token 立即失效（复用 revoke_Device）。"""
    AccountDevicesRepository(connection).revoke_Device(phone, device_id)


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
    p_device.add_argument("device_id", help="设备标识（dev- + 12 位十六进制）")
    p_device.add_argument("--expires-at", help="refresh 过期时间 ISO 8601，缺省 180 天后")
    p_device.set_defaults(func=add_Device)

    # set-password：改密码
    p_password = sub.add_parser("set-password", help="修改账户密码")
    p_password.add_argument("phone", help="11 位手机号")
    p_password.add_argument("--password", required=True, help="新密码，将用 Argon2id 哈希入库")
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

    args = parser.parse_args(argv)

    connection = _connection()
    try:
        if args.command == "add-account":
            args.func(connection, args.phone, args.password, args.status)
            print(f"账户已创建: {args.phone} (status={args.status})")
        elif args.command == "add-device":
            args.func(connection, args.phone, args.device_id, args.expires_at)
            print(f"设备已登记: {args.phone} / {args.device_id}")
        elif args.command == "set-password":
            args.func(connection, args.phone, args.password)
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
