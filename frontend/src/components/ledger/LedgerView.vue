<script setup lang="ts">
import { ref } from 'vue'
import { appState } from '../../state/appState'
import type { WorkOrderUi } from '../../types/ui'
import LedgerFilterBar from './LedgerFilterBar.vue'
import WorkOrderCard from './WorkOrderCard.vue'
import WorkOrderDetailEdit from './WorkOrderDetailEdit.vue'

const activeOrder = ref<WorkOrderUi | null>(null)

function openOrderDetail(order: WorkOrderUi) {
  activeOrder.value = order
}

function closeOrderDetail() {
  activeOrder.value = null
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
          <span class="cb-header-badge">
            {{ appState.filteredOrders.value.length }} 笔记录
          </span>
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
          <WorkOrderCard
            v-for="order in appState.filteredOrders.value"
            :key="order.orderId"
            :order="order"
            @click="openOrderDetail"
          />
        </div>
      </main>
    </div>
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
  font-size: 24px;
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
</style>
