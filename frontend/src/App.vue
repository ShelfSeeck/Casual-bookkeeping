<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import LoginView from './components/LoginView.vue'
import AppShell from './views/AppShell.vue'
import { ApiClient } from './services/apiClient'
import { AuthStore } from './services/authStore'
import { createBusinessDb } from './db/db'
import { HttpSyncApi } from './services/syncApi'
import { SyncManager } from './services/syncManager'
import { installSyncTriggers } from './services/syncTriggers'
import { ChatApi } from './services/chatApi'
import { appState } from './state/appState'

// shallowRef：不做深度 reactive 代理。AuthStore 内部持有 ref(state)；
// ref() 会把类实例代理化，LoginView 里 this.state 被解包成普通对象，
// login 中 this.state.value 的更新写不进真正的 ref（UI 永远停在登录页）。
const store = shallowRef<AuthStore | null>(null)
// 模板需要稳定追踪登录态；显式 computed 比模板链式解包（store.state.status）
// 更明确，避免登录成功/失效时界面不切换。
const isSignedIn = computed(() => store.value?.state.value.status === 'signed_in')
let api: ApiClient | null = null
let cleanupTriggers: (() => void) | null = null

function clearSyncTriggers(): void {
  cleanupTriggers?.()
  cleanupTriggers = null
}

onBeforeUnmount(() => {
  clearSyncTriggers()
})

// 账户离开已登录状态（登出/会话失效）时立即移除同步触发器，
// 避免旧账户的 syncManager 在新会话/登录页下继续被前台恢复、网络恢复触发。
watch(
  () => store.value?.state.value.status,
  (status) => {
    if (status !== 'signed_in') clearSyncTriggers()
  },
)

async function onAccountReady(phone: string) {
  if (!api) return
  // 必须先清掉旧账户触发器：后续 appState.init / syncManager.init 是异步窗口，
  // 不能让旧 syncManager 在新会话凭证下访问旧库。
  clearSyncTriggers()
  const db = createBusinessDb(phone)
  const syncManager = new SyncManager(
    db,
    new HttpSyncApi(api),
    { onStatusChange: () => {}, onDataChange: () => appState.reload() },
    { isCurrentAccount: () => store.value?.state.value.accountPhone === phone },
  )
  await appState.init(db, syncManager)
  // 启动 bootstrap/恢复同步：失败不阻塞本地页面（离线/首登无网时静默等待后续触发器）
  try {
    await syncManager.init()
  } catch {
    // ignore
  }
  // 异步初始化期间可能已登出/切换账户；只有当前仍是同一账户时才安装触发器。
  if (
    store.value?.state.value.status !== 'signed_in' ||
    store.value?.state.value.accountPhone !== phone
  ) {
    return
  }
  cleanupTriggers = installSyncTriggers(() => syncManager.sync())
  appState.initChat(new ChatApi(api))
  void appState.loadChatSessions()
}

onMounted(async () => {
  api = new ApiClient({
    onSessionInvalid: () => {
      clearSyncTriggers()
      store.value?.onSessionInvalid()
    },
  })
  const auth = new AuthStore(api, {
    onLoginSuccess: (phone) => {
      void onAccountReady(phone)
    },
    onSessionInvalid: () => {},
  })
  store.value = auth
  await auth.init()
  if (auth.state.value.status === 'signed_in' && auth.state.value.accountPhone) {
    await onAccountReady(auth.state.value.accountPhone)
  }
})
</script>

<template>
  <AppShell v-if="store && isSignedIn" />
  <LoginView v-else-if="store" :store="store" />
</template>
