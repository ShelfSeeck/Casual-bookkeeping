<script setup lang="ts">
import { computed, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { appState } from '../../state/appState'
import type { WorkOrderUi } from '../../types/ui'
import { toErrorMessage } from '../../services/errorMessages'
import {
  isAllowedDecimalKey,
  isAllowedIntegerKey,
  isPositiveIntegerInput,
  sanitizeDecimalInput,
  sanitizeIntegerInput,
} from '../../utils/numericInput'
import LedgerFilterBar from './LedgerFilterBar.vue'
import WorkOrderCard from './WorkOrderCard.vue'
import WorkOrderDetailEdit from './WorkOrderDetailEdit.vue'

const activeOrderId = ref<string | null>(null)

const activeOrder = computed(() => {
  return appState.workOrders.find((o) => o.orderId === activeOrderId.value) ?? null
})

function openOrderDetail(order: WorkOrderUi) {
  activeOrderId.value = order.orderId
}

function closeOrderDetail() {
  activeOrderId.value = null
}

// ---------- 批量定价：多选模式 ----------
const selectionMode = ref(false)
const selectedOrderIds = ref<string[]>([])

const selectedCount = computed(() => selectedOrderIds.value.length)

function enterSelectionMode() {
  selectionMode.value = true
  selectedOrderIds.value = []
}

function exitSelectionMode() {
  selectionMode.value = false
  selectedOrderIds.value = []
}

function toggleSelectionMode() {
  if (selectionMode.value) {
    exitSelectionMode()
  } else {
    enterSelectionMode()
  }
}

function isSelected(order: WorkOrderUi) {
  return selectedOrderIds.value.includes(order.orderId)
}

function toggleSelection(order: WorkOrderUi) {
  selectedOrderIds.value = isSelected(order)
    ? selectedOrderIds.value.filter((id) => id !== order.orderId)
    : [...selectedOrderIds.value, order.orderId]
}

function onCardClick(order: WorkOrderUi) {
  if (selectionMode.value) {
    toggleSelection(order)
  } else {
    openOrderDetail(order)
  }
}

// ---------- 批量设价 Bottom Sheet ----------
const showBatchPriceSheet = ref(false)
const batchQtyStr = ref('')
const batchPriceStr = ref('')
const batchQtyError = ref('')
const batchPriceError = ref('')

function openBatchPriceSheet() {
  if (selectedOrderIds.value.length === 0) {
    showFailToast('请先勾选要定价的工单')
    return
  }
  batchQtyStr.value = ''
  batchPriceStr.value = ''
  batchQtyError.value = ''
  batchPriceError.value = ''
  showBatchPriceSheet.value = true
}

function closeBatchPriceSheet() {
  showBatchPriceSheet.value = false
}

function onBatchQtyKeydown(e: KeyboardEvent) {
  if (!isAllowedIntegerKey(e)) {
    e.preventDefault()
    batchQtyError.value = '只能输入数字'
  }
}

function onBatchQtyInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  const cleaned = sanitizeIntegerInput(raw)
  batchQtyStr.value = cleaned
  batchQtyError.value = raw !== cleaned ? '只能输入数字' : ''
}

function onBatchPriceKeydown(e: KeyboardEvent) {
  if (!isAllowedDecimalKey(e)) {
    e.preventDefault()
    batchPriceError.value = '只能输入数字和小数点'
  }
}

function onBatchPriceInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  const cleaned = sanitizeDecimalInput(raw)
  batchPriceStr.value = cleaned
  batchPriceError.value = raw !== cleaned ? '只能输入数字和小数点' : ''
}

