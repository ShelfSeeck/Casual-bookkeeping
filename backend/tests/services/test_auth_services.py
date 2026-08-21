"""缝 6：认证领域服务单元测试（docs/auth-structure.md §3.3 用例 1-6）。

三个服务共用一个可控时钟（Clock）模拟过期/锁定，不依赖真实等待：
- PasswordService：Argon2id 哈希与校验（用例 2）
- TokenService：JWT 签发/验签/过期/类型校验（用例 3-5 / §2.5）
- RateLimiter：防刷计数与锁定（用例 6 / §2.11）
"""

from datetime import datetime, timezone

import pytest

from backend.services.password import PasswordService
from backend.services.rate_limiter import RateLimiter
from backend.services.token import (
    InvalidTokenError,
    TokenExpiredError,
    TokenService,
    TokenTypeError,
)

ACCESS_TTL = 24 * 3600
REFRESH_TTL = 180 * 24 * 3600
MAX_FAILURES = 5
LOCK_SECONDS = 900


class Clock:
    """可控时钟：__call__ 返回 UTC 时间，测试手动拨表模拟过期/锁定到期。"""

    def __init__(self, start_ts: float = 1_800_000_000) -> None:
        self.ts = start_ts

    def __call__(self) -> datetime:
        return datetime.fromtimestamp(self.ts, tz=timezone.utc)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def svc(clock):
    return TokenService(
        secret="test-secret-0123456789abcdef0123456789abcdef",
        access_ttl=ACCESS_TTL,
        refresh_ttl=REFRESH_TTL,
        now_factory=clock,
    )


@pytest.fixture
def limiter(clock):
    return RateLimiter(MAX_FAILURES, LOCK_SECONDS, now_factory=clock)


# ---------- PasswordService（§3.3 用例 2） ----------

def test_hash_is_not_plaintext():
    # 入库的值必须不是明文，且能通过校验
    hashed = PasswordService().hash("secret-password")
    assert hashed != "secret-password"
    assert PasswordService().verify(hashed, "secret-password") is True


def test_verify_rejects_wrong_password():
    hashed = PasswordService().hash("secret-password")
    assert PasswordService().verify(hashed, "wrong-password") is False


def test_same_password_hashes_differ():
    # Argon2id 带随机盐：同一密码两次哈希结果不同
    svc = PasswordService()
    assert svc.hash("secret-password") != svc.hash("secret-password")


def test_verify_returns_false_for_corrupt_hash():
    # 哈希损坏按校验失败处理，不抛异常
    assert PasswordService().verify("not-a-valid-hash", "secret-password") is False


# ---------- TokenService（§3.3 用例 3-5 / §2.5） ----------

def _decode_without_verify(token: str) -> dict:
    import jwt

    return jwt.decode(token, options={"verify_signature": False})


def test_sign_access_carries_claims(svc, clock):
    # access 签发：含 phone + device_id + token_type=access + exp（未来）
    token = svc.sign_access("13800000000", "dev-a1b2c3d4e5f6")
    payload = _decode_without_verify(token)
    assert payload["phone"] == "13800000000"
    assert payload["device_id"] == "dev-a1b2c3d4e5f6"
    assert payload["token_type"] == "access"
    assert payload["exp"] == clock.ts + ACCESS_TTL


def test_sign_refresh_carries_claims(svc, clock):
    # refresh 签发：除身份与 exp 外，必须有随机 jti 和令牌族供轮换/重放检测。
    token = svc.sign_refresh("13800000000", "dev-a1b2c3d4e5f6")
    payload = _decode_without_verify(token)
    assert payload["phone"] == "13800000000"
    assert payload["device_id"] == "dev-a1b2c3d4e5f6"
    assert payload["token_type"] == "refresh"
    assert payload["exp"] == clock.ts + REFRESH_TTL
    assert len(payload["jti"]) == 32
    assert len(payload["refresh_family_id"]) == 32


