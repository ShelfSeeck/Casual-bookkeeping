import { describe, expect, it } from 'vitest'
import { localDateToday } from './localDate'

// 被测缝：localDateToday 本地日期（终审前置项①）
// 验证：返回本地时区 YYYY-MM-DD，而不是 UTC toISOString 的日期。
// 为什么测这里：东八区凌晨 00:30 用 UTC 日期会差一天，归档收尾日期必须取本地日。
// 期望值用 new Date() 的本地 getFullYear/getMonth/getDate 字面量拼出（不是复算实现逻辑）。

describe('localDateToday', () => {
  it('返回 YYYY-MM-DD 且与本地年/月/日一致', () => {
    const d = new Date()
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(localDateToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(localDateToday()).toBe(expected)
  })
})