async function confirmBatchPrice() {
  const qtyRaw = batchQtyStr.value.trim()
  const priceRaw = batchPriceStr.value.trim()
  batchQtyError.value = ''
  batchPriceError.value = ''

  if (qtyRaw === '' && priceRaw === '') {
    showFailToast('请至少填写数量或单价')
    return
  }

  let quantity: number | undefined
  if (qtyRaw !== '') {
    if (!isPositiveIntegerInput(qtyRaw)) {
      batchQtyError.value = '数量必须是正整数'
      showFailToast('数量必须是正整数')
      return
    }
    quantity = parseInt(qtyRaw, 10)
  }

  let unitPriceCents: number | null | undefined
  if (priceRaw !== '') {
    if (!/^\d+(\.\d{1,2})?$/.test(priceRaw)) {
      batchPriceError.value = '请输入有效单价（最多两位小数）'
      showFailToast('请输入有效单价（最多两位小数）')
      return
    }
    unitPriceCents = Math.round(parseFloat(priceRaw) * 100)
  }

  const selectedOrders = appState.workOrders.filter((o) =>
    selectedOrderIds.value.includes(o.orderId),
  )
  if (selectedOrders.length === 0) {
    showFailToast('请先勾选要定价的工单')
    return
  }

  const targets = selectedOrders.map((o) => {
    const target: { syncId: string; quantity?: number; unitPriceCents?: number | null } = {
      syncId: o.syncId ?? o.orderId,
    }
    if (quantity !== undefined) target.quantity = quantity
    if (unitPriceCents !== undefined) target.unitPriceCents = unitPriceCents
    return target
  })

  try {
    await appState.batchPrice(targets)
    showSuccessToast(`已为 ${selectedOrders.length} 单批量定价`)
    closeBatchPriceSheet()
    exitSelectionMode()
  } catch (e) {
    showFailToast(toErrorMessage(e))
  }
}
</script>

