<script setup lang="ts">
import { computed } from 'vue'
import { appState } from '../../state/appState'

const activeUndo = computed(() => appState.activeUndo.value)

function handleUndo() {
  appState.performUndo()
}
</script>

<template>
  <Transition name="snackbar">
    <div
      v-if="activeUndo"
      class="cb-undo-snackbar"
      role="status"
      aria-live="polite"
    >
      <div class="cb-undo-content">
        <span class="cb-undo-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </span>
        <span class="cb-undo-text">{{ activeUndo.message }}</span>
      </div>
      <button
        class="cb-undo-btn cb-pressable"
        aria-label="撤回刚才的操作"
        @click="handleUndo"
      >
        撤回
      </button>
      <div class="cb-undo-progress-bar" aria-hidden="true"></div>
    </div>
  </Transition>
</template>

<style scoped>
.cb-undo-snackbar {
  position: fixed;
  bottom: calc(var(--cb-tabbar-height) + 16px + env(safe-area-inset-bottom, 0));
  left: 16px;
  right: 16px;
  max-width: 440px;
  margin: 0 auto;
  background: var(--md-sys-color-inverse-surface);
  color: var(--md-sys-color-inverse-on-surface);
  border-radius: var(--md-sys-shape-corner-small);
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: var(--md-sys-elevation-3);
  z-index: 999;
  overflow: hidden;
}

.cb-undo-content {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.cb-undo-icon {
  color: #34d399;
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.cb-undo-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cb-undo-btn {
  background: transparent;
  border: none;
  color: var(--md-sys-color-inverse-primary);
  font-weight: 700;
  font-size: 14px;
  padding: 6px 12px;
  border-radius: var(--md-sys-shape-corner-full);
  outline: none;
  flex-shrink: 0;
  margin-left: 8px;
  cursor: pointer;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-undo-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}

.cb-undo-progress-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 3px;
  background: var(--md-sys-color-inverse-primary);
  width: 100%;
  animation: countdown 5s linear forwards;
}

@keyframes countdown {
  from { width: 100%; }
  to { width: 0%; }
}

.snackbar-enter-active,
.snackbar-leave-active {
  transition: opacity var(--md-sys-motion-duration-medium) var(--md-sys-motion-easing-emphasized),
              transform var(--md-sys-motion-duration-medium) var(--md-sys-motion-easing-emphasized);
}

.snackbar-enter-from,
.snackbar-leave-to {
  opacity: 0;
  transform: translateY(16px) scale(0.96);
}
</style>
