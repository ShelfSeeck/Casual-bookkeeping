// 数字输入即时校验工具：工单数量/单价等文本框共用。
// 双保险：
// 1. keydown 阶段直接阻止非法按键（字母、符号等不会进入输入框）；
// 2. input 阶段过滤兜底（覆盖粘贴/输入法等 keydown 拦不住的路径），
//    并返回“原始输入是否被改动”，供组件显示即时错误提示。

/** keydown 拦截：数量框只放行数字键与编辑/导航控制键；非法返回 false。 */
export function isAllowedIntegerKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true
  if (e.key.length === 1) return e.key >= '0' && e.key <= '9'
  return true // Backspace / Delete / Tab / 方向键 / Enter 等控制键
}

/** keydown 拦截：单价框放行数字、一个小数点与编辑/导航控制键；非法返回 false。 */
export function isAllowedDecimalKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true
  if (e.key.length === 1) {
    if (e.key >= '0' && e.key <= '9') return true
    if (e.key === '.') {
      const input = e.target as HTMLInputElement | null
      return input ? !input.value.includes('.') : true
    }
    return false
  }
  return true
}

/** 数量：只允许 0-9，空串合法（提交时再要求 > 0）。 */
export function sanitizeIntegerInput(value: string): string {
  return value.replace(/\D/g, '')
}

/** 单价：只允许数字和一个小数点；空串合法。 */
export function sanitizeDecimalInput(value: string): string {
  const cleaned = value.replace(/[^\d.]/g, '')
  const firstDot = cleaned.indexOf('.')
  if (firstDot === -1) return cleaned
  return cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '')
}

/** 是否为合法的正整数（提交时用于业务校验）。 */
export function isPositiveIntegerInput(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim())
}

/** 是否为合法单价文本（空串或 >= 0 的小数）。 */
export function isValidDecimalInput(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return true
  return /^\d+(\.\d+)?$/.test(trimmed)
}