def test_verify_accepts_valid_access(svc):
    token = svc.sign_access("13800000000", "dev-a1b2c3d4e5f6")
    claims = svc.verify(token, "access")
    assert claims.phone == "13800000000"
    assert claims.device_id == "dev-a1b2c3d4e5f6"


def test_verify_accepts_valid_refresh(svc):
    token = svc.sign_refresh("13800000000", "dev-a1b2c3d4e5f6")
    claims = svc.verify(token, "refresh")
    assert claims.phone == "13800000000"
    assert claims.device_id == "dev-a1b2c3d4e5f6"
    assert claims.jti is not None
    assert claims.refresh_family_id is not None


def test_refresh_rotation_keeps_family_and_changes_jti(svc):
    first = svc.issue_pair("13800000000", "dev-a1b2c3d4e5f6")
    second = svc.issue_pair(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        refresh_family_id=first.refresh_family_id,
    )

    assert second.refresh_family_id == first.refresh_family_id
    assert second.refresh_jti != first.refresh_jti
    assert second.refresh_token != first.refresh_token
    assert svc.hash_refresh(second.refresh_token) != svc.hash_refresh(first.refresh_token)


def test_verify_rejects_forged_signature(svc):
    # 篡改 payload 后签名不匹配：拒绝
    token = svc.sign_access("13800000000", "dev-a1b2c3d4e5f6")
    parts = token.split(".")
    import base64
    import json

    payload = json.loads(
        base64.urlsafe_b64decode(parts[1] + "==").decode()
    )
    payload["phone"] = "13900000000"
    forged = parts[0] + "." + base64.urlsafe_b64encode(
        json.dumps(payload).encode()
    ).rstrip(b"=").decode() + "." + parts[2]

    with pytest.raises(InvalidTokenError):
        svc.verify(forged, "access")


def test_verify_rejects_expired(svc, clock):
    # 时钟越过 exp 后验签失败（用例 5 过期边界）
    token = svc.sign_access("13800000000", "dev-a1b2c3d4e5f6")
    clock.ts += ACCESS_TTL + 1
    with pytest.raises(TokenExpiredError):
        svc.verify(token, "access")


def test_verify_rejects_access_used_as_refresh(svc):
    # refresh 端点用 access 顶替 → 类型不符拒绝（§2.5 防误用）
    token = svc.sign_access("13800000000", "dev-a1b2c3d4e5f6")
    with pytest.raises(TokenTypeError):
        svc.verify(token, "refresh")


def test_verify_rejects_refresh_used_as_access(svc):
    # 鉴权端点用 refresh 顶替 → 类型不符拒绝（防止 refresh 被当 access 用）
    token = svc.sign_refresh("13800000000", "dev-a1b2c3d4e5f6")
    with pytest.raises(TokenTypeError):
        svc.verify(token, "access")


def test_verify_rejects_garbage(svc):
    with pytest.raises(InvalidTokenError):
        svc.verify("not-a-jwt", "access")


# ---------- RateLimiter（§3.3 用例 6 / §2.11） ----------

def test_not_locked_initially(limiter):
    assert limiter.is_locked("13800000000") is False


def test_not_locked_below_max_failures(limiter):
    for _ in range(MAX_FAILURES - 1):
        limiter.record_failure("13800000000")
    assert limiter.is_locked("13800000000") is False


def test_locked_after_max_failures(limiter):
    for _ in range(MAX_FAILURES):
        limiter.record_failure("13800000000")
    assert limiter.is_locked("13800000000") is True


def test_locks_are_per_key(limiter):
    # 不同手机号互不影响（文档：同一手机号）
    for _ in range(MAX_FAILURES):
        limiter.record_failure("13800000000")
    assert limiter.is_locked("13800000000") is True
    assert limiter.is_locked("13900000000") is False


def test_unlocked_after_lock_elapses(limiter, clock):
    # 锁定 15 分钟后（900 秒）自动解锁，且计数清零（重新开始计数）
    for _ in range(MAX_FAILURES):
        limiter.record_failure("13800000000")
    assert limiter.is_locked("13800000000") is True

    clock.ts += LOCK_SECONDS
    assert limiter.is_locked("13800000000") is False


