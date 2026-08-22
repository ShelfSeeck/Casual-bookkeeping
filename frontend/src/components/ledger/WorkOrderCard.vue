<script setup lang="ts">
import type { WorkOrderUi } from '../../types/ui'

defineProps<{
  order: WorkOrderUi
}>()

const emit = defineEmits<{
  (e: 'click', order: WorkOrderUi): void
}>()
</script>

<template>
  <button
    type="button"
    class="cb-card cb-order-card cb-pressable"
    :aria-label="`查看工单：${order.customerDisplayName}，${order.categoryName} ${order.subcategoryName}，数量 ${order.quantity}${order.unit}`"
    @click="emit('click', order)"
  >
    <!-- 第一行：编号、简称、年月日时间（尽量铺满，突出客户和时间） -->
    <div class="cb-card-row-top">
      <div class="cb-card-cust-info">
        <span class="cb-cust-code-pill">{{ order.customerCode }}</span>
        <span class="cb-cust-title">{{ order.customerDisplayName }}</span>
      </div>
      <span class="cb-order-date cb-tabular-nums">{{ order.orderDate }}</span>
    </div>

    <!-- 第二行：服务品类和服务小类（前半部分占满、字体加大） + 数量与单价（后半部分） -->
    <div class="cb-card-row-bottom">
      <div class="cb-card-service-info">
        <span class="cb-service-name">
          {{ order.subcategoryName ? `${order.categoryName} → ${order.subcategoryName}` : order.categoryName }}
        </span>
      </div>

      <div class="cb-card-metrics cb-tabular-nums">
        <div class="cb-metric-qty-group">
          <span class="cb-card-qty">{{ order.quantity.toLocaleString() }}</span>
          <span class="cb-card-unit">{{ order.unit }}</span>
        </div>

        <div class="cb-metric-price-group">
          <template v-if="order.unitPriceCents != null">
            <span class="cb-unit-price">@¥{{ (order.unitPriceCents / 100).toFixed(2) }}</span>
            <span class="cb-total-price">
              ¥{{ ((order.quantity * order.unitPriceCents) / 100).toFixed(2) }}
            </span>
          </template>
          <template v-else>
            <span class="cb-unpriced-pill">待定价</span>
          </template>
        </div>
      </div>
    </div>
  </button>
</template>

<style scoped>
.cb-order-card {
  width: 100%;
  text-align: left;
  padding: 16px 18px;
  background: var(--md-sys-color-surface);
  border: none;
  border-radius: var(--md-sys-shape-corner-large);
  box-shadow: var(--md-sys-elevation-1);
  margin-bottom: 12px;
  cursor: pointer;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
              transform var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-order-card:hover {
  box-shadow: var(--md-sys-elevation-2);
}

/* 第一行：客户与时间（首要视觉焦点） */
.cb-card-row-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.cb-card-cust-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.cb-cust-code-pill {
  color: var(--cb-accent);
  font-family: var(--cb-font-numeric);
  font-size: 20px;
  font-weight: 800;
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-thickness: 2.5px;
  flex-shrink: 0;
  line-height: 1.1;
}

.cb-cust-title {
  font-size: 20px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.2px;
}

.cb-order-date {
  font-family: var(--cb-font-numeric);
  font-size: 17px;
  font-weight: 800;
  color: var(--md-sys-color-primary);
  flex-shrink: 0;
  letter-spacing: -0.2px;
}

/* 第二行：品类/小类 + 数量/单价（次级明细数据） */
.cb-card-row-bottom {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  width: 100%;
}

.cb-card-service-info {
  min-width: 0;
  flex: 1;
}

.cb-service-name {
  font-family: var(--cb-font-serif);
  font-size: 15px;
  font-weight: 700;
  color: var(--md-sys-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}

.cb-card-metrics {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-shrink: 0;
}

.cb-metric-qty-group {
  display: flex;
  align-items: baseline;
  gap: 3px;
}

.cb-card-qty {
  font-family: var(--cb-font-numeric);
  font-size: 20px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  letter-spacing: -0.3px;
}

.cb-card-unit {
  font-size: 14px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface-variant);
}

.cb-metric-price-group {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.cb-unit-price {
  font-family: var(--cb-font-numeric);
  font-size: 12px;
  color: var(--md-sys-color-outline);
}

.cb-total-price {
  font-family: var(--cb-font-numeric);
  font-size: 17px;
  font-weight: 800;
  color: var(--cb-status-success-text);
}

/* 待定价：不突出的主题浅淡色 */
.cb-unpriced-pill {
  font-size: 12px;
  font-weight: 600;
  color: var(--md-sys-color-outline);
  background: var(--md-sys-color-surface-container);
  padding: 2px 8px;
  border-radius: var(--md-sys-shape-corner-extra-small);
}
</style>
