import { describe, expect, it } from 'vitest'
import {
  analyzeConflict,
  buildMergedPatch,
  stripWireMetaFields,
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

  it('ours-only 字段显式选 Theirs → 不写该字段（保持 Theirs）', () => {
    const analysis = analyzeConflict(BASE, OURS, THEIRS)
    // quantity 是 ours-only；用户显式决定采用 Theirs（即放弃我方改动）
    const patch = buildMergedPatch(analysis, { quantity: { source: 'theirs' } })
    expect(patch).toEqual({})
  })

  it('非冲突字段也可手填修改：resolution 中的额外字段进入 patch', () => {
    const analysis = analyzeConflict(BASE, OURS, THEIRS)
    // unit_price_cents 不在三方里（无差异），但用户仍可把它加进合并 patch
    const patch = buildMergedPatch(analysis, { unit_price_cents: { value: 1500 } })
    expect(patch).toEqual({ quantity: 9, unit_price_cents: 1500 })
  })

  it('theirs-only 字段显式选 Ours → 写 oursValue（用我方值覆盖 Theirs）', () => {
    const analysis = analyzeConflict(BASE, OURS, THEIRS)
    // unit / customer_code 是 theirs-only；用户显式决定采用 Ours（Base 中的值）
    const patch = buildMergedPatch(analysis, {
      unit: { source: 'ours' },
      customer_code: { source: 'ours' },
    })
    expect(patch).toEqual({ quantity: 9, unit: '件', customer_code: '001' })
  })

  it('ours-only 字段手填 {value} → 写入手填值', () => {
    const analysis = analyzeConflict(BASE, OURS, THEIRS)
    // quantity 是 ours-only；用户手填 10 应覆盖默认的 oursValue=9
    const patch = buildMergedPatch(analysis, { quantity: { value: 10 } })
    expect(patch).toEqual({ quantity: 10 })
  })

  it('theirs-only 字段手填 {value} → 写入手填值', () => {
    const analysis = analyzeConflict(BASE, OURS, THEIRS)
    // unit / customer_code 是 theirs-only；用户手填 unit=袋 应写入 patch 覆盖 Theirs
    const patch = buildMergedPatch(analysis, { unit: { value: '袋' } })
    expect(patch).toEqual({ quantity: 9, unit: '袋' })
  })

  it('ours-only / theirs-only 未显式决策时保持默认行为', () => {
    const analysis = analyzeConflict(BASE, OURS, THEIRS)
    expect(buildMergedPatch(analysis, {})).toEqual({ quantity: 9 })
    expect(buildMergedPatch(analysis, { unit: { source: 'theirs' } })).toEqual({ quantity: 9 })
  })
})

describe('stripWireMetaFields', () => {
  it('浅拷贝剔除账本元字段且不修改入参', () => {
    const record = {
      sync_id: 'sync-1',
      row_version: 5,
      updated_at: '2026-08-08T00:00:00Z',
      created_at: '2026-08-08T00:00:00Z',
      account_phone: '13800000000',
      work_order_id: 1,
      mapping_id: 2,
      service_category_id: 3,
      customer_id: 9,
      quantity: 9,
      unit: '件',
    }
    const stripped = stripWireMetaFields(record)

    // 内部主键列剔除；customer_id 是业务身份，保留
    expect(stripped).toEqual({ customer_id: 9, quantity: 9, unit: '件' })
    // 不修改入参
    expect(record.row_version).toBe(5)
    expect(record).toHaveProperty('sync_id')
    expect(record).toHaveProperty('work_order_id')
  })
})
