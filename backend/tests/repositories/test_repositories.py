"""repositories 层测试：账户仓库（缝 2）与设备仓库（缝 3）。

被测缝：两个仓库的公开方法及其领域校验函数，全部通过接口验证，不碰裸 SQL。
- 缝 2 AccountsRepository：
  get_Account（查无→None / 未规范化手机号可命中）、create_Account（规范化、查重）、
  set_AccountStatus；以及账户领域规则 normalize_Phone（docs §2.2 用例 A1）。
- 缝 3 AccountDevicesRepository：
  list_Devices、upsert_Device（无则插/有则更；账户存在性、device_id 格式、
  expires_at 格式校验）、revoke_Device；以及设备领域规则 validate_DeviceId（docs §2.7）。
"""

import pytest

from backend.repositories.account_devices import (
    AccountDevicesRepository,
    validate_DeviceId,
)
from backend.repositories.accounts import AccountsRepository, normalize_Phone


# ---------- 缝 2：AccountsRepository ----------

def test_get_Account_returns_None_when_missing(connection):
    # 空库里查一个不存在的手机号：应返回 None 而不是抛异常
    repo = AccountsRepository(connection)
    assert repo.get_Account("13800000000") is None


def test_create_Account_then_get_Account_finds_it(connection):
    # create_Account 建账户 → get_Account 能查到，手机号/密码哈希/状态都对得上
    repo = AccountsRepository(connection)
    repo.create_Account("13800000000", "hash-value", "active")

    account = repo.get_Account("13800000000")
    assert account is not None
    assert account.phone == "13800000000"
    assert account.password_hash == "hash-value"
    assert account.status == "active"


def test_create_Account_normalizes_phone(connection):
    # 带空格/+86 的手机号入库时统一归一化为 11 位（docs §2.2）
    repo = AccountsRepository(connection)
    repo.create_Account("+86 138 0000 0000", "hash-value", "active")

    assert repo.get_Account("13800000000") is not None


def test_create_Account_rejects_duplicate_phone(connection):
    # 重复创建同一手机号：拒绝并给出清晰错误（不是裸 sqlite 异常）
    repo = AccountsRepository(connection)
    repo.create_Account("13800000000", "hash-value", "active")

    with pytest.raises(ValueError, match="账户已存在"):
        repo.create_Account("13800000000", "another-hash", "active")


def test_get_Account_accepts_unnormalized_phone(connection):
    # 登录传入未规范化的手机号仍能查到（docs 测试用例 B11）
    repo = AccountsRepository(connection)
    repo.create_Account("13800000000", "hash-value", "active")

    assert repo.get_Account("+86 138 0000 0000") is not None


def test_set_AccountStatus_changes_status(connection):
    # set_AccountStatus 把 active 改成 disabled → 再查确认状态确实变了
    repo = AccountsRepository(connection)
    repo.create_Account("13800000000", "hash-value", "active")

    repo.set_AccountStatus("13800000000", "disabled")

    account = repo.get_Account("13800000000")
    assert account is not None
    assert account.status == "disabled"


def test_normalize_Phone_strips_spaces():
    # docs 用例 A1：去空格归一化
    assert normalize_Phone("138 0000 0000") == "13800000000"


def test_normalize_Phone_strips_plus86_prefix():
    # docs 用例 A1：去 +86 前缀归一化
    assert normalize_Phone("+8613800000000") == "13800000000"


def test_normalize_Phone_rejects_invalid():
    with pytest.raises(ValueError, match="非法手机号"):
        normalize_Phone("12345")


# ---------- 缝 3：AccountDevicesRepository ----------

def test_list_Devices_returns_empty_when_none(connection):
    # 没有登记过任何设备时，应返回空列表而不是报错
    repo = AccountDevicesRepository(connection)
    assert repo.list_Devices("13800000000") == []