<template>
  <div class="cb-ledger-view">
    <!-- 1. 独立全屏工单详情与编辑页面 -->
    <WorkOrderDetailEdit
      v-if="activeOrder"
      :order="activeOrder"
      @back="closeOrderDetail"
    />

    <!-- 2. 账本主列表视图 -->
    <div v-else class="cb-ledger-main-container">
      <!-- 顶部固定筛选工具栏 -->
      <header class="cb-ledger-header">
        <div class="cb-header-title-bar">
          <h1 class="cb-header-title">查账本</h1>
          <div class="cb-header-actions">
            <span class="cb-header-badge">
              {{ appState.filteredOrders.value.length }} 笔记录
            </span>
            <button
              type="button"
              class="cb-batch-mode-btn cb-pressable"
              :class="{ 'cb-batch-mode-btn--active': selectionMode }"
              aria-label="进入批量定价多选模式"
              @click="toggleSelectionMode"
            >
              {{ selectionMode ? '取消' : '批量' }}
            </button>
          </div>
        </div>
        <LedgerFilterBar />
      </header>

      <!-- 动态汇总统计胶囊条（紧凑单行） -->
      <div class="cb-summary-compact-strip cb-tabular-nums" role="status" aria-label="数据汇总">
        <div class="cb-sum-left">
          <span class="cb-sum-item">
            共 <strong class="cb-sum-strong">{{ appState.ledgerSummary.value.totalCount }}</strong> 笔
          </span>
          <span class="cb-sum-dot">·</span>
          <span class="cb-sum-item">
            <strong class="cb-sum-strong">{{ appState.ledgerSummary.value.totalPieces.toLocaleString() }}</strong> 件
          </span>
          <span v-if="appState.ledgerSummary.value.unpricedCount > 0" class="cb-unpriced-flag">
            ({{ appState.ledgerSummary.value.unpricedCount }}单待定)
          </span>
        </div>
        <div class="cb-sum-right">
          <span class="cb-sum-money-label">合计:</span>
          <span class="cb-sum-money-val">¥{{ appState.ledgerSummary.value.totalAmountYuan }}</span>
        </div>
      </div>

      <!-- 工单卡片列表 -->
      <main class="cb-ledger-body">
        <div v-if="appState.filteredOrders.value.length === 0" class="cb-empty-ledger">
          <div class="cb-empty-icon" aria-hidden="true">🔍</div>
          <div class="cb-empty-text">当前筛选条件下暂无工单</div>
          <button
            type="button"
            class="cb-reset-filter-btn cb-pressable"
            @click="
              appState.ledgerFilters.customerId = null;
              appState.ledgerFilters.categoryName = null;
              appState.ledgerFilters.searchKeyword = '';
              appState.ledgerFilters.datePreset = 'today';
            "
          >
            重置筛选
          </button>
        </div>

        <div v-else class="cb-order-list">
          <div
            v-for="order in appState.filteredOrders.value"
            :key="order.orderId"
            class="cb-order-select-wrap"
            :class="{ 'cb-order-select-wrap--selection': selectionMode }"
          >
            <button
              v-if="selectionMode"
              type="button"
              class="cb-select-circle cb-pressable"
              :class="{ 'cb-select-circle--checked': isSelected(order) }"
              :aria-label="`${isSelected(order) ? '取消勾选' : '勾选'}工单：${order.customerDisplayName}`"
              @click="toggleSelection(order)"
            >
              <span v-if="isSelected(order)" aria-hidden="true">✓</span>
            </button>
            <WorkOrderCard
              :order="order"
              @click="onCardClick(order)"
            />
          </div>
        </div>
      </main>

      <!-- 底部批量操作条 -->
      <div v-if="selectionMode" class="cb-batch-bar">
        <span class="cb-batch-count">
          已选 <strong>{{ selectedCount }}</strong> 单
        </span>
        <button
          type="button"
          class="cb-batch-price-btn cb-pressable"
          :disabled="selectedCount === 0"
          @click="openBatchPriceSheet"
        >
          批量设价
        </button>
        <button
          type="button"
          class="cb-batch-cancel-btn cb-pressable"
          @click="exitSelectionMode"
        >
          取消
        </button>
      </div>
    </div>

    <!-- 批量设价 Bottom Sheet -->
    <Transition name="cb-sheet">
    <div
      v-if="showBatchPriceSheet"
      class="cb-batch-sheet-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="批量设价"
      @click.self="closeBatchPriceSheet"
    >
      <div class="cb-batch-sheet-panel">
        <div class="cb-batch-sheet-handle" aria-hidden="true"></div>
        <div class="cb-batch-sheet-header">
          <div class="cb-batch-sheet-title-group">
            <h2 class="cb-batch-sheet-title">批量设价</h2>
            <span class="cb-batch-sheet-sub">空 = 不改，至少填一项；单价支持 0 与两位小数</span>
          </div>
          <button
            type="button"
            class="cb-batch-sheet-close cb-pressable"
            aria-label="关闭批量设价"
            @click="closeBatchPriceSheet"
          >
            ✕
          </button>
        </div>

        <div class="cb-batch-fields">
          <!-- 数量：留空不改 -->
          <div class="cb-batch-field-card">
            <label for="batch-price-qty" class="cb-batch-field-label">数量 (留空不改)</label>
            <div class="cb-batch-field-underline-row">
              <input
                id="batch-price-qty"
                :value="batchQtyStr"
                type="text"
                inputmode="numeric"
                pattern="[0-9]*"
                class="cb-batch-field-input cb-tabular-nums"
                placeholder="不改"
                autocomplete="off"
                @keydown="onBatchQtyKeydown"
                @input="onBatchQtyInput"
              />
              <span class="cb-batch-field-unit">件/单位</span>
            </div>
            <p v-if="batchQtyError" class="cb-batch-field-error" role="alert">{{ batchQtyError }}</p>
            <div class="cb-batch-field-line" aria-hidden="true"></div>
          </div>

          <!-- 单价：留空不改，支持 0 与两位小数 -->
          <div class="cb-batch-field-card">
            <label for="batch-price-unit-price" class="cb-batch-field-label">单价 (元，留空不改)</label>
            <div class="cb-batch-field-underline-row">
              <span class="cb-batch-field-currency">¥</span>
              <input
                id="batch-price-unit-price"
                :value="batchPriceStr"
                type="text"
                inputmode="decimal"
                class="cb-batch-field-input cb-tabular-nums"
                placeholder="不改"
                autocomplete="off"
                @keydown="onBatchPriceKeydown"
                @input="onBatchPriceInput"
              />
            </div>
            <p v-if="batchPriceError" class="cb-batch-field-error" role="alert">{{ batchPriceError }}</p>
            <div class="cb-batch-field-line" aria-hidden="true"></div>
          </div>
        </div>

        <div class="cb-batch-sheet-actions">
          <button
            type="button"
            class="cb-batch-sheet-cancel-btn cb-pressable"
            @click="closeBatchPriceSheet"
          >
            取消
          </button>
          <button
            type="button"
            class="cb-batch-sheet-confirm-btn cb-pressable"
            @click="confirmBatchPrice"
          >
            确认批量设价
          </button>
        </div>
      </div>
    </div>
    </Transition>
  </div>
