"""缝 5：后台管理命令逻辑（manage.py 的核心动作）。

被测缝：manage.py 中独立的命令函数（add_Account / add_Device），它们接收连接，
完成"哈希密码 + 复用仓库写库"的业务动作；argparse 参数解析和连接开关是薄壳，不测。
- add_Account：密码必须被 Argon2id 哈希后入库，绝不能存明文
- add_Device：登记设备会话，status 为 active；账户必须存在，否则拒绝
"""

from datetime import datetime, timezone

import pytest
from argon2 import PasswordHasher

from backend.repositories.account_devices import AccountDevicesRepository
from backend.repositories.accounts import AccountsRepository
from backend.scripts.manage import add_Account, add_Device


def test_add_Account_hashes_password(connection):
    # 创建账户后：入库的不是明文，且能通过 Argon2id 校验
    add_Account(connection, "13800000000", "secret-password")

    account = AccountsRepository(connection).get_Account("13800000000")
    assert account is not None
    assert account.password_hash != "secret-password"
    assert PasswordHasher().verify(account.password_hash, "secret-password")


def test_add_Device_registers_active_with_future_expiry(connection):
    # 先建账户（add-Device 要求账户必须存在），再登记设备：
    # status 为 active，refresh 过期时间默认是未来时间（180 天后）
    add_Account(connection, "13800000000", "secret-password")
    add_Device(connection, "13800000000", "dev-abcd")

    devices = AccountDevicesRepository(connection).list_Devices("13800000000")
    assert len(devices) == 1
    assert devices[0].device_id == "dev-abcd"
    assert devices[0].status == "active"
    expires_at = datetime.fromisoformat(devices[0].refresh_expires_at)
    assert expires_at > datetime.now(timezone.utc)


def test_add_Device_rejects_missing_account(connection):
    # 账户不存在时：add-Device 必须拒绝，且不能留下任何设备行
    with pytest.raises(ValueError, match="账户不存在"):
        add_Device(connection, "13800000000", "dev-abcd")

    assert AccountDevicesRepository(connection).list_Devices("13800000000") == []