def test_counter_resets_after_lock_elapses(limiter, clock):
    # 解锁后再失败 5 次才重新锁定（说明计数已归零，而非残留）
    for _ in range(MAX_FAILURES):
        limiter.record_failure("13800000000")
    clock.ts += LOCK_SECONDS
    limiter.is_locked("13800000000")

    for _ in range(MAX_FAILURES - 1):
        limiter.record_failure("13800000000")
    assert limiter.is_locked("13800000000") is False
    limiter.record_failure("13800000000")
    assert limiter.is_locked("13800000000") is True


def test_reset_clears_failures(limiter):
    # 登录成功后 reset：失败计数清空，不会触发锁定
    for _ in range(MAX_FAILURES - 1):
        limiter.record_failure("13800000000")
    limiter.reset("13800000000")
    assert limiter.is_locked("13800000000") is False


def test_delay_seconds_does_not_overflow_after_thousands_of_failures(limiter):
    key = "account:13800000000"
    for _ in range(5000):
        limiter.record_failure(key)
    assert limiter.delay_seconds(key, base=0.05, maximum=1.0) == 1.0


def test_delay_seconds_is_bounded_and_expires(limiter, clock):
    # 账户维度只做有上限的温和退避，不作为硬锁；窗口到期后自动清零。
    limiter.record_failure("account:13800000000")
    assert limiter.delay_seconds("account:13800000000", base=0.1, maximum=0.5) == 0.1
    for _ in range(5):
        limiter.record_failure("account:13800000000")
    assert limiter.delay_seconds("account:13800000000", base=0.1, maximum=0.5) == 0.5

    clock.ts += LOCK_SECONDS
    assert limiter.delay_seconds("account:13800000000", base=0.1, maximum=0.5) == 0.0

def test_prune_removes_stale_entries(limiter, clock):
    # 长期运行的进程不能让 _failures 无限增长：窗口（lock_seconds）过后
    # 未再失败的条目应可被 prune 清除；窗口内或仍锁定的条目保留。
    limiter.record_failure("stale")
    limiter.record_failure("fresh")
    clock.ts += LOCK_SECONDS + 1
    limiter.record_failure("fresh")

    limiter.prune()

    assert limiter.is_locked("stale") is False
    # fresh 仍在窗口内（刚失败过），计数保留：再失败到上限仍会锁
    for _ in range(MAX_FAILURES - 1):
        limiter.record_failure("fresh")
    assert limiter.is_locked("fresh") is True


def test_prune_keeps_locked_entries(limiter):
    # 锁定中的条目即使 prune 被调用也必须保留，否则锁可被 prune 绕过
    for _ in range(MAX_FAILURES):
        limiter.record_failure("locked")
    limiter.prune()
    assert limiter.is_locked("locked") is True


def test_prune_empty_map_is_noop(limiter):
    # 空表 prune 不报错
    limiter.prune()


# ---------- AuthService 登录持久化（登录响应与业务端点之间的竞态） ----------

def test_login_persists_device_before_returning(database, clock):
    # 验证什么：登录成功返回时设备登记必须已提交，客户端拿到 200 后立即
    # 请求业务端点（bootstrap）不会读到“会话不存在”而 403。
    # 为什么：AuthService 用请求级连接，统一 commit 在响应发送之后；若登录
    # 不显式提交，新连接在响应刚到达时看不到设备行。
    from backend.services.auth import AuthService
    from backend.repositories.account_devices import AccountDevicesRepository
    from backend.repositories.accounts import AccountsRepository

    tokens = TokenService(
        secret="test-secret-0123456789abcdef0123456789abcdef",
        access_ttl=ACCESS_TTL,
        refresh_ttl=REFRESH_TTL,
        now_factory=clock,
    )
    limiter = RateLimiter(MAX_FAILURES, LOCK_SECONDS, now_factory=clock)
    conn = database.connect()
    try:
        AccountsRepository(conn).create_Account(
            "13800000000", PasswordService().hash("secret-password"), "active"
        )
        conn.commit()
        auth = AuthService(
            AccountsRepository(conn),
            AccountDevicesRepository(conn),
            PasswordService(),
            tokens,
            limiter,
            now_factory=clock,
        )
        auth.login("13800000000", "secret-password", "dev-a1b2c3d4e5f6")
    finally:
        conn.close()

    # 登录返回后用另一条连接验证：设备组合已可见且 active
    fresh = database.connect()
    try:
        assert AccountDevicesRepository(fresh).get_ActiveSession(
            "13800000000", "dev-a1b2c3d4e5f6"
        ) is True
    finally:
        fresh.close()


