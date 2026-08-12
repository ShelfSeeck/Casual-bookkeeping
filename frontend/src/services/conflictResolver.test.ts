import { describe, expect, it } from 'vitest'
import {
  analyzeConflict,
  autoMergePatch,
  buildMergedPatch,
} from './conflictResolver'

// 被测缝：冲突解析（docs/sync-protocol.md §7 三方对比）
// 验证：
// 1. 双方改不同字段 → 自动合并建议（autoMergable）
// 2. 双方改同一字段 → 需用户决策（autoMergable=false），决策 Ours/Theirs/手填生效
// 3. 生成合并 patch 相对 Theirs：theirs-only 不写、ours-only 写入、both 按决策
// 期望值来自 docs/sync-protocol.md §7 规则字面量。

// Base：修改前快照；Ours：Base+patch；Theirs：服务端当前状态
const BASE = { quantity: 5, unit: '件', customer_code: '001' }
const OURS = { quantity: 9, unit: '件', customer_code: '001' }
const THEIRS = { quantity: 5, unit: '套', customer_code: '002' }

describe('analyzeConflict', () => {
  it('双方改不同字段 → 可自动合并，差异分别标 ours-only / theirs-only', () => {
    const analysis = analyzeConflict(BASE, OURS, THEIRS)
    expect(analysis.autoMergable).toBe(true)
    const byField = Object.fromEntries(analysis.diffs.map((d) => [d.field, d.state]))
    // 我方改了 quantity，对方改了 unit 与 customer_code
    expect(byField).toEqual({
      quantity: 'ours-only',
      unit: 'theirs-only',
      customer_code: 'theirs-only',
    })
  })

  it('双方改同一字段 → 不可自动合并，标 both', () => {
    const theirs = { quantity: 6, unit: '件', customer_code: '001' }
    const analysis = analyzeConflict(BASE, OURS, theirs)
    expect(analysis.autoMergable).toBe(false)
    const quantity = analysis.diffs.find((d) => d.field === 'quantity')
    expect(quantity?.state).toBe('both')
    expect(quantity?.oursValue).toBe(9)
    expect(quantity?.theirsValue).toBe(6)
  })

  it('Ours 新增字段（Base 没有）视为 ours-only 变化', () => {
    // patch 新增字段：Base 无 unit_price_cents，Ours 有
    const analysis = analyzeConflict({ quantity: 5 }, { quantity: 5, unit_price_cents: 1250 }, { quantity: 5 })
    expect(analysis.autoMergable).toBe(true)
    expect(analysis.diffs).toEqual([
      {
        field: 'unit_price_cents',
        state: 'ours-only',
        baseValue: undefined,
        oursValue: 1250,
        theirsValue: undefined,
      },
    ])
  })
})

describe('buildMergedPatch', () => {
  it('不同字段：合并 patch 只含我方改动，theirs-only 不写（Theirs 已包含）', () => {
    const analysis = analyzeConflict(BASE, OURS, THEIRS)
    const patch = buildMergedPatch(analysis, {})
    expect(patch).toEqual({ quantity: 9 })
  })

  it('同字段：选 Ours / Theirs / 手填分别生效', () => {
    const theirs = { quantity: 6, unit: '件', customer_code: '001' }
    const analysis = analyzeConflict(BASE, OURS, theirs)
    expect(buildMergedPatch(analysis, { quantity: { source: 'ours' } })).toEqual({ quantity: 9 })
    expect(buildMergedPatch(analysis, { quantity: { source: 'theirs' } })).toEqual({ quantity: 6 })
    expect(buildMergedPatch(analysis, { quantity: { value: 7 } })).toEqual({ quantity: 7 })
  })

  it('同字段缺决策 → 抛错（不让半决策结果进 Push）', () => {
    const theirs = { quantity: 6, unit: '件', customer_code: '001' }
    const analysis = analyzeConflict(BASE, OURS, theirs)
    expect(() => buildMergedPatch(analysis, {})).toThrow(/quantity/)
  })
})

describe('autoMergePatch', () => {
  it('可自动合并时产出合并 patch；both 字段按 Ours 优先兜底', () => {
    const analysis = analyzeConflict(BASE, OURS, THEIRS)
    expect(autoMergePatch(analysis)).toEqual({ quantity: 9 })

    const both = analyzeConflict(BASE, OURS, { quantity: 6, unit: '件', customer_code: '001' })
    expect(autoMergePatch(both)).toEqual({ quantity: 9 })
  })
})
