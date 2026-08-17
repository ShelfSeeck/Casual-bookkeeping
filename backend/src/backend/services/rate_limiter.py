"""RateLimiter：登录防刷的内存计数（docs/auth-structure.md §2.11）。

同一 key 连续失败 max_failures 次后锁定 lock_seconds 秒，进程重启即重置。
账户维度可复用失败计数计算有上限的温和退避，但不必检查硬锁。
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
        # key -> [失败次数, 锁定截止时间（None 表示未锁定）, 最后失败时间]
        self._failures: dict[str, list] = {}

    def record_failure(self, key: str) -> None:
        # 记一次失败；达到上限即设置锁定截止时间（本次不锁，下次起被拦）
        now = self._now().timestamp()
        count, _lock_until, _updated_at = self._failures.setdefault(
            key, [0, None, now]
        )
        count += 1
        lock_until = now + self.lock_seconds if count >= self.max_failures else None
        self._failures[key] = [count, lock_until, now]

    def is_locked(self, key: str) -> bool:
        # 锁定期内返回 True；锁定时间到则自动解锁并清零（重新开始计数）
        entry = self._failures.get(key)
        if entry is None:
            return False
        _count, lock_until, _updated_at = entry
        if lock_until is None:
            return False
        if self._now().timestamp() < lock_until:
            return True
        self._failures.pop(key, None)
        return False

    def delay_seconds(self, key: str, *, base: float, maximum: float) -> float:
        """按失败次数返回指数退避秒数；只延迟、不拒绝，且有明确上限。"""
        entry = self._failures.get(key)
        if entry is None:
            return 0.0
        count, _lock_until, updated_at = entry
        if self._now().timestamp() >= updated_at + self.lock_seconds:
            self._failures.pop(key, None)
            return 0.0
        if base <= 0 or maximum <= 0:
            return 0.0
        # 先判断是否已达到上限，避免失败次数极大时先计算 2**n 再转浮点而溢出。
        ratio = maximum / base
        if ratio <= 1:
            return maximum
        exponent = count - 1
        from math import ceil, log2

        max_exponent = max(0, ceil(log2(ratio)))
        if exponent >= max_exponent:
            return maximum
        return base * (2 ** exponent)

    def reset(self, key: str) -> None:
        # 登录成功后清零，避免残留计数触发误锁/持续退避
        self._failures.pop(key, None)
