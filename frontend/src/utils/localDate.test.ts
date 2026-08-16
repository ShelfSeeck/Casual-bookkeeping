import { describe, expect, it, vi } from 'vitest'
import { localDateToday, shiftLocalDate } from './localDate'

// 被测缝：localDateToday 本地日期（终审前置项①）
// 验证：返回本地时区 YYYY-MM-DD，而不是 UTC toISOString 的日期。
// 为什么测这里：东八区凌晨 00:30 用 UTC 日期会差一天，归档收尾日期必须取本地日。
// 期望值为固定时钟下的字面量，不复算实现逻辑。

describe('localDateToday', () => {
  it('固定时钟下返回本地 YYYY-MM-DD 字面量', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 7, 16, 0, 30))
      expect(localDateToday()).toBe('2026-08-16')
    } finally {
      vi.useRealTimers()
    }
  })
})

// 被测缝：shiftLocalDate 本地日期偏移
// 验证：基于本地时区日历位移后重新拼出 YYYY-MM-DD，而不是用 UTC 或时间戳推算。
// 为什么测这里：工单台/详情编辑的“昨天/前天/近 N 天”快捷日期依赖日历日位移，跨月跨年必须正确。
// 期望值全部用字面量，不复算实现逻辑。

describe('shiftLocalDate', () => {
  it('返回字面量前一天', () => {
    expect(shiftLocalDate('2026-08-15', -1)).toBe('2026-08-14')
  })

  it('跨月前一天回到上月最后一天', () => {
    expect(shiftLocalDate('2026-08-01', -1)).toBe('2026-07-31')
  })

  it('跨年与零填充', () => {
    expect(shiftLocalDate('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftLocalDate('2026-03-09', -8)).toBe('2026-03-01')
  })

  it('不接受非法 base', () => {
    expect(() => shiftLocalDate('2026/08/15', 0)).toThrow()
    expect(() => shiftLocalDate('2026-02-30', 0)).toThrow()
    expect(() => shiftLocalDate('abcd-ef-gh', 0)).toThrow()
  })
})
