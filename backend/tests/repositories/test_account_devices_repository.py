"""缝 3：AccountDevicesRepository 受控读写接口（account_devices 表）。

被测缝：AccountDevicesRepository 的公开方法，全部通过接口验证，不碰裸 SQL。
覆盖三个方法：
- `list_Devices`：空账户 → 返回空列表（不是报错）
- `upsert_Device`：无则插入（新设备登记）、有则更新（刷新过期时间，不产生重复行）
- `revoke_Device`：把设备置为 revoked（踢出设备，行保留）
"""

from backend.repositories.account_devices import AccountDevicesRepository


def test_list_Devices_returns_empty_when_none(connection):
    # 没有登记过任何设备时，应返回空列表而不是报错
    repo = AccountDevicesRepository(connection)
    assert repo.list_Devices("13800000000") == []


def test_upsert_Device_inserts_when_missing(connection):
    # 设备第一次登录 → 插入新行，status 默认 active
    repo = AccountDevicesRepository(connection)
    repo.upsert_Device("13800000000", "dev-abc", "2027-01-01T00:00:00+00:00")

    devices = repo.list_Devices("13800000000")
    assert len(devices) == 1
    assert devices[0].device_id == "dev-abc"
    assert devices[0].status == "active"


def test_upsert_Device_updates_when_exists(connection):
    # 设备再次登录（刷新会话）→ 更新 refresh_expires_at，且不新增第二行
    repo = AccountDevicesRepository(connection)
    repo.upsert_Device("13800000000", "dev-abc", "2027-01-01T00:00:00+00:00")
    repo.upsert_Device("13800000000", "dev-abc", "2028-01-01T00:00:00+00:00")

    devices = repo.list_Devices("13800000000")
    assert len(devices) == 1
    assert devices[0].refresh_expires_at == "2028-01-01T00:00:00+00:00"


def test_revoke_Device_sets_status_revoked(connection):
    # 踢出设备 → status 从 active 变为 revoked（行保留，吊销语义，可追踪）
    repo = AccountDevicesRepository(connection)
    repo.upsert_Device("13800000000", "dev-abc", "2027-01-01T00:00:00+00:00")

    repo.revoke_Device("13800000000", "dev-abc")

    devices = repo.list_Devices("13800000000")
    assert len(devices) == 1
    assert devices[0].status == "revoked"
