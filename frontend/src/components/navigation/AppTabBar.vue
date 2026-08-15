<script setup lang="ts">
import { appState, type TabKey } from '../../state/appState'

const tabs = [
  {
    key: 'desk' as TabKey,
    label: '工单台',
    iconSvg: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  },
  {
    key: 'ledger' as TabKey,
    label: '查账本',
    iconSvg: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="13" y2="11"/></svg>`,
  },
  {
    key: 'chat' as TabKey,
    label: 'AI助手',
    iconSvg: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><circle cx="12" cy="10" r="1.2"/><circle cx="8" cy="10" r="1.2"/><circle cx="16" cy="10" r="1.2"/></svg>`,
  },
  {
    key: 'settings' as TabKey,
    label: '设置',
    iconSvg: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  },
]
</script>

<template>
  <nav class="cb-tabbar" role="navigation" aria-label="底部主导航">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      class="cb-tab-item cb-pressable"
      :class="{ 'cb-tab-item--active': appState.currentTab.value === tab.key }"
      :aria-label="tab.label"
      :aria-selected="appState.currentTab.value === tab.key"
      role="tab"
      @click="appState.setTab(tab.key)"
    >
      <div class="cb-tab-indicator">
        <div class="cb-tab-icon" v-html="tab.iconSvg"></div>
      </div>
      <span class="cb-tab-label">{{ tab.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.cb-tabbar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: var(--cb-tabbar-height);
  padding-bottom: env(safe-area-inset-bottom, 0);
  background: var(--md-sys-color-surface-container);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  display: flex;
  justify-content: space-around;
  align-items: center;
  z-index: 100;
  box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.05);
}

.cb-tab-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  padding: 6px 0 3px;
  color: var(--md-sys-color-on-surface-variant);
  outline: none;
  cursor: pointer;
}

.cb-tab-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 58px;
  height: 32px;
  border-radius: var(--md-sys-shape-corner-full);
  margin-bottom: 3px;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-tab-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.cb-tab-label {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--md-sys-color-on-surface-variant);
  transition: color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-tab-item--active .cb-tab-indicator {
  background: var(--md-sys-color-primary-container);
}

.cb-tab-item--active .cb-tab-icon {
  color: var(--md-sys-color-on-primary-container);
}

.cb-tab-item--active .cb-tab-label {
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}
</style>
