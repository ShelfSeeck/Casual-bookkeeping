<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import type { WorkOrderUi } from '../../types/ui'
import { appState } from '../../state/appState'
import { toErrorMessage } from '../../services/errorMessages'
import {
  isAllowedDecimalKey,
  isAllowedIntegerKey,
  sanitizeDecimalInput,
  sanitizeIntegerInput,
} from '../../utils/numericInput'

const props = defineProps<{
  order: WorkOrderUi
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

// 数量与单价编辑状态（直接依赖系统输入法）
const editQtyStr = ref(String(props.order.quantity))
const editPriceStr = ref(props.order.unitPriceCents != null ? (props.order.unitPriceCents / 100).toFixed(2) : '')
const qtyError = ref('')
const priceError = ref('')

// 历史轨迹展示
const showHistory = ref(false)

// 历史轨迹始终从 appState.workOrders 当前元素读取：loadOrderHistory 或 reload 后
// 即便旧 prop 对象已被替换，也能渲染到最新 history。
const orderHistory = computed(() => {
  const current = appState.workOrders.find((o) => o.orderId === props.order.orderId)
  return current?.history ?? []
})

async function refreshHistory() {
  try {
    await appState.loadOrderHistory(props.order.syncId ?? props.order.orderId)
  } catch (e) {
    showFailToast(toErrorMessage(e))
  }
}

onMounted(() => {
  void refreshHistory()
})

function toggleHistory() {
  showHistory.value = !showHistory.value
  if (showHistory.value) {
    void refreshHistory()
  }
}

watch(
  () => props.order.orderId,
  () => {
    editQtyStr.value = String(props.order.quantity)
    editPriceStr.value = props.order.unitPriceCents != null ? (props.order.unitPriceCents / 100).toFixed(2) : ''
    qtyError.value = ''
    priceError.value = ''
    showHistory.value = false
    void refreshHistory()
  },
)

function onQtyKeydown(e: KeyboardEvent) {
  if (!isAllowedIntegerKey(e)) {
    e.preventDefault()
    qtyError.value = '只能输入数字'
  }
}

function onQtyInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  const cleaned = sanitizeIntegerInput(raw)
  editQtyStr.value = cleaned
  qtyError.value = raw !== cleaned ? '只能输入数字' : ''
}

function onPriceKeydown(e: KeyboardEvent) {
  if (!isAllowedDecimalKey(e)) {
    e.preventDefault()
    priceError.value = '只能输入数字和小数点'
  }
}

function onPriceInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  const cleaned = sanitizeDecimalInput(raw)
  editPriceStr.value = cleaned
  priceError.value = raw !== cleaned ? '只能输入数字和小数点' : ''
}

function onQtyChange() {
  const qty = parseInt(editQtyStr.value, 10)
  if (!isNaN(qty) && qty > 0) {
    appState.updateWorkOrder(props.order.orderId, { quantity: qty })
  } else {
    editQtyStr.value = String(props.order.quantity)
  }
}

function onPriceChange() {
  if (editPriceStr.value.trim() === '') {
    appState.updateWorkOrder(props.order.orderId, { unitPriceCents: null })
  } else {
    const p = parseFloat(editPriceStr.value)
    if (!isNaN(p)) {
      appState.updateWorkOrder(props.order.orderId, { unitPriceCents: Math.round(p * 100) })
    } else {
      editPriceStr.value = props.order.unitPriceCents != null ? (props.order.unitPriceCents / 100).toFixed(2) : ''
    }
  }
}

async function handleDelete() {
  if (!confirm(`确定要删除【${props.order.customerDisplayName} - ${props.order.subcategoryName}】这张单吗？`)) {
    return
  }
  try {
    await appState.deleteWorkOrder(props.order.syncId ?? props.order.orderId)
    showSuccessToast('工单已删除')
    emit('close')
  } catch (e) {
    showFailToast(toErrorMessage(e))
  }
}

async function handleRevert(operationId: string) {
  if (!confirm('确定要撤回这次修改吗？撤回提交后需等待同步生效。')) {
    return
  }
  try {
    await appState.revertOrderOperation(operationId)
    await refreshHistory()
  } catch (e) {
    showFailToast(toErrorMessage(e))
  }
}
</script>

