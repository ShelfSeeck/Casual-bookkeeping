import { beforeEach, describe, expect, it } from 'vitest'
import { closeBusinessDb, createBusinessDb, currentBusinessDb } from './db'

// 被测缝：db.ts 业务库工厂（open/close/current）
// 验证：同一手机号返回同一实例（缓存复用）；关闭后可重新打开；未登录返回 null。
// 为什么测这里：切账户 = 关旧开新，工厂的缓存与关闭语义直接影响多账户切换。

beforeEach(async () => {
  await closeBusinessDb('13800000000')
})

describe('业务库工厂', () => {
  it('createBusinessDb 对同一手机号返回同一实例', () => {
    const a = createBusinessDb('13800000000')
    const b = createBusinessDb('13800000000')
    expect(a).toBe(b)
  })

  it('closeBusinessDb 关闭后 createBusinessDb 返回新实例', async () => {
    const a = createBusinessDb('13800000000')
    await closeBusinessDb('13800000000')
    const b = createBusinessDb('13800000000')
    expect(a).not.toBe(b)
  })

  it('currentBusinessDb 未登录（null）时返回 null，登录后返回该账户库', () => {
    expect(currentBusinessDb(null)).toBeNull()
    expect(currentBusinessDb('13800000000')).toBe(createBusinessDb('13800000000'))
  })
})
