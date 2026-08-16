// 本地时区日期（终审前置项①）。
// 归档收尾等“业务日”必须取本地日；UTC toISOString().slice(0,10) 在东八区凌晨会差一天。

export function localDateToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
