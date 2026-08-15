import { describe, expect, it } from 'vitest'
import { formatChatTime } from './chatTime'

// 被测缝：formatChatTime 纯函数
// 验证：今天/昨天/更早日期的本地化显示格式，避免时间文案散落在组件里。

function iso(y: number, m: number, d: number, h: number, min: number): string {
  return new Date(y, m - 1, d, h, min).toISOString()
}

describe('formatChatTime', () => {
  it('今天返回「今天 HH:mm」', () => {
    expect(formatChatTime(iso(2026, 8, 15, 9, 5), new Date(2026, 7, 15, 12, 0))).toBe('今天 09:05')
  })

  it('昨天返回「昨天 HH:mm」', () => {
    expect(formatChatTime(iso(2026, 8, 14, 21, 30), new Date(2026, 7, 15, 12, 0))).toBe('昨天 21:30')
  })

  it('更早日期返回「MM-DD HH:mm」', () => {
    expect(formatChatTime(iso(2026, 7, 31, 8, 8), new Date(2026, 7, 15, 12, 0))).toBe('07-31 08:08')
  })
})
