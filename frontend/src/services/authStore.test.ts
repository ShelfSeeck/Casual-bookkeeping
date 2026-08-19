import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthStore, type AuthHooks } from './authStore'
import { ApiClient, clearActiveAccount, getActiveAccount, setActiveAccount } from './apiClient'
import { metaDb } from '../db/db'

// 被测缝：AuthStore（docs/auth-structure.md §2.9 / docs/sync-protocol.md §3）
// 验证：
// 1. init: 无活跃账户 → signed_out；有活跃账户 → signed_in 并 refresh 判活（失败转 signed_out）
// 2. login: 调用 api.login → 写入 metaDb → signed_in → 触发 onLoginSuccess
// 3. logout: 调用 api.logout → 清除 metaDb 活跃账户 → signed_out（即使 API 报错也强制本地登出）
// 4. onSessionInvalid: 仅置 signed_out，保留本地库

function makeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k) => store.get(k) ?? null,
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => void store.set(k, String(v)),
  }
}

describe('AuthStore 会话状态管理', () => {
  let hooks: AuthHooks
  let api: ApiClient

  beforeEach(async () => {
    vi.stubGlobal('localStorage', makeStorage())
    await metaDb.delete()
    await metaDb.open()

    hooks = {
      onLoginSuccess: vi.fn(),
      onSessionInvalid: vi.fn(),
    }
    api = new ApiClient({ onSessionInvalid: hooks.onSessionInvalid })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('init: meta 库无活跃账户时状态为 signed_out', async () => {
    const auth = new AuthStore(api, hooks)
    await auth.init()
    expect(auth.state.value).toEqual({ status: 'signed_out', accountPhone: null })
  })

  it('init: meta 库有活跃账户且 refresh 成功时状态为 signed_in', async () => {
    await setActiveAccount('13800000000')
    vi.spyOn(api, 'refreshNow').mockResolvedValue('access-1')

    const auth = new AuthStore(api, hooks)
    await auth.init()

    expect(auth.state.value).toEqual({ status: 'signed_in', accountPhone: '13800000000' })
    expect(api.refreshNow).toHaveBeenCalledTimes(1)
  })

  it('init: meta 库有活跃账户但 refresh 失败时触发 onSessionInvalid', async () => {
    await setActiveAccount('13800000000')
    vi.spyOn(api, 'refreshNow').mockRejectedValue(new Error('invalid_token'))

    const auth = new AuthStore(api, hooks)
    await auth.init()

    expect(hooks.onSessionInvalid).toHaveBeenCalledTimes(1)
    expect(auth.state.value).toEqual({ status: 'signed_out', accountPhone: null })
    // 失效不清本地 meta 活跃账户（docs §2.9：数据保留）
    expect(await getActiveAccount()).toBe('13800000000')
  })

  it('login: 成功写入 meta 活跃账户并触发 onLoginSuccess', async () => {
    vi.spyOn(api, 'login').mockResolvedValue('access-token-1')

    const auth = new AuthStore(api, hooks)
    await auth.login('13800000000', 'cb123456')

    expect(api.login).toHaveBeenCalledWith('13800000000', 'cb123456')
    expect(await getActiveAccount()).toBe('13800000000')
    expect(auth.state.value).toEqual({ status: 'signed_in', accountPhone: '13800000000' })
    expect(hooks.onLoginSuccess).toHaveBeenCalledWith('13800000000')
  })

  it('logout: 调用 api.logout，清除 meta 活跃账户并置为 signed_out', async () => {
    await setActiveAccount('13800000000')
    vi.spyOn(api, 'logout').mockResolvedValue()

    const auth = new AuthStore(api, hooks)
    auth.state.value = { status: 'signed_in', accountPhone: '13800000000' }

    await auth.logout()

    expect(api.logout).toHaveBeenCalledTimes(1)
    expect(await getActiveAccount()).toBeNull()
    expect(auth.state.value).toEqual({ status: 'signed_out', accountPhone: null })
  })

  it('logout: 服务端请求报错时，本地仍然清除活跃账户并置为 signed_out', async () => {
    await setActiveAccount('13800000000')
    vi.spyOn(api, 'logout').mockRejectedValue(new Error('network_error'))

    const auth = new AuthStore(api, hooks)
    auth.state.value = { status: 'signed_in', accountPhone: '13800000000' }

    await expect(auth.logout()).rejects.toThrow('network_error')

    expect(await getActiveAccount()).toBeNull()
    expect(auth.state.value).toEqual({ status: 'signed_out', accountPhone: null })
  })

  it('onSessionInvalid: 会话失效仅切状态，不清除 meta 活跃账户', async () => {
    await setActiveAccount('13800000000')
    const auth = new AuthStore(api, hooks)
    auth.state.value = { status: 'signed_in', accountPhone: '13800000000' }

    auth.onSessionInvalid()

    expect(auth.state.value).toEqual({ status: 'signed_out', accountPhone: null })
    expect(hooks.onSessionInvalid).toHaveBeenCalledTimes(1)
    expect(await getActiveAccount()).toBe('13800000000')
  })
})
