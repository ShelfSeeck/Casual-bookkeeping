<script setup lang="ts">
import { ref } from 'vue'
import { prototypeState } from '../../state/prototypeState'
import type { MockCustomer } from '../../mock/mockData'

const props = defineProps<{
  modelValue: number | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', id: number): void
}>()

const showMoreModal = ref(false)

function selectCustomer(c: MockCustomer) {
  emit('update:modelValue', c.customerId)
  showMoreModal.value = false
}
</script>

<template>
  <div class="cb-quick-cust-container">
    <div class="cb-section-label">常用客户</div>
    <div class="cb-cust-scroll-row">
      <button
        v-for="c in prototypeState.customers"
        :key="c.customerId"
        class="cb-cust-capsule cb-pressable"
        :class="{ 'cb-cust-capsule--active': modelValue === c.customerId }"
        @click="selectCustomer(c)"
      >
        <span class="cb-cust-code">{{ c.code }}</span>
        <span class="cb-cust-name">{{ c.displayName }}</span>
      </button>
      <button class="cb-cust-capsule cb-cust-more cb-pressable" @click="showMoreModal = true">
        + 更多
      </button>
    </div>

    <!-- 更多客户弹窗板 -->
    <div v-if="showMoreModal" class="cb-modal-overlay" @click.self="showMoreModal = false">
      <div class="cb-modal-content">
        <div class="cb-modal-header">
          <span class="cb-modal-title">选择客户</span>
          <button class="cb-modal-close" @click="showMoreModal = false">✕</button>
        </div>
        <div class="cb-cust-list">
          <div
            v-for="c in prototypeState.customers"
            :key="c.customerId"
            class="cb-cust-list-item cb-pressable"
            :class="{ 'cb-cust-list-item--active': modelValue === c.customerId }"
            @click="selectCustomer(c)"
          >
            <div class="cb-cust-info">
              <span class="cb-cust-badge">{{ c.code }}</span>
              <span class="cb-cust-fullname">{{ c.customerName }}</span>
            </div>
            <span class="cb-cust-short">({{ c.displayName }})</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cb-quick-cust-container {
  margin-bottom: 16px;
}

.cb-section-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--cb-text-sub);
  margin-bottom: 8px;
}

.cb-cust-scroll-row {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 4px;
  scrollbar-width: none;
}
.cb-cust-scroll-row::-webkit-scrollbar {
  display: none;
}

.cb-cust-capsule {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  min-height: 40px;
  background: var(--cb-surface);
  border: 1px solid var(--cb-border);
  border-radius: var(--cb-radius-full);
  white-space: nowrap;
  font-size: 14px;
  font-weight: 500;
  color: var(--cb-text-main);
  outline: none;
}

.cb-cust-code {
  font-size: 12px;
  font-weight: 700;
  color: var(--cb-text-sub);
}

.cb-cust-capsule--active {
  background: var(--cb-text-main);
  color: var(--cb-text-inverse);
  border-color: var(--cb-text-main);
}

.cb-cust-capsule--active .cb-cust-code {
  color: #93c5fd;
}

.cb-cust-more {
  background: var(--cb-surface-subtle);
  color: var(--cb-text-sub);
  border-style: dashed;
}

/* 弹窗板 */
.cb-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 1000;
}

.cb-modal-content {
  width: 100%;
  max-width: 500px;
  max-height: 70vh;
  background: var(--cb-surface);
  border-radius: var(--cb-radius-lg) var(--cb-radius-lg) 0 0;
  padding: 20px 16px calc(20px + env(safe-area-inset-bottom, 0));
  display: flex;
  flex-direction: column;
}

.cb-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.cb-modal-title {
  font-size: 17px;
  font-weight: 700;
}

.cb-modal-close {
  background: none;
  border: none;
  font-size: 18px;
  color: var(--cb-text-muted);
}

.cb-cust-list {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cb-cust-list-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
  border-radius: var(--cb-radius-md);
  border: 1px solid var(--cb-border);
  background: var(--cb-surface);
}

.cb-cust-list-item--active {
  border-color: var(--cb-accent);
  background: var(--cb-accent-subtle);
}

.cb-cust-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.cb-cust-badge {
  background: #e5e7eb;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 700;
}

.cb-cust-fullname {
  font-size: 15px;
  font-weight: 600;
}

.cb-cust-short {
  font-size: 13px;
  color: var(--cb-text-muted);
}
</style>
