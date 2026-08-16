// 本地时区日期（终审前置项①）。
// 归档收尾等“业务日”必须取本地日；UTC toISOString().slice(0,10) 在东八区凌晨会差一天。

export function localDateToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

// 本地时区日期偏移：new Date(y, m-1, d + days) 会按本地日历日自动处理跨月/跨年/闰年，
// 重新用本地 getFullYear/getMonth/getDate 拼回 YYYY-MM-DD，避免 UTC 时区差一天。
export function shiftLocalDate(base: string, days: number): string {
  const m = DATE_RE.exec(base)
  if (!m) {
    throw new Error(`Invalid local date: ${base}`)
  }
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])

  const d = new Date(year, month - 1, day)
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    throw new Error(`Invalid local date: ${base}`)
  }

  const shifted = new Date(year, month - 1, day + days)
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`
}
