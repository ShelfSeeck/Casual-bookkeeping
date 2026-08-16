// 冲突三方对比表的单元格格式化（ConflictCenter 使用）。
// 服务端快照里的布尔字段以 0/1 数字出现，本工具把 0/1 与 true/false
// 统一显示为「否/是」，避免对比表出现裸 0（业务列表已做同样归一化）。

export function isBooleanFieldName(field: string): boolean {
  return field === 'is_completed' || field === 'isCompleted'
}

export function isMoneyFieldName(field: string): boolean {
  return field === 'unit_price_cents' || field === 'unitPriceCents'
}

export function formatConflictCell(field: string, value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (isMoneyFieldName(field)) {
    const n =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number.parseFloat(value)
          : Number.NaN
    if (Number.isFinite(n)) return (n / 100).toFixed(2)
    return String(value)
  }
  if (isBooleanFieldName(field)) {
    if (value === true || value === 1 || value === '1' || value === '是') return '是'
    if (value === false || value === 0 || value === '0' || value === '否') return '否'
  }
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}