def test_upsert_Device_inserts_when_missing(connection):
    # 设备第一次登录 → 插入新行，status 默认 active
    AccountsRepository(connection).create_Account(
        "13800000000", "hash-value", "active"
    )
    repo = AccountDevicesRepository(connection)
    repo.upsert_Device("13800000000", "dev-a1b2c3d4e5f6", "2027-01-01T00:00:00+00:00")

    devices = repo.list_Devices("13800000000")
    assert len(devices) == 1
    assert devices[0].device_id == "dev-a1b2c3d4e5f6"
    assert devices[0].status == "active"


def test_upsert_Device_rejects_missing_account(connection):
    # 账户不存在时：upsert_Device 必须拒绝，且不留下任何设备行
    repo = AccountDevicesRepository(connection)
    with pytest.raises(ValueError, match="账户不存在"):
        repo.upsert_Device("13800000000", "dev-a1b2c3d4e5f6", "2027-01-01T00:00:00+00:00")

    assert repo.list_Devices("13800000000") == []


def test_upsert_Device_rejects_bad_device_id(connection):
    # device_id 不符合 "dev- + 短 ID" 格式（docs §2.7）：拒绝
    AccountsRepository(connection).create_Account(
        "13800000000", "hash-value", "active"
    )
    repo = AccountDevicesRepository(connection)
    with pytest.raises(ValueError, match="非法 device_id"):
        repo.upsert_Device("13800000000", "bad-id", "2027-01-01T00:00:00+00:00")


def test_upsert_Device_rejects_bad_expires_at(connection):
    # refresh 过期时间必须是合法 ISO 8601 时间：非法则拒绝
    AccountsRepository(connection).create_Account(
        "13800000000", "hash-value", "active"
    )
    repo = AccountDevicesRepository(connection)
    with pytest.raises(ValueError, match="非法过期时间"):
        repo.upsert_Device("13800000000", "dev-a1b2c3d4e5f6", "not-a-time")


def test_upsert_Device_updates_when_exists(connection):
    # 设备再次登录（刷新会话）→ 更新 refresh_expires_at，且不新增第二行
    AccountsRepository(connection).create_Account(
        "13800000000", "hash-value", "active"
    )
    repo = AccountDevicesRepository(connection)
    repo.upsert_Device("13800000000", "dev-a1b2c3d4e5f6", "2027-01-01T00:00:00+00:00")
    repo.upsert_Device("13800000000", "dev-a1b2c3d4e5f6", "2028-01-01T00:00:00+00:00")

    devices = repo.list_Devices("13800000000")
    assert len(devices) == 1
    assert devices[0].refresh_expires_at == "2028-01-01T00:00:00+00:00"


def test_refresh_token_rotation_is_compare_and_swap(connection):
    # 当前 refresh 哈希只能原子替换一次；旧哈希再次使用不得覆盖新状态。
    AccountsRepository(connection).create_Account(
        "13800000000", "hash-value", "active"
    )
    repo = AccountDevicesRepository(connection)
    repo.upsert_Device(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        "2027-01-01T00:00:00+00:00",
        refresh_token_hash="old-hash",
        refresh_family_id="family-1",
        refresh_jti="jti-1",
    )

    assert repo.rotate_RefreshToken(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        expected_token_hash="old-hash",
        refresh_token_hash="new-hash",
        refresh_family_id="family-1",
        refresh_jti="jti-2",
        refresh_expires_at="2028-01-01T00:00:00+00:00",
    ) is True
    assert repo.rotate_RefreshToken(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        expected_token_hash="old-hash",
        refresh_token_hash="other-hash",
        refresh_family_id="family-1",
        refresh_jti="jti-3",
        refresh_expires_at="2028-01-01T00:00:00+00:00",
    ) is False

    device = repo.get_Device("13800000000", "dev-a1b2c3d4e5f6")
    assert device is not None
    assert device.refresh_token_hash == "new-hash"
    assert device.refresh_jti == "jti-2"