<template>
  <div class="cb-sheet-overlay" role="dialog" aria-modal="true" aria-label="工单快捷修改" @click.self="emit('close')">
    <div class="cb-sheet-panel">
      <!-- 顶部 M3 把手与关闭 -->
      <div class="cb-sheet-handle-bar">
        <div class="m3-sheet-handle-pill" aria-hidden="true"></div>
      </div>

      <!-- 单据核心摘要 -->
      <div class="cb-sheet-header">
        <div class="cb-sheet-cust-info">
          <span class="cb-sheet-code">{{ order.customerCode }}</span>
          <span class="cb-sheet-name">{{ order.customerDisplayName }}</span>
          <span class="cb-sheet-service">{{ order.categoryName }} · {{ order.subcategoryName }}</span>
        </div>
        <button class="cb-sheet-close cb-pressable" aria-label="关闭面板" @click="emit('close')">✕</button>
      </div>

      <!-- 快速修改卡：系统输入法直接唤起与浅下划线 -->
      <div class="cb-quick-edit-grid" role="group" aria-label="工单数值修改">
        <!-- 数量直输 -->
        <div class="m3-edit-card">
          <label for="edit-order-qty" class="m3-edit-label">数量 ({{ order.unit }})</label>
          <div class="m3-edit-underline-row">
            <input
              id="edit-order-qty"
              :value="editQtyStr"
              type="text"
              inputmode="numeric"
              pattern="[0-9]*"
              class="m3-edit-input cb-tabular-nums"
              placeholder="0"
              autocomplete="off"
              @keydown="onQtyKeydown"
              @input="onQtyInput"
              @blur="onQtyChange"
              @keyup.enter="onQtyChange"
            />
            <span class="m3-edit-unit">{{ order.unit }}</span>
          </div>
          <p v-if="qtyError" class="m3-edit-inline-error" role="alert">{{ qtyError }}</p>
          <div class="m3-edit-bottom-line"></div>
        </div>

        <!-- 单价直输 -->
        <div class="m3-edit-card">
          <label for="edit-order-price" class="m3-edit-label">单价 (元/{{ order.unit }})</label>
          <div class="m3-edit-underline-row">
            <span class="m3-edit-currency">¥</span>
            <input
              id="edit-order-price"
              :value="editPriceStr"
              type="text"
              inputmode="decimal"
              class="m3-edit-input cb-tabular-nums"
              placeholder="未定价"
              autocomplete="off"
              @keydown="onPriceKeydown"
              @input="onPriceInput"
              @blur="onPriceChange"
              @keyup.enter="onPriceChange"
            />
          </div>
          <p v-if="priceError" class="m3-edit-inline-error" role="alert">{{ priceError }}</p>
          <div class="m3-edit-bottom-line"></div>
        </div>
      </div>

      <!-- 次级操作入口 -->
      <div class="cb-sheet-actions-row">
        <button
          type="button"
          class="cb-action-pill cb-pressable"
          :aria-expanded="showHistory"
          @click="toggleHistory"
        >
          📜 {{ showHistory ? '收起历史' : '修改历史轨迹' }}
        </button>
        <button
          type="button"
          class="cb-action-pill cb-action-delete cb-pressable"
          aria-label="删除本张工单"
          @click="handleDelete"
        >
          🗑️ 删除单据
        </button>
      </div>

      <!-- 历史轨迹时间线展开 -->
      <div v-if="showHistory" class="cb-history-panel" aria-label="历史修改轨迹">
        <div class="cb-history-title">操作与修改轨迹</div>
        <div v-if="orderHistory.length === 0" class="cb-history-empty">
          暂无历史记录
        </div>
        <div v-else class="cb-history-list">
          <div v-for="h in orderHistory" :key="h.operationId" class="cb-history-item">
            <div class="cb-history-dot" aria-hidden="true"></div>
            <div class="cb-history-content">
              <div class="cb-history-summary">{{ h.summary }}</div>
              <div class="cb-history-meta">
                {{ h.timestamp }} · {{ h.device ?? '本机' }} · {{ h.actorType === 'ai' ? 'AI' : '本人' }}
              </div>
            </div>
            <button
              v-if="h.canRevert"
              type="button"
              class="cb-history-revert-btn cb-pressable"
              @click="handleRevert(h.operationId)"
            >
              撤回这次修改
            </button>
            <span v-else-if="h.operationType === 'revert_operation'" class="cb-history-revert-tag">
              撤回记录
            </span>
            <span v-else class="cb-history-revert-tag">已撤回</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cb-sheet-overlay {
  position: fixed;
  inset: 0;
  background: var(--cb-overlay);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 500;
}

