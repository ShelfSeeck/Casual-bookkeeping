import { getOrCreateDeviceId } from '../db/device'
import { metaDb } from '../db/db'

// 统一 API client（docs/sync-protocol.md §3.3）
// 职责：
// - 所有请求自动带 Authorization: Bearer <access token>
// - 收到 401 → 静默调 /auth/refresh（cookie 自带）→ 用新 access 重试原请求一次
// - refresh 用 single-flight：并发多个 401 只发一次 refresh
// - refresh 失效（401/403）→ 触发 onSessionInvalid（调用方进登录页，本地数据保留）
// - 同步管理器不感知这些细节，只看到请求成功 / 抛错

export interface SessionCallbacks {
  /** 会话失效（被踢 / 停用 / refresh 过期）→ 调用方停同步、进登录页 */
  onSessionInvalid: () => void
}

const ACCESS_KEY = 'cb_access_token'

export class ApiClient {
  private callbacks: SessionCallbacks
  private refreshPromise: Promise<string | null> | null = null

  constructor(callbacks: SessionCallbacks) {
    this.callbacks = callbacks
  }

  getAccessToken(): string | null {
    return localStorage.getItem(ACCESS_KEY)
  }

  setAccessToken(token: string): void {
    localStorage.setItem(ACCESS_KEY, token)
  }

  clearAccessToken(): void {
    localStorage.removeItem(ACCESS_KEY)
  }

  async login(phone: string, password: string): Promise<{ accessToken: string }> {
    const deviceId = await getOrCreateDeviceId()
    const resp = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password, device_id: deviceId }),
    })
    if (!resp.ok) {
      throw await this.toAppError(resp)
    }
    const body = (await resp.json()) as { access_token: string }
    this.setAccessToken(body.access_token)
    return { accessToken: body.access_token }
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = this.getAccessToken()
    const headers = new Headers(init.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const resp = await fetch(path, { ...init, headers })

    if (resp.status === 401) {
      // 会话可能已过期：refresh 一次再重试原请求
      const newToken = await this.refresh()
      if (newToken) {
        const retryHeaders = new Headers(init.headers)
        retryHeaders.set('Authorization', `Bearer ${newToken}`)
        const retry = await fetch(path, { ...init, headers: retryHeaders })
        if (retry.status === 401) {
          // 新 access 仍被拒（极端场景）：按会话失效处理，避免无限重试
          const err = await this.toAppError(retry)
          this.handleSessionInvalid()
          throw err
        }
        if (!retry.ok) throw await this.toAppError(retry)
        return retry
      }
      throw new Error('session_invalid')
    }
    if (resp.status === 403) {
      // 设备被踢 / 账户停用：access 仍有效但会话已失效，不能当普通错误处理
      const err = await this.toAppError(resp)
      if (err.message === 'session_revoked' || err.message === 'account_disabled') {
        this.handleSessionInvalid()
      }
      throw err
    }
    if (!resp.ok) throw await this.toAppError(resp)
    return resp
  }

  async logout(): Promise<void> {
    try {
      const resp = await fetch('/auth/logout', { method: 'POST' })
      if (!resp.ok) throw await this.toAppError(resp)
    } finally {
      // 本地登出必须完成：即使服务端吊销失败，也不让旧 access 留在设备上
      this.clearAccessToken()
    }
  }

  /** 会话失效（被踢 / 停用 / refresh 过期）：清本地 access 并通知调用方。 */
  handleSessionInvalid(): void {
    this.clearAccessToken()
    this.callbacks.onSessionInvalid()
  }

  /** 主动刷新判活（应用启动时用）：失败抛错，由调用方决定是否视为会话失效。 */
  async refreshNow(): Promise<string> {
    const token = await this.refresh()
    if (!token) throw new Error('session_invalid')
    return token
  }

  // ---------- 私有 ----------

  private async refresh(): Promise<string | null> {
    // single-flight：并发多个 401 共享同一个 refresh Promise
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = null
      })
    }
    return this.refreshPromise
  }

  private async doRefresh(): Promise<string | null> {
    const resp = await fetch('/auth/refresh', { method: 'POST' })
    if (resp.status === 401 || resp.status === 403) {
      this.handleSessionInvalid()
      return null
    }
    if (!resp.ok) {
      throw new Error('refresh_failed')
    }
    const body = (await resp.json()) as { access_token: string }
    this.setAccessToken(body.access_token)
    return body.access_token
  }

  private async toAppError(resp: Response): Promise<Error> {
    try {
      const body = (await resp.json()) as { error_code?: string; message?: string }
      return new Error(body.error_code ?? `http_${resp.status}`)
    } catch {
      return new Error(`http_${resp.status}`)
    }
  }
}

// 活跃账户身份（meta 库，设备级）：离线时决定打开哪个业务库
export async function setActiveAccount(phone: string): Promise<void> {
  await metaDb.account.put({ key: 'active_account_phone', value: phone })
}

export async function getActiveAccount(): Promise<string | null> {
  const row = await metaDb.account.get('active_account_phone')
  return row?.value ?? null
}

export async function clearActiveAccount(): Promise<void> {
  await metaDb.account.delete('active_account_phone')
}