def test_revoke_refresh_family_does_not_revoke_newer_login_family(connection):
    # 旧登录族的 token 到达时不能误伤同设备后来重新登录得到的新族。
    AccountsRepository(connection).create_Account(
        "13800000000", "hash-value", "active"
    )
    repo = AccountDevicesRepository(connection)
    repo.upsert_Device(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        "2027-01-01T00:00:00+00:00",
        refresh_token_hash="new-hash",
        refresh_family_id="new-family",
        refresh_jti="new-jti",
    )

    assert repo.revoke_RefreshFamily(
        "13800000000", "dev-a1b2c3d4e5f6", "old-family"
    ) is False
    assert repo.get_ActiveSession("13800000000", "dev-a1b2c3d4e5f6") is True


def test_revoke_Device_sets_status_revoked(connection):
    # 踢出设备 → status 从 active 变为 revoked（行保留，吊销语义，可追踪）
    AccountsRepository(connection).create_Account(
        "13800000000", "hash-value", "active"
    )
    repo = AccountDevicesRepository(connection)
    repo.upsert_Device("13800000000", "dev-a1b2c3d4e5f6", "2027-01-01T00:00:00+00:00")

    repo.revoke_Device("13800000000", "dev-a1b2c3d4e5f6")

    devices = repo.list_Devices("13800000000")
    assert len(devices) == 1
    assert devices[0].status == "revoked"


def test_validate_DeviceId_accepts_dev_prefix_hex12():
    # 文档 §2.7 统一格式：dev- + 12 位十六进制（uuid4().hex[:12]）
    assert validate_DeviceId("dev-3a9f1c2e4b5d") == "dev-3a9f1c2e4b5d"


def test_validate_DeviceId_rejects_bad_format():
    # 缺前缀 / 缺后缀 / 长度不符 / 含非十六进制字符都是非法
    with pytest.raises(ValueError, match="非法 device_id"):
        validate_DeviceId("abc")
    with pytest.raises(ValueError, match="非法 device_id"):
        validate_DeviceId("dev-")
    with pytest.raises(ValueError, match="非法 device_id"):
        validate_DeviceId("dev-3a9f1c2e4b5d00")  # 13 位
    with pytest.raises(ValueError, match="非法 device_id"):
        validate_DeviceId("dev-3a9f1c2e4b5x")  # 含非 hex 字符


def test_get_ActiveSession_true_when_device_and_account_active(connection):
    # 设备组合 + 账户都 active → 会话有效（docs §2.14 第 5 步，一次 JOIN 往返）
    AccountsRepository(connection).create_Account(
        "13800000000", "hash-value", "active"
    )
    repo = AccountDevicesRepository(connection)
    repo.upsert_Device("13800000000", "dev-a1b2c3d4e5f6", "2027-01-01T00:00:00+00:00")

    assert repo.get_ActiveSession("13800000000", "dev-a1b2c3d4e5f6") is True


def test_get_ActiveSession_false_when_device_revoked(connection):
    # 设备被踢（revoked）→ 会话失效
    AccountsRepository(connection).create_Account(
        "13800000000", "hash-value", "active"
    )
    repo = AccountDevicesRepository(connection)
    repo.upsert_Device("13800000000", "dev-a1b2c3d4e5f6", "2027-01-01T00:00:00+00:00")
    repo.revoke_Device("13800000000", "dev-a1b2c3d4e5f6")

    assert repo.get_ActiveSession("13800000000", "dev-a1b2c3d4e5f6") is False


def test_get_ActiveSession_false_when_account_disabled(connection):
    # 账户停用（disabled）→ 已登录会话立即失效（docs 用例 B10）
    AccountsRepository(connection).create_Account(
        "13800000000", "hash-value", "active"
    )
    repo = AccountDevicesRepository(connection)
    repo.upsert_Device("13800000000", "dev-a1b2c3d4e5f6", "2027-01-01T00:00:00+00:00")
    AccountsRepository(connection).set_AccountStatus("13800000000", "disabled")

    assert repo.get_ActiveSession("13800000000", "dev-a1b2c3d4e5f6") is False


def test_get_ActiveSession_false_for_unknown_device(connection):
    # 设备从未登记 → 会话无效
    AccountsRepository(connection).create_Account(
        "13800000000", "hash-value", "active"
    )
    repo = AccountDevicesRepository(connection)
    assert repo.get_ActiveSession("13800000000", "dev-000000000000") is False
