"""缝 5：后台管理命令逻辑（manage.py 的核心动作）。

被测缝：manage.py 中独立的命令函数（add_Account / add_Device / delete_Account /
list_Accounts / list_Tables / list_Rows），它们接收连接，完成哈希、账户维护与
库行排查；argparse 参数解析和连接开关是薄壳，不测。
- add_Account：密码必须被 Argon2id 哈希后入库，绝不能存明文
- add_Device：登记设备会话，status 为 active；账户必须存在，否则拒绝
- delete_Account：物理删除账户并级联清空其设备/业务/操作/聊天行，不伤其他账户
- list_*：账户清单、表与行数、按过滤条件查具体数据行
"""

from datetime import datetime, timezone

import pytest

from backend.repositories.account_devices import AccountDevicesRepository
from backend.repositories.accounts import AccountsRepository
from backend.scripts.manage import (
    add_Account,
    add_Device,
    delete_Account,
    list_Accounts,
    list_Devices,
    list_Rows,
    list_Tables,
    revoke_Device,
    set_AccountPassword,
    set_AccountStatus,
)
from backend.services.password import PasswordService


def test_add_Account_hashes_password(connection):
    # 创建账户后：入库的不是明文，且能通过 Argon2id 校验
    add_Account(connection, "13800000000", "secret-password")

    account = AccountsRepository(connection).get_Account("13800000000")
    assert account is not None
    assert account.password_hash != "secret-password"
    assert PasswordService().verify(account.password_hash, "secret-password")


def test_add_Device_registers_active_with_future_expiry(connection):
    # 先建账户（add-Device 要求账户必须存在），再登记设备：
    # status 为 active，refresh 过期时间默认是未来时间（180 天后）
    add_Account(connection, "13800000000", "secret-password")
    add_Device(connection, "13800000000", "dev-a1b2c3d4e5f6")

    devices = AccountDevicesRepository(connection).list_Devices("13800000000")
    assert len(devices) == 1
    assert devices[0].device_id == "dev-a1b2c3d4e5f6"
    assert devices[0].status == "active"
    expires_at = datetime.fromisoformat(devices[0].refresh_expires_at)
    assert expires_at > datetime.now(timezone.utc)


def test_add_Device_rejects_missing_account(connection):
    # 账户不存在时：add-Device 必须拒绝，且不能留下任何设备行
    with pytest.raises(ValueError, match="账户不存在"):
        add_Device(connection, "13800000000", "dev-a1b2c3d4e5f6")

    assert AccountDevicesRepository(connection).list_Devices("13800000000") == []


def test_set_AccountPassword_rotates_hash(connection):
    # 改密码：新密码通过校验、旧密码失效（docs §2.12 密码处理）
    add_Account(connection, "13800000000", "old-password")
    set_AccountPassword(connection, "13800000000", "new-password")

    account = AccountsRepository(connection).get_Account("13800000000")
    assert account is not None
    assert PasswordService().verify(account.password_hash, "new-password")
    assert not PasswordService().verify(account.password_hash, "old-password")


def test_set_AccountStatus_disables_and_enables(connection):
    # 停用/启用：status 在 active 与 disabled 间切换（docs §2.12 删除账户=停用）
    add_Account(connection, "13800000000", "secret-password")
    set_AccountStatus(connection, "13800000000", "disabled")
    assert AccountsRepository(connection).get_Account("13800000000").status == "disabled"
    set_AccountStatus(connection, "13800000000", "active")
    assert AccountsRepository(connection).get_Account("13800000000").status == "active"


def test_list_Devices_returns_registered_devices(connection):
    # 列出某账户登记过的设备及状态
    add_Account(connection, "13800000000", "secret-password")
    add_Device(connection, "13800000000", "dev-a1b2c3d4e5f6")

    devices = list_Devices(connection, "13800000000")
    assert len(devices) == 1
    assert devices[0].device_id == "dev-a1b2c3d4e5f6"
    assert devices[0].status == "active"


def test_revoke_Device_kicks_device(connection):
    # 踢出设备：status 置为 revoked，已登录会话随之失效
    add_Account(connection, "13800000000", "secret-password")
    add_Device(connection, "13800000000", "dev-a1b2c3d4e5f6")

    revoke_Device(connection, "13800000000", "dev-a1b2c3d4e5f6")

    devices = AccountDevicesRepository(connection).list_Devices("13800000000")
    assert len(devices) == 1
    assert devices[0].status == "revoked"


# ---------- 新增维护命令（list-accounts / delete-account / db-tables / db-rows） ----------

_NOW = datetime.now(timezone.utc).isoformat()


