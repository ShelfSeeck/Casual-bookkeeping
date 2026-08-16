import { describe, expect, it } from 'vitest'
import { backoff, backoffBase } from './backoff'

// 被测缝：退避计算（docs/sync-protocol.md §9 网络错误重试）
// 验证：首次 1s、×2、封顶 60s、加抖动（0.5~1.5 倍）、不设上限。
// 为什么测这里：退避是网络错误重试的节流依据，写错会把服务端打爆或让重试永远等不到。

describe('backoff', () => {
  it('backoffBase 首次 1s，每次 ×2', () => {
    // 文档字面量：首次 1s、×2
    expect(backoffBase(0)).toBe(1000)
    expect(backoffBase(1)).toBe(2000)
    expect(backoffBase(2)).toBe(4000)
  })

  it('backoffBase 封顶 60s，之后不再增长（不设上限）', () => {
    // 文档字面量：封顶 60s（不用实现常量，防止常量与实现一起改错）
    expect(backoffBase(6)).toBe(60000)
    expect(backoffBase(10)).toBe(60000)
  })

  it('backoff 在基数基础上加抖动（0.5~1.5 倍）', () => {
    expect(backoff(0, () => 0)).toBe(500)
    expect(backoff(0, () => 1)).toBe(1500)
    expect(backoff(6, () => 0.5)).toBe(60000)
  })
})
