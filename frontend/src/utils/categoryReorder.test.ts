import { describe, expect, it } from 'vitest'
import { mergeCategoryOrders, reorderGlobalOrder } from './categoryReorder'

// 被测缝：大类两区拖拽后的全局顺序重算纯函数。
// 验证：把某一项移动到目标全局位置，其余项相对顺序保持不变；非法目标抛错。

describe('reorderGlobalOrder', () => {
  it('把中间项移动到开头', () => {
    expect(reorderGlobalOrder(['A', 'B', 'C', 'D'], 'C', 0)).toEqual([
      'C',
      'A',
      'B',
      'D',
    ])
  })

  it('把开头项移动到末尾', () => {
    expect(reorderGlobalOrder(['A', 'B', 'C', 'D'], 'A', 3)).toEqual([
      'B',
      'C',
      'D',
      'A',
    ])
  })

  it('向后移动时保持其他项相对顺序', () => {
    expect(reorderGlobalOrder(['A', 'B', 'C', 'D'], 'B', 2)).toEqual([
      'A',
      'C',
      'B',
      'D',
    ])
  })

  it('要移动的项不存在时抛错', () => {
    expect(() => reorderGlobalOrder(['A', 'B'], 'X', 0)).toThrow()
  })
})

describe('mergeCategoryOrders', () => {
  it('启用区重排后，停用区槽位保持不变', () => {
    // 全局旧顺序：A(启用)、B(停用)、C(启用)
    // 启用区从 [A,C] 拖成 [C,A]，停用区仍 [B]
    expect(mergeCategoryOrders(['A', 'B', 'C'], ['C', 'A'], ['B'])).toEqual([
      'C',
      'B',
      'A',
    ])
  })

  it('停用区重排后，启用区槽位保持不变', () => {
    // 全局旧顺序：A(启用)、B(停用)、C(启用)
    // 停用区从 [B] 拖成 [B]（单元素无变化），这里用多停用示例：
    // 旧全局 A(启用)、B(停用)、C(启用)、D(停用)
    // 停用区从 [B,D] 拖成 [D,B]
    expect(mergeCategoryOrders(['A', 'B', 'C', 'D'], ['A', 'C'], ['D', 'B'])).toEqual([
      'A',
      'D',
      'C',
      'B',
    ])
  })
})
