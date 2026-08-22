// 默认录入日期规则（设备级偏好，localStorage，不参与同步）。
// 场景：衣物处理厂常在凌晨整理并补录前一天的工单——
// "always_today" 始终默认今天；"always_yesterday" 始终默认昨天；
// "split" 每天 cutoff 时刻之前默认昨天、之后默认今天（含右端）。
// 存储损坏/字段非法一律兜底 always_today，不阻断录入。

import { shiftLocalDate } from '../utils/localDate'

export const DEFAULT_DATE_RULE_KEY = 'cb_default_date_rule'

export type DateRuleMode = 'always_today' | 'always_yesterday' | 'split'
export interface DateRule {
  mode: DateRuleMode
  /** split 模式的切换时刻 "HH:mm"（24 小时制）；恰好等于该时刻记今天 */
  cutoff?: string
}

const MODES: DateRuleMode[] = ['always_today', 'always_yesterday', 'split']
export const FALLBACK_RULE: DateRule = { mode: 'always_today' }
const CUTOFF_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export function parseDateRule(raw: unknown): DateRule {
  if (typeof raw !== 'object' || raw === null) return FALLBACK_RULE
  const obj = raw as Record<string, unknown>
  if (!MODES.includes(obj.mode as DateRuleMode)) return FALLBACK_RULE
  const mode = obj.mode as DateRuleMode
  if (mode === 'split') {
    if (typeof obj.cutoff === 'string' && CUTOFF_RE.test(obj.cutoff)) {
      return { mode, cutoff: obj.cutoff }
    }
    return FALLBACK_RULE
  }
  return { mode }
}

export function getDateRule(): DateRule {
  try {
    return parseDateRule(JSON.parse(localStorage.getItem(DEFAULT_DATE_RULE_KEY) ?? ''))
  } catch {
    return FALLBACK_RULE
  }
}

export function setDateRule(rule: DateRule): void {
  try {
    localStorage.setItem(DEFAULT_DATE_RULE_KEY, JSON.stringify(rule))
  } catch {
    // 隐私模式等场景下 localStorage 不可写：仅本次会话内生效。
  }
}

/**
 * 解析当前规则下的默认录入日期。
 * @param now 当前时间（测试注入用；生产传 new Date()）
 * @param rule 规则（缺省读 localStorage）
 */
export function resolveDefaultOrderDate(now: Date = new Date(), rule?: DateRule): string {
  const r = rule ?? getDateRule()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (r.mode === 'always_yesterday') return shiftLocalDate(today, -1)
  if (r.mode === 'split' && r.cutoff) {
    const [h, m] = r.cutoff.split(':').map(Number)
    const minutes = now.getHours() * 60 + now.getMinutes()
    if (minutes < h * 60 + m) return shiftLocalDate(today, -1)
  }
  return today
}
