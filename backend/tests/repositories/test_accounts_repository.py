"""缝 2：AccountsRepository 受控读写接口（accounts 表）。

被测缝：AccountsRepository 的公开方法，全部通过接口验证，不碰裸 SQL。
覆盖三个方法：
- `get_Account`：查不存在的手机号 → 返回 None（表示"没找到"，而不是报错）
- `create_Account`：建账户后能查到，且各字段正确
- `set_AccountStatus`：改状态后能查到新状态
"""

from backend.repositories.accounts import AccountsRepository


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


def test_set_AccountStatus_changes_status(connection):
    # set_AccountStatus 把 active 改成 disabled → 再查确认状态确实变了
    repo = AccountsRepository(connection)
    repo.create_Account("13800000000", "hash-value", "active")

    repo.set_AccountStatus("13800000000", "disabled")

    account = repo.get_Account("13800000000")
    assert account is not None
    assert account.status == "disabled"