.cb-sheet-panel {
  width: 100%;
  max-width: 500px;
  background: var(--md-sys-color-surface);
  border-radius: var(--md-sys-shape-corner-extra-large) var(--md-sys-shape-corner-extra-large) 0 0;
  padding: 12px 18px calc(24px + env(safe-area-inset-bottom, 0));
  box-shadow: var(--md-sys-elevation-4);
  max-height: 85vh;
  overflow-y: auto;
}

.cb-sheet-handle-bar {
  display: flex;
  justify-content: center;
  margin-bottom: 8px;
}

.m3-sheet-handle-pill {
  width: 36px;
  height: 4px;
  background: var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-full);
}

.cb-sheet-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.cb-sheet-cust-info {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.cb-sheet-code {
  background: var(--md-sys-color-on-surface);
  color: var(--md-sys-color-surface);
  font-family: var(--cb-font-numeric);
  font-size: 12px;
  font-weight: 800;
  padding: 2px 6px;
  border-radius: var(--md-sys-shape-corner-extra-small);
  flex-shrink: 0;
  line-height: 1.1;
}

.cb-sheet-name {
  font-size: 20px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cb-sheet-service {
  font-size: 14px;
  color: var(--md-sys-color-on-surface-variant);
  flex-shrink: 0;
}

.cb-sheet-close {
  background: var(--md-sys-color-surface-container);
  border: none;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: var(--md-sys-color-on-surface-variant);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
}

/* 快改卡：M3 Underline Field */
.cb-quick-edit-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 18px;
}

.m3-edit-card {
  background: var(--md-sys-color-surface-container-low);
  border-radius: var(--md-sys-shape-corner-medium);
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
}

.m3-edit-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface-variant);
  margin-bottom: 4px;
}

.m3-edit-underline-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.m3-edit-input {
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--cb-font-numeric);
  font-size: 26px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  padding: 4px 0 6px;
}

.m3-edit-unit,
.m3-edit-currency {
  font-size: 16px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface-variant);
  flex-shrink: 0;
}

.m3-edit-inline-error {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--md-sys-color-error);
}

.m3-edit-bottom-line {
  width: 100%;
  height: 2px;
  background-color: var(--md-sys-color-outline-variant);
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.m3-edit-card:focus-within .m3-edit-bottom-line {
  background-color: var(--md-sys-color-primary);
  height: 2.5px;
}

/* 状态切换大按钮 */
.cb-status-toggle-btn {
  width: 100%;
  height: 52px;
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: 16px;
  font-weight: 800;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
  box-shadow: var(--md-sys-elevation-2);
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-status-toggle-btn--done {
  background: var(--cb-status-success-text);
}

/* 次级操作 */
.cb-sheet-actions-row {
  display: flex;
  gap: 10px;
}

.cb-action-pill {
  flex: 1;
  height: 42px;
  background: var(--md-sys-color-surface);
  border: none;
  box-shadow: var(--md-sys-elevation-1);
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: 13px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
  cursor: pointer;
  transition: box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-action-pill:hover {
  box-shadow: var(--md-sys-elevation-2);
}

.cb-action-delete {
  color: var(--md-sys-color-error);
  background: var(--md-sys-color-error-container);
}

/* 历史轨迹 */
.cb-history-panel {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px dashed var(--md-sys-color-outline-variant);
}

.cb-history-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface-variant);
  margin-bottom: 10px;
}

.cb-history-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-left: 8px;
}

.cb-history-item {
  display: flex;
  gap: 10px;
  position: relative;
}

.cb-history-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--md-sys-color-primary);
  margin-top: 5px;
  flex-shrink: 0;
}

.cb-history-summary {
  font-size: 13px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
}

.cb-history-meta {
  font-size: 11px;
  color: var(--md-sys-color-outline);
}

.cb-history-content {
  flex: 1;
  min-width: 0;
}

.cb-history-revert-btn {
  align-self: center;
  flex-shrink: 0;
  height: 30px;
  padding: 0 10px;
  background: var(--md-sys-color-primary-container);
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 12px;
  font-weight: 700;
  color: var(--md-sys-color-on-primary-container);
  cursor: pointer;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-history-revert-btn:hover {
  background: var(--cb-accent-hover);
  color: var(--md-sys-color-on-primary);
}

.cb-history-revert-tag {
  align-self: center;
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 700;
  color: var(--md-sys-color-outline);
  background: var(--md-sys-color-surface-container);
  padding: 4px 8px;
  border-radius: var(--md-sys-shape-corner-full);
}
</style>
