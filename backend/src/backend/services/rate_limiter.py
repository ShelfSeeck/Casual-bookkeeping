"""RateLimiter：登录防刷的内存计数（docs/auth-structure.md §2.11）。

同一 key（手机号/IP）连续失败 max_failures 次后锁定 lock_seconds 秒，
进程重启即重置（不建表）。时钟可注入（now_factory），便于测试模拟锁定时间到。
"""

from datetime import datetime, timezone


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class RateLimiter:
    """按 key 记录失败次数与锁定截止时间，纯内存实现。"""

    def __init__(
        self,
        max_failures: int = 5,
        lock_seconds: int = 900,
        now_factory=_utc_now,
    ) -> None:
        self.max_failures = max_failures
        self.lock_seconds = lock_seconds
        self._now = now_factory
        # key -> [失败次数, 锁定截止时间（None 表示未锁定）]
        self._failures: dict[str, list] = {}

    def record_failure(self, key: str) -> None:
        # 记一次失败；达到上限即设置锁定截止时间（本次不锁，下次起被拦）
        count, _lock_until = self._failures.setdefault(key, [0, None])
        count += 1
        if count >= self.max_failures:
            lock_until = self._now().timestamp() + self.lock_seconds
            self._failures[key] = [count, lock_until]
        else:
            self._failures[key] = [count, None]

    def is_locked(self, key: str) -> bool:
        # 锁定期内返回 True；锁定时间到则自动解锁并清零（重新开始计数）
        entry = self._failures.get(key)
        if entry is None:
            return False
        count, lock_until = entry
        if lock_until is None:
            return False
        if self._now().timestamp() < lock_until:
            return True
        self._failures[key] = [0, None]
        return False

    def reset(self, key: str) -> None:
        # 登录成功后清零，避免残留计数触发误锁
        self._failures.pop(key, None)