def _seed_account_rows(connection, phone: str) -> None:
    """给账户铺满各账户维度表各一行（级联删除用；字面量数据，不复算实现）。"""
    suffix = phone[1:] + "00"
    connection.execute(
        "INSERT INTO account_devices"
        " (account_phone, device_id, status, refresh_expires_at, created_at, last_active_at)"
        " VALUES (?, ?, 'active', ?, ?, ?)",
        (phone, f"dev-{suffix}00000000", _NOW, _NOW, _NOW),
    )
    connection.execute(
        "INSERT INTO service_categories"
        " (account_phone, sync_id, category_name, subcategories_json, is_active,"
        " created_at, updated_at, row_version)"
        f" VALUES (?, 'sync-cat-{suffix}', '洗水', '[]', 1, ?, ?, 1)",
        (phone, _NOW, _NOW),
    )
    connection.execute(
        "INSERT INTO customers"
        " (account_phone, sync_id, customer_id, canonical_name, created_at, updated_at,"
        " archived_at, row_version)"
        f" VALUES (?, 'sync-cus-{suffix}', {-int(suffix)}, '张老板', ?, ?, NULL, 1)",
        (phone, _NOW, _NOW),
    )
    connection.execute(
        "INSERT INTO customer_code_mappings"
        " (account_phone, sync_id, customer_id, customer_code, customer_name, valid_from,"
        " valid_to, created_at, updated_at, row_version)"
        f" VALUES (?, 'sync-map-{suffix}', {-int(suffix)}, '001', '张老板',"
        " '2026-01-01', NULL, ?, ?, 1)",
        (phone, _NOW, _NOW),
    )
    connection.execute(
        "INSERT INTO work_orders"
        " (account_phone, sync_id, work_order_date, created_at, updated_at, deleted_at,"
        " customer_id, customer_code, customer_name, service_category, service_item,"
        " quantity, unit, unit_price_cents, is_completed, row_version)"
        f" VALUES (?, 'sync-wo-{suffix}', '2026-08-15', ?, ?, NULL, {-int(suffix)},"
        " '001', '张老板', '洗水', NULL, 10, '件', NULL, 0, 1)",
        (phone, _NOW, _NOW),
    )
    connection.execute(
        "INSERT INTO database_operations"
        " (operation_id, request_hash, result_json, account_phone, device_id, actor_type,"
        " source_turn_id, operation_type, reverts_operation_id, created_at)"
        f" VALUES ('op-{suffix}', 'hash', '{{}}', ?, NULL, 'user', NULL,"
        " 'create_work_order', NULL, ?)",
        (phone, _NOW),
    )
    connection.execute(
        "INSERT INTO operation_changes"
        " (operation_id, entity_type, entity_sync_id, change_type, before_version,"
        " after_version, before_json, after_json, changed_fields_json)"
        f" VALUES ('op-{suffix}', 'work_order', 'sync-wo-{suffix}',"
        " 'create', NULL, 1, NULL, '{}', '{}')",
    )
    connection.execute(
        "INSERT INTO chat_sessions (session_id, account_phone, title, created_at, updated_at)"
        f" VALUES ('s-{suffix}', ?, '会话', ?, ?)",
        (phone, _NOW, _NOW),
    )
    connection.execute(
        "INSERT INTO chat_turns (turn_id, session_id, messages_json, created_at, updated_at)"
        f" VALUES ('turn-{suffix}', 's-{suffix}', '[]', ?, ?)",
        (_NOW, _NOW),
    )


def test_list_Accounts_returns_all_accounts(connection):
    # 建两个账户后：list_Accounts 返回全部，含状态与创建时间
    add_Account(connection, "13800000000", "secret-password")
    add_Account(connection, "13900000000", "secret-password", status="disabled")

    accounts = list_Accounts(connection)
    assert [a["phone"] for a in accounts] == ["13800000000", "13900000000"]
    assert accounts[1]["status"] == "disabled"


def test_delete_Account_rejects_missing_account(connection):
    # 账户不存在：拒绝删除并报清晰错误，不静默成功
    with pytest.raises(ValueError, match="账户不存在"):
        delete_Account(connection, "13800000000")


def test_delete_Account_cascades_all_account_rows_and_keeps_others(connection):
    # 删除某账户：设备/四业务表/操作/聊天共 10 行级联清空；
    # 另一账户同构数据不受影响（字面量断言表清单，来自 manage._ACCOUNT_CASCADE）
    add_Account(connection, "13800000000", "secret-password")
    add_Account(connection, "13900000000", "secret-password")
    _seed_account_rows(connection, "13800000000")
    _seed_account_rows(connection, "13900000000")

    deleted = delete_Account(connection, "13800000000")

    assert deleted["accounts"] == 1
    assert deleted["account_devices"] == 1
    assert deleted["service_categories"] == 1
    assert deleted["customers"] == 1
    assert deleted["customer_code_mappings"] == 1
    assert deleted["work_orders"] == 1
    assert deleted["database_operations"] == 1
    assert deleted["operation_changes"] == 1
    assert deleted["chat_sessions"] == 1
    assert deleted["chat_turns"] == 1

    assert AccountsRepository(connection).get_Account("13800000000") is None
    assert AccountsRepository(connection).get_Account("13900000000") is not None
    counts = {t["table"]: t["rows"] for t in list_Tables(connection)}
    # 另一账户的 8 张账户维度表各剩 1 行（operation_changes / chat_turns 也各剩 1）
    assert counts["account_devices"] == 1
    assert counts["work_orders"] == 1
    assert counts["database_operations"] == 1
    assert counts["operation_changes"] == 1
    assert counts["chat_turns"] == 1


def test_list_Tables_reports_every_table_with_row_counts(connection):
    # 建表后：10 张业务表都在清单里，空表行数为 0
    tables = {t["table"]: t["rows"] for t in list_Tables(connection)}
    expected = {
        "accounts", "account_devices", "service_categories", "customers",
        "customer_code_mappings", "work_orders", "database_operations",
        "operation_changes", "chat_sessions", "chat_turns",
    }
    assert set(tables) == expected
    assert all(count == 0 for count in tables.values())


def test_list_Rows_filters_by_phone_and_sync_id_and_caps_limit(connection):
    # db-rows：按手机号/ sync_id 过滤，limit 收窄到 [1,500]；未知表拒绝
    add_Account(connection, "13800000000", "secret-password")
    _seed_account_rows(connection, "13800000000")

    rows = list_Rows(connection, "work_orders", phone="13800000000")
    assert len(rows) == 1
    assert rows[0]["sync_id"] == "sync-wo-380000000000"

    assert list_Rows(connection, "work_orders", sync_id="sync-none") == []
    assert len(list_Rows(connection, "work_orders", limit=500)) == 1

    with pytest.raises(ValueError, match="表不存在"):
        list_Rows(connection, "not_a_table")
