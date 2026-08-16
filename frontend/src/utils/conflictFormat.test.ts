import { describe, expect, it } from 'vitest'
import { formatConflictCell } from './conflictFormat'

// 被测缝：冲突中心三方对比表的单元格格式化（UI 回归发现服务端快照布尔值
// 以 0/1 数字出现，需与布尔 true/false 归一化为「是/否」）。

describe('formatConflictCell', () => {
  it('布尔字段 0/1 归一化为 否/是', () => {
    expect(formatConflictCell('is_completed', 0)).toBe('否')
    expect(formatConflictCell('is_completed', 1)).toBe('是')
    expect(formatConflictCell('isCompleted', 0)).toBe('否')
    expect(formatConflictCell('isCompleted', 1)).toBe('是')
  })

  it('布尔字段 true/false 归一化为 是/否', () => {
    expect(formatConflictCell('is_completed', true)).toBe('是')
    expect(formatConflictCell('is_completed', false)).toBe('否')
  })

  it('空值显示占位符', () => {
    expect(formatConflictCell('is_completed', null)).toBe('—')
    expect(formatConflictCell('quantity', undefined)).toBe('—')
  })

  it('金额字段按分转元显示两位小数', () => {
    expect(formatConflictCell('unit_price_cents', 190)).toBe('1.90')
    expect(formatConflictCell('unitPriceCents', 150)).toBe('1.50')
  })

  it('其他字段原样字符串化', () => {
    expect(formatConflictCell('quantity', 100)).toBe('100')
    expect(formatConflictCell('customer_name', '张老板')).toBe('张老板')
  })
})
