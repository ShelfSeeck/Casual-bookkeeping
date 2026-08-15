import { ref } from 'vue'
import { ApiClient, clearActiveAccount, getActiveAccount, setActiveAccount } from './apiClient'
import { createBusinessDb } from '../db/db'

// AuthStore：前端会话状态（docs/auth-structure.md §2.9 / docs/sync-protocol.md §3）
// - 活跃账户身份持久化在 meta 库（设备级），离线可读，决定打开哪个业务库。
// - 失效（401/403）是会话态不持久化：onSessionInvalid 时仅置状态为未登录，
//   不清 meta 活跃账户、不清本地库（本地数据保留）。
// - 主动登出才清 meta 活跃账户 + access token。

export type AuthState =
  | { status: 'unknown'; accountPhone: string | null }
  | { status: 'signed_out'; accountPhone: null }
  | { status: 'signed_in'; accountPhone: string }

export interface AuthHooks {
  onLoginSuccess: (phone: string) => void | Promise<void>
  onSessionInvalid: () => void
}

/** AuthStore 对外暴露的公开接口（供组件 prop 使用，剥离私有 api/hooks 字段）。
 *  state 声明为展开后的 AuthState（而非 Ref），匹配模板里 ref 自动解包后的视图。 */
export interface AuthStorePublic {
  state: AuthState
  init: () => Promise<void>
  login: (phone: string, password: string) => Promise<void>
  logout: () => Promise<void>
  onSessionInvalid: () => void
}

export class AuthStore {
  state = ref<AuthState>({ status: 'unknown', accountPhone: null })
  private api: ApiClient
  private hooks: AuthHooks

  constructor(api: ApiClient, hooks: AuthHooks) {
    this.api = api
    this.hooks = hooks
  }

  /** 应用启动：读 meta 活跃账户 → 打开对应业务库；在线则 refresh 判活。 */
  async init(): Promise<void> {
    const phone = await getActiveAccount()
    if (!phone) {
      this.state.value = { status: 'signed_out', accountPhone: null }
      return
    }
    this.state.value = { status: 'signed_in', accountPhone: phone }
    createBusinessDb(phone)
    // 在线尝试 refresh 判活；失败由 onSessionInvalid 处理（不清本地数据）
    await this.api
      .refreshNow()
      .catch(() => this.hooks.onSessionInvalid())
  }

  async login(phone: string, password: string): Promise<void> {
    await this.api.login(phone, password)
    await setActiveAccount(phone)
    createBusinessDb(phone)
    this.state.value = { status: 'signed_in', accountPhone: phone }
    await this.hooks.onLoginSuccess(phone)
  }

  async logout(): Promise<void> {
    try {
      await this.api.logout()
    } finally {
      // 本地登出必须完成：服务端吊销失败时也不保留本地身份与 access
      await clearActiveAccount()
      this.state.value = { status: 'signed_out', accountPhone: null }
    }
  }

  /** 会话失效：仅置为未登录，保留本地数据（等重新登录恢复）。 */
  onSessionInvalid(): void {
    this.state.value = { status: 'signed_out', accountPhone: null }
    this.hooks.onSessionInvalid()
  }
}
