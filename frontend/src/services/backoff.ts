// 网络错误退避（docs/sync-protocol.md §9）：
// 指数退避，首次 1s，×2，封顶 60s，加抖动；不设最大次数（断网无限退避等网络恢复）。
// backoffBase 返回无抖动的基数（可精确断言），backoff 在此基础上乘抖动因子。

export const BACKOFF_INITIAL_MS = 1000
export const BACKOFF_MAX_MS = 60_000

/** 退避基数：1s × 2^attempt，封顶 60s。attempt 为已失败次数（0 起）。 */
export function backoffBase(attempt: number): number {
  return Math.min(BACKOFF_INITIAL_MS * 2 ** attempt, BACKOFF_MAX_MS)
}

/** 退避时长：基数 × (0.5 ~ 1.5) 抖动，向下取整。rand 可注入以便测试。 */
export function backoff(attempt: number, rand: () => number = Math.random): number {
  const factor = 0.5 + rand()
  return Math.floor(backoffBase(attempt) * factor)
}
