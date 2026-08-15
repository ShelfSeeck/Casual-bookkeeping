/**
 * 历史会话时间显示：本地时区。
 * 今天显示「今天 HH:mm」，昨天显示「昨天 HH:mm」，其他显示「MM-DD HH:mm」。
 */
export function formatChatTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const dayDiff = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86_400_000)

  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (dayDiff === 0) return `今天 ${hhmm}`
  if (dayDiff === 1) return `昨天 ${hhmm}`
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${hhmm}`
}
