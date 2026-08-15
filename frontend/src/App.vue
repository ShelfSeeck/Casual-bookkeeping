<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
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

const store = ref<AuthStore | null>(null)
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
  () => store.value?.state.status,
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
  const syncManager = new SyncManager(db, new HttpSyncApi(api), {
    onStatusChange: () => {},
  })
  await appState.init(db, syncManager)
  // 启动 bootstrap/恢复同步：失败不阻塞本地页面（离线/首登无网时静默等待后续触发器）
  try {
    await syncManager.init()
  } catch {
    // ignore
  }
  // 异步初始化期间可能已登出/切换账户；只有当前仍是同一账户时才安装触发器。
  if (
    store.value?.state.status !== 'signed_in' ||
    store.value?.state.accountPhone !== phone
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
  <AppShell v-if="store && store.state.status === 'signed_in'" />
  <LoginView v-else-if="store" :store="store" />
</template>
