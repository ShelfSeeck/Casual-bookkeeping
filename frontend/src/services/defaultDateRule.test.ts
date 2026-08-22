// 被测缝：默认录入日期规则（设备级 localStorage 偏好，不参与同步）。
// 规则三选一：always_today（默认）/ always_yesterday / split（HH:mm 前记昨天、之后记今天）。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DEFAULT_DATE_RULE_KEY,
  parseDateRule,
  getDateRule,
  setDateRule,
  resolveDefaultOrderDate,
  type DateRule,
} from './defaultDateRule'
import { shiftLocalDate, localDateToday } from '../utils/localDate'

describe('defaultDateRule', () => {
  // node 环境：stub localStorage（参照 theme.test.ts 模式）
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
  })

  // 缝 1：parseDateRule 校验与兜底
  it('合法规则字符串原样返回', () => {
    expect(parseDateRule('always_today')).toEqual({ mode: 'always_today' })
    expect(parseDateRule({ mode: 'always_yesterday' })).toEqual({ mode: 'always_yesterday' })
    expect(parseDateRule({ mode: 'split', cutoff: '04:00' })).toEqual({ mode: 'split', cutoff: '04:00' })
  })

  it('非法/缺失值兜底为 always_today', () => {
    expect(parseDateRule(null)).toEqual({ mode: 'always_today' })
    expect(parseDateRule({ mode: 'nonsense' })).toEqual({ mode: 'always_today' })
    expect(parseDateRule(42)).toEqual({ mode: 'always_today' })
  })

  // 缝 2：getDateRule/setDateRule 持久化读写
  it('setDateRule 写入后 getDateRule 能读回', () => {
    setDateRule({ mode: 'always_yesterday' })
    expect(getDateRule()).toEqual({ mode: 'always_yesterday' })
    expect(store.get(DEFAULT_DATE_RULE_KEY)).toContain('always_yesterday')
  })

  it('split 规则带时刻可持久化；非法时刻读取时兜底', () => {
    const rule: DateRule = { mode: 'split', cutoff: '03:30' }
    setDateRule(rule)
    expect(getDateRule()).toEqual(rule)
    store.set(DEFAULT_DATE_RULE_KEY, JSON.stringify({ mode: 'split', cutoff: '99:99' }))
    expect(getDateRule()).toEqual({ mode: 'always_today' })
  })

  it('存储损坏时兜底为 always_today 不抛错', () => {
    store.set(DEFAULT_DATE_RULE_KEY, '{broken json')
    expect(getDateRule()).toEqual({ mode: 'always_today' })
  })

  // 缝 3：resolveDefaultOrderDate 三种模式的日期解析
  it('always_today 返回 now 所在当天', () => {
    expect(resolveDefaultOrderDate(new Date(2026, 7, 22, 10, 0), { mode: 'always_today' })).toBe('2026-08-22')
  })

  it('always_yesterday 返回前一天', () => {
    expect(resolveDefaultOrderDate(new Date(2026, 7, 22, 10, 0), { mode: 'always_yesterday' })).toBe(
      shiftLocalDate('2026-08-22', -1),
    )
  })

  it('split：切换点之前返回昨天（凌晨补录场景）', () => {
    const d = resolveDefaultOrderDate(
      new Date(2026, 7, 22, 3, 0),
      { mode: 'split', cutoff: '04:00' },
    )
    expect(d).toBe(shiftLocalDate('2026-08-22', -1))
  })

  it('split：切换点之后返回今天', () => {
    const d = resolveDefaultOrderDate(
      new Date(2026, 7, 22, 5, 0),
      { mode: 'split', cutoff: '04:00' },
    )
    expect(d).toBe('2026-08-22')
  })

  it('split：恰好等于切换点时返回今天（边界含右端）', () => {
    const d = resolveDefaultOrderDate(
      new Date(2026, 7, 22, 4, 0),
      { mode: 'split', cutoff: '04:00' },
    )
    expect(d).toBe('2026-08-22')
  })

  it('split 无 cutoff 时兜底为今天', () => {
    const d = resolveDefaultOrderDate(
      new Date(2026, 7, 22, 3, 0),
      { mode: 'split' },
    )
    expect(d).toBe('2026-08-22')
  })

  it('不传 rule 时从 localStorage 读（默认 always_today → 今天）', () => {
    expect(resolveDefaultOrderDate(new Date())).toBe(localDateToday())
  })
})
