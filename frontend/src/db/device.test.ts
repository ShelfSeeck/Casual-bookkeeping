import { beforeEach, describe, expect, it } from 'vitest'
import { getOrCreateDeviceId } from './device'
import { metaDb } from './db'

// 被测缝：device.ts 的 getOrCreateDeviceId()
// 验证：首次生成符合 dev- + 12位hex 格式；再次调用返回同一值（IndexedDB 持久化）。
// 为什么测这里：device_id 是设备级标识，跨账户、跨重启不变，是登录/同步的识别基础。

beforeEach(async () => {
  await metaDb.delete()
  await metaDb.open()
})

describe('getOrCreateDeviceId', () => {
  it('首次调用生成 dev- 前缀 + 12 位十六进制', async () => {
    const id = await getOrCreateDeviceId()
    expect(id).toMatch(/^dev-[0-9a-f]{12}$/)
  })

  it('再次调用返回同一个 id（持久化）', async () => {
    const first = await getOrCreateDeviceId()
    const second = await getOrCreateDeviceId()
    expect(second).toBe(first)
  })
})
