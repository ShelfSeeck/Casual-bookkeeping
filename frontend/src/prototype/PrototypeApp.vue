<script setup lang="ts">
import './styles/design-tokens.css'
import { prototypeState } from './state/prototypeState'
import TabBar from './components/navigation/TabBar.vue'
import UndoSnackbar from './components/common/UndoSnackbar.vue'
import WorkOrderDesk from './components/desk/WorkOrderDesk.vue'
import LedgerView from './components/ledger/LedgerView.vue'
import AiChatView from './components/chat/AiChatView.vue'
import SettingsView from './components/settings/SettingsView.vue'
</script>

<template>
  <div class="cb-app-container">
    <!-- 主视图区域 -->
    <main class="cb-main-content">
      <WorkOrderDesk v-if="prototypeState.currentTab.value === 'desk'" />
      <LedgerView v-else-if="prototypeState.currentTab.value === 'ledger'" />
      <AiChatView v-else-if="prototypeState.currentTab.value === 'chat'" />
      <SettingsView v-else-if="prototypeState.currentTab.value === 'settings'" />
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
  max-width: 540px;
  width: 100%;
  margin: 0 auto;
  min-height: 100vh;
  min-height: 100dvh;
  box-sizing: border-box;
  background: var(--cb-bg-app);
}
</style>
