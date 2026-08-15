<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
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

onBeforeUnmount(() => {
  cleanupTriggers?.()
})

async function onAccountReady(phone: string) {
  if (!api) return
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
  cleanupTriggers?.()
  cleanupTriggers = installSyncTriggers(() => syncManager.sync())
  appState.initChat(new ChatApi(api))
  void appState.loadChatSessions()
}

onMounted(async () => {
  api = new ApiClient({
    onSessionInvalid: () => {
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
