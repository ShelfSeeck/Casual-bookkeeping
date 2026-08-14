"""chat 端点公共 fixture：覆盖依赖的 TestClient + 登录辅助。

与 tests/sync/conftest.py 同套模式：dependency_overrides 替换 DB / TokenService /
RateLimiter / AuthService，并额外 override get_ChatService 注入 TestModel agent_factory，
业务逻辑（SSE 流、落库、摊平）由真实实现执行，不走真实模型。
"""

from datetime import datetime, timezone

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel

from backend.data.db import Database
from backend.data.schema import apply_schema
from backend.deps import (
    RefreshCookieConfig,
    get_AccountDevicesRepository,
    get_AccountsRepository,
    get_AuthService,
    get_ChatService,
    get_ChatSessionsRepository,
    get_ChatTurnsRepository,
    get_Database,
    get_RateLimiter,
    get_RefreshCookieConfig,
    get_TokenService,
)
from backend.main import app
from backend.repositories.account_devices import AccountDevicesRepository
from backend.repositories.accounts import AccountsRepository
from backend.services.auth import AuthService
from backend.services.chat import ChatService
from backend.services.password import PasswordService
from backend.services.rate_limiter import RateLimiter
from backend.services.token import TokenService

ACCESS_TTL = 24 * 3600
REFRESH_TTL = 180 * 24 * 3600
SECRET = "test-secret-0123456789abcdef0123456789abcdef"
PASSWORD = "secret-password"


class Clock:
    def __init__(self, start_ts: float = 1_800_000_000) -> None:
        self.ts = start_ts

    def __call__(self) -> datetime:
        return datetime.fromtimestamp(self.ts, tz=timezone.utc)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def test_database(tmp_path):
    db = Database(str(tmp_path / "test.db"))
    apply_schema(db)
    return db


@pytest.fixture
def client(test_database, clock):
    tokens = TokenService(SECRET, ACCESS_TTL, REFRESH_TTL, now_factory=clock)
    limiter = RateLimiter(5, 900, now_factory=clock)

    def _override_database():
        return test_database

    def _override_tokens():
        return tokens

    def _override_limiter():
        return limiter

    def _override_cookie():
        return RefreshCookieConfig(name="refresh_token", secure=False, max_age=REFRESH_TTL)

    def _override_auth(
        accounts: AccountsRepository = Depends(get_AccountsRepository),
        devices: AccountDevicesRepository = Depends(get_AccountDevicesRepository),
    ):
        return AuthService(
            accounts, devices, PasswordService(), tokens, limiter, now_factory=clock
        )

    def _override_chat(
        sessions=Depends(get_ChatSessionsRepository),
        turns=Depends(get_ChatTurnsRepository),
    ):
        # TestModel 固定输出 "success (no tool calls)"，避免打真接口
        def agent_factory() -> Agent:
            return Agent(TestModel(), name="test")

        return ChatService(sessions, turns, agent_factory=agent_factory)

    app.dependency_overrides[get_Database] = _override_database
    app.dependency_overrides[get_TokenService] = _override_tokens
    app.dependency_overrides[get_RateLimiter] = _override_limiter
    app.dependency_overrides[get_RefreshCookieConfig] = _override_cookie
    app.dependency_overrides[get_AuthService] = _override_auth
    app.dependency_overrides[get_ChatService] = _override_chat

    yield TestClient(app)

    app.dependency_overrides.clear()


@pytest.fixture
def seed_account(test_database):
    def _seed(phone: str = "13800000000", password: str = PASSWORD,
              status: str = "active") -> None:
        conn = test_database.connect()
        try:
            AccountsRepository(conn).create_Account(
                phone, PasswordService().hash(password), status
            )
            conn.commit()
        finally:
            conn.close()

    return _seed