</template>

<style scoped>
.cb-ledger-view {
  padding-bottom: calc(var(--cb-tabbar-height) + 20px);
}

.cb-ledger-header {
  position: sticky;
  top: 0;
  z-index: 50;
  background: var(--md-sys-color-surface);
}

.cb-header-title-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: calc(14px + env(safe-area-inset-top, 0px)) 16px 8px;
}

.cb-header-title {
  margin: 0;
  font-family: var(--cb-font-numeric);
  font-size: 36px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  letter-spacing: -0.3px;
}

.cb-header-badge {
  font-family: var(--cb-font-numeric);
  font-size: 12px;
  font-weight: 700;
  background: var(--md-sys-color-surface-container);
  padding: 3px 8px;
  border-radius: var(--md-sys-shape-corner-full);
  color: var(--md-sys-color-on-surface-variant);
}

/* 紧凑汇总横条 (M3 Tonal Surface Container Highest) */
.cb-summary-compact-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--md-sys-color-on-surface);
  color: var(--md-sys-color-surface);
  padding: 8px 16px;
  box-shadow: var(--md-sys-elevation-1);
}

.cb-sum-left {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 12px;
  color: var(--md-sys-color-outline-variant);
}

.cb-sum-strong {
  font-family: var(--cb-font-numeric);
  color: var(--cb-surface);
  font-weight: 800;
  font-size: 15px;
}

.cb-sum-dot {
  color: var(--md-sys-color-outline);
}

.cb-unpriced-flag {
  font-family: var(--cb-font-numeric);
  font-size: 11px;
  color: var(--cb-status-warning-text);
}