def test_login_source_lock_cannot_be_bypassed_by_rotating_device_id(database, clock):
    # device_id 是未认证输入；轮换设备标识仍属于同一来源 IP + 账户限流桶。
    from backend.errors import AuthError
    from backend.repositories.account_devices import AccountDevicesRepository
    from backend.repositories.accounts import AccountsRepository
    from backend.services.auth import AuthService

    conn = database.connect()
    try:
        accounts = AccountsRepository(conn)
        accounts.create_Account(
            "13800000000", PasswordService().hash("secret-password"), "active"
        )
        conn.commit()
        auth = AuthService(
            accounts,
            AccountDevicesRepository(conn),
            PasswordService(),
            TokenService(
                secret="test-secret-0123456789abcdef0123456789abcdef",
                access_ttl=ACCESS_TTL,
                refresh_ttl=REFRESH_TTL,
                now_factory=clock,
            ),
            RateLimiter(MAX_FAILURES, LOCK_SECONDS, now_factory=clock),
            now_factory=clock,
            sleep_factory=lambda _seconds: None,
        )
        for index in range(5):
            with pytest.raises(AuthError) as wrong:
                auth.login(
                    "13800000000",
                    "wrong-password",
                    f"dev-{index:012x}",
                    source_ip="198.51.100.10",
                )
            assert wrong.value.error_code == "invalid_credentials"

        with pytest.raises(AuthError) as blocked:
            auth.login(
                "13800000000",
                "secret-password",
                "dev-ffffffffffff",
                source_ip="198.51.100.10",
            )
        assert blocked.value.error_code == "login_blocked"
    finally:
        conn.close()


def test_refresh_replay_revokes_the_current_token_family(database, clock):
    # 同一 refresh 第一次轮换成功；旧 token 再用视为重放并吊销整个当前族，
    # 因而刚签发的新 refresh 也必须随即失效。
    from backend.errors import AuthError
    from backend.repositories.account_devices import AccountDevicesRepository
    from backend.repositories.accounts import AccountsRepository
    from backend.services.auth import AuthService

    conn = database.connect()
    try:
        accounts = AccountsRepository(conn)
        devices = AccountDevicesRepository(conn)
        accounts.create_Account(
            "13800000000", PasswordService().hash("secret-password"), "active"
        )
        conn.commit()
        auth = AuthService(
            accounts,
            devices,
            PasswordService(),
            TokenService(
                secret="test-secret-0123456789abcdef0123456789abcdef",
                access_ttl=ACCESS_TTL,
                refresh_ttl=REFRESH_TTL,
                now_factory=clock,
            ),
            RateLimiter(MAX_FAILURES, LOCK_SECONDS, now_factory=clock),
            now_factory=clock,
            sleep_factory=lambda _seconds: None,
        )

        first = auth.login(
            "13800000000",
            "secret-password",
            "dev-a1b2c3d4e5f6",
            source_ip="198.51.100.10",
        )
        clock.ts += 60
        second = auth.refresh(first.refresh_token)

        with pytest.raises(AuthError) as replay:
            auth.refresh(first.refresh_token)
        assert replay.value.error_code == "session_revoked"

        with pytest.raises(AuthError) as family_revoked:
            auth.refresh(second.refresh_token)
        assert family_revoked.value.error_code == "session_revoked"
    finally:
        conn.close()
