import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, type SessionCallbacks } from './apiClient'

// 被测缝：ApiClient
// 验证（docs/sync-protocol.md §3.3）：
// 1. 401 → 静默 refresh → 用新 access 重试原请求一次
// 2. refresh 用 single-flight：并发多个 401 只发一次 refresh
// 3. refresh 失效（401/403）→ 触发 onSessionInvalid，本地数据保留由调用方决定
// 4. 请求带 Authorization: Bearer <access token>

const ACCESS = 'access-1'
const NEW_ACCESS = 'access-2'
const REFRESH_PATH = '/auth/refresh'

function mockFetchOnce(
  _path: string,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async json() {
      return body
    },
    async text(): Promise<string> {
      return typeof body === 'string' ? body : (JSON.stringify(body) ?? '')
    },
  }))
}

let callbacks: SessionCallbacks
let client: ApiClient

// vitest 默认 node 环境无 localStorage：用内存 mock
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

beforeEach(() => {
  const storage = makeStorage()
  vi.stubGlobal('localStorage', storage)
  callbacks = { onSessionInvalid: vi.fn() }
  client = new ApiClient(callbacks)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ApiClient', () => {
  it('请求携带 Authorization: Bearer access token', async () => {
    localStorage.setItem('cb_access_token', ACCESS)
    const fetchMock = mockFetchOnce('/api/ping', 200, { ok: true })
    vi.stubGlobal('fetch', fetchMock)

    await client.request('/api/ping')

    const [, init] = fetchMock.mock.calls[0]
    expect(new Headers(init?.headers as HeadersInit).get('Authorization')).toBe(
      `Bearer ${ACCESS}`,
    )
  })

  it('401 时静默 refresh 并用新 token 重试一次', async () => {
    localStorage.setItem('cb_access_token', ACCESS)
    let pingCalls = 0
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === '/api/ping') {
        pingCalls += 1
        if (pingCalls === 1) {
          // 第一次：access 过期 → 401
          return {
            ok: false,
            status: 401,
            headers: new Headers(),
            async json() {
              return { error_code: 'invalid_token' }
            },
            async text(): Promise<string> {
              return ''
            },
          }
        }
        // 重试：带新 token → 200
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          async json() {
            return { ok: true }
          },
          async text(): Promise<string> {
            return ''
          },
        }
      }
      if (url === REFRESH_PATH) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'set-cookie': 'refresh_token=new' }),
          async json() {
            return { access_token: NEW_ACCESS }
          },
          async text(): Promise<string> {
            return ''
          },
        }
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async json() {
          return { ok: true }
        },
        async text(): Promise<string> {
          return ''
        },
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    await client.request('/api/ping')

    // 原请求 1 次 + refresh 1 次 + 重试 1 次
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // 新 access 存 localStorage
    expect(localStorage.getItem('cb_access_token')).toBe(NEW_ACCESS)
  })

  it('并发多个 401 时 refresh 只发一次（single-flight）', async () => {
    localStorage.setItem('cb_access_token', ACCESS)
    let refreshCount = 0
    const called = new Set<string>()
    const fetchMock = vi.fn(async (url: string) => {
      if (url === REFRESH_PATH) {
        refreshCount += 1
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          async json() {
            return { access_token: NEW_ACCESS }
          },
          async text(): Promise<string> {
            return ''
          },
        }
      }
      if (called.has(url)) {
        // 重试（带新 token）→ 200
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          async json() {
            return { ok: true }
          },
          async text(): Promise<string> {
            return ''
          },
        }
      }
      called.add(url)
      // 第一次 → 401
      return {
        ok: false,
        status: 401,
        headers: new Headers(),
        async json() {
          return { error_code: 'invalid_token' }
        },
        async text(): Promise<string> {
          return ''
        },
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    await Promise.all([client.request('/a'), client.request('/b'), client.request('/c')])

    expect(refreshCount).toBe(1)
  })

  it('refresh 失效（401/403）触发 onSessionInvalid，不无限重试', async () => {
    localStorage.setItem('cb_access_token', ACCESS)
    const fetchMock = vi.fn(async (url: string) => {
      if (url === REFRESH_PATH) {
        return {
          ok: false,
          status: 403,
          headers: new Headers(),
          async json() {
            return { error_code: 'session_revoked' }
          },
          async text(): Promise<string> {
            return ''
          },
        }
      }
      return {
        ok: false,
        status: 401,
        headers: new Headers(),
        async json() {
          return { error_code: 'invalid_token' }
        },
        async text(): Promise<string> {
          return ''
        },
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(client.request('/api/ping')).rejects.toThrow()

    expect(callbacks.onSessionInvalid).toHaveBeenCalled()
    // 不无限重试：原请求最多 1 次 + refresh 1 次，没有第 2 轮循环
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('非 401 错误（如 500）不触发 refresh，直接抛错', async () => {
    localStorage.setItem('cb_access_token', ACCESS)
    const fetchMock = mockFetchOnce('/api/ping', 500, { error_code: 'server_error' })
    vi.stubGlobal('fetch', fetchMock)

    await expect(client.request('/api/ping')).rejects.toThrow()

    // refresh 从未被调用
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(callbacks.onSessionInvalid).not.toHaveBeenCalled()
  })
})
