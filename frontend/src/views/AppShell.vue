<script setup lang="ts">
import { computed } from 'vue'
import { appState } from '../state/appState'
import TabBar from '../components/navigation/AppTabBar.vue'
import UndoSnackbar from '../components/common/UndoSnackbar.vue'
import WorkOrderDesk from '../components/desk/WorkOrderDesk.vue'
import LedgerView from '../components/ledger/LedgerView.vue'
import AiChatView from '../components/chat/AiChatView.vue'
import SettingsView from '../components/settings/SettingsView.vue'
import type { AuthStore } from '../services/authStore'

const props = defineProps<{ store?: Pick<AuthStore, 'logout'> }>()

const views = {
  desk: WorkOrderDesk,
  ledger: LedgerView,
  chat: AiChatView,
  settings: SettingsView,
} as const

const currentView = computed(() => views[appState.currentTab.value as keyof typeof views] ?? WorkOrderDesk)
</script>

<template>
  <div class="cb-app-container">
    <!-- 主视图区域：Tab 切换时轻量淡入上移 -->
    <main class="cb-main-content">
      <Transition name="cb-tab" mode="out-in">
        <component :is="currentView" :key="appState.currentTab.value" :store="props.store" />
      </Transition>
    </main>

    <!-- 全局 5 秒即时撤回浮条 -->
    <UndoSnackbar />

    <!-- 底部 4-Tab 导航 -->
    <TabBar />
  </div>
</template>

<style scoped>
.cb-main-content {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
  max-width: 540px;
  width: 100%;
  margin: 0 auto;
  height: 100%;
  box-sizing: border-box;
  background: var(--cb-bg-app);
}
</style>
