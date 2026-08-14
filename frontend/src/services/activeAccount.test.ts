import { beforeEach, describe, expect, it } from 'vitest'
import { clearActiveAccount, getActiveAccount, setActiveAccount } from './apiClient'
import { metaDb } from '../db/db'

// 被测缝：meta 库活跃账户身份存取（docs/auth-structure.md §2.9 / docs/sync-protocol.md §3.1）
// 验证：active account 是设备级持久状态，离线可读（决定打开哪个业务库）；
//       主动登出时清除；切账户时覆盖。

describe('meta 库活跃账户身份', () => {
  beforeEach(async () => {
    await metaDb.delete()
    await metaDb.open()
  })

  it('setActiveAccount 后 getActiveAccount 可读回', async () => {
    await setActiveAccount('13800000000')
    expect(await getActiveAccount()).toBe('13800000000')
  })

  it('clearActiveAccount 清除身份', async () => {
    await setActiveAccount('13800000000')
    await clearActiveAccount()
    expect(await getActiveAccount()).toBeNull()
  })

  it('切账户覆盖旧身份（一台设备同时一个活跃账户）', async () => {
    await setActiveAccount('13800000000')
    await setActiveAccount('13900000000')
    expect(await getActiveAccount()).toBe('13900000000')
  })
})