.cb-sum-right {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.cb-sum-money-label {
  font-size: 11px;
  color: var(--md-sys-color-outline-variant);
}

.cb-sum-money-val {
  font-family: var(--cb-font-numeric);
  font-size: 17px;
  font-weight: 800;
  color: var(--cb-status-success-text);
}

/* 主体列表 */
.cb-ledger-body {
  padding: 12px 14px;
}

.cb-empty-ledger {
  text-align: center;
  padding: 40px 16px;
  color: var(--md-sys-color-outline);
}

.cb-empty-icon {
  font-size: 32px;
  margin-bottom: 8px;
}

.cb-empty-text {
  font-size: 14px;
  margin-bottom: 12px;
}

.cb-reset-filter-btn {
  background: var(--md-sys-color-surface);
  border: none;
  box-shadow: var(--md-sys-elevation-1);
  padding: 8px 16px;
  border-radius: var(--md-sys-shape-corner-small);
  font-size: 13px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
  cursor: pointer;
  transition: box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-reset-filter-btn:hover {
  box-shadow: var(--md-sys-elevation-2);
}

.cb-order-list {
  display: flex;
  flex-direction: column;
}

/* 头部操作区：记录数 + 批量模式入口 */
.cb-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cb-batch-mode-btn {
  height: 32px;
  padding: 0 12px;
  background: var(--md-sys-color-surface-container);
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 13px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-batch-mode-btn:hover {
  background: var(--md-sys-color-surface-container-high);
}

.cb-batch-mode-btn--active {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  box-shadow: var(--md-sys-elevation-1);
}

/* 多选模式：卡片左侧圆形勾选 */
.cb-order-select-wrap {
  position: relative;
  margin-bottom: 12px;
}
.cb-order-select-wrap:last-child {
  margin-bottom: 0;
}
.cb-order-select-wrap :deep(.cb-order-card) {
  margin-bottom: 0;
}
.cb-order-select-wrap--selection :deep(.cb-order-card) {
  padding-left: 48px;
}

.cb-select-circle {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 3;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid var(--md-sys-color-outline);
  background: var(--md-sys-color-surface);
  color: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 800;
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-select-circle--checked {
  background: var(--md-sys-color-primary);
  border-color: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
}

/* 底部批量操作条 */
.cb-batch-bar {
  position: fixed;
  bottom: calc(var(--cb-tabbar-height) + 12px + env(safe-area-inset-bottom, 0px));
  left: 16px;
  right: 16px;
  max-width: 500px;
  margin: 0 auto;
  z-index: 400;
  background: var(--md-sys-color-inverse-surface);
  color: var(--md-sys-color-inverse-on-surface);
  border-radius: var(--md-sys-shape-corner-medium);
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  box-shadow: var(--md-sys-elevation-3);
}

.cb-batch-count {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}
.cb-batch-count strong {
  font-family: var(--cb-font-numeric);
  font-size: 16px;
  font-weight: 800;
}

.cb-batch-price-btn {
  height: 38px;
  padding: 0 14px;
  background: var(--md-sys-color-inverse-primary);
  color: var(--md-sys-color-inverse-on-primary);
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
  transition: opacity var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-batch-price-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.cb-batch-cancel-btn {
  height: 38px;
  padding: 0 12px;
  background: transparent;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 13px;
  font-weight: 700;
  color: var(--md-sys-color-inverse-on-surface);
  cursor: pointer;
}

/* 批量设价 Bottom Sheet */
.cb-batch-sheet-overlay {
  position: fixed;
  inset: 0;
  background: var(--cb-overlay);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 1100;
}

.cb-batch-sheet-panel {
  width: 100%;
  max-width: 500px;
  background: var(--md-sys-color-surface);
  border-radius: var(--md-sys-shape-corner-extra-large) var(--md-sys-shape-corner-extra-large) 0 0;
  padding: 12px 18px calc(24px + env(safe-area-inset-bottom, 0px));
  box-shadow: var(--md-sys-elevation-4);
  box-sizing: border-box;
}

.cb-batch-sheet-handle {
  width: 36px;
  height: 4px;
  background: var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-full);
  margin: 0 auto 12px;
}

.cb-batch-sheet-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
}

.cb-batch-sheet-title-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cb-batch-sheet-title {
  margin: 0;
  font-size: 19px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  letter-spacing: -0.3px;
}

.cb-batch-sheet-sub {
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
}

.cb-batch-sheet-close {
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
  flex-shrink: 0;
}

.cb-batch-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 20px;
}

.cb-batch-field-card {
  background: var(--md-sys-color-surface-container-low);
  border-radius: var(--md-sys-shape-corner-medium);
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  position: relative;
}

.cb-batch-field-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface-variant);
  margin-bottom: 4px;
}

.cb-batch-field-underline-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.cb-batch-field-input {
  width: 100%;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--cb-font-numeric);
  font-size: 26px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  padding: 4px 0 6px;
}

.cb-batch-field-input::placeholder {
  color: var(--md-sys-color-outline);
  font-weight: 500;
  font-size: 18px;
}

.cb-batch-field-unit,
.cb-batch-field-currency {
  font-size: 14px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface-variant);
  flex-shrink: 0;
}

.cb-batch-field-error {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--md-sys-color-error);
}

.cb-batch-field-line {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 10px;
  height: 2px;
  background-color: var(--md-sys-color-outline-variant);
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
              height var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-batch-field-card:focus-within .cb-batch-field-line {
  height: 2.5px;
  background-color: var(--md-sys-color-primary);
}

.cb-batch-sheet-actions {
  display: flex;
  gap: 10px;
}

.cb-batch-sheet-cancel-btn {
  height: 50px;
  padding: 0 18px;
  background: var(--md-sys-color-surface-container-high);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: 14px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
}

.cb-batch-sheet-confirm-btn {
  flex: 1;
  height: 50px;
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: 15px;
  font-weight: 800;
  cursor: pointer;
  box-shadow: var(--md-sys-elevation-2);
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-batch-sheet-confirm-btn:hover {
  background: var(--cb-accent-hover);
  box-shadow: var(--md-sys-elevation-3);
}
</style>
