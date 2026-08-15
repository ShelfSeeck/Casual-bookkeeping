<script setup lang="ts">
defineProps<{
  type?: 'sync'
  value: 'synced' | 'pending' | 'conflict' | string
}>()
</script>

<template>
  <div
    class="cb-status-badge cb-status-sync"
    :class="`cb-status-sync--${value}`"
  >
    <span class="cb-status-dot"></span>
    <span class="cb-status-text">
      {{ value === 'synced' ? '已同步' : value === 'pending' ? '待同步' : '冲突' }}
    </span>
  </div>
</template>

<style scoped>
.cb-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.3;
}

/* 同步状态 */
.cb-status-sync--synced {
  background: var(--cb-status-success-bg);
  color: var(--cb-status-success-text);
}
.cb-status-sync--synced .cb-status-dot {
  background: var(--cb-status-success-text);
}

.cb-status-sync--pending {
  background: var(--cb-status-warning-bg);
  color: var(--cb-status-warning-text);
}
.cb-status-sync--pending .cb-status-dot {
  background: var(--cb-status-warning-text);
  animation: cb-pulse 1.5s infinite;
}

.cb-status-sync--conflict {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-error);
}
.cb-status-sync--conflict .cb-status-dot {
  background: var(--md-sys-color-error);
}

.cb-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

@keyframes cb-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
