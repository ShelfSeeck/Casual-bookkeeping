<script setup lang="ts">
import type { MockWorkOrder } from '../../mock/mockData'
import StatusBadge from '../common/StatusBadge.vue'

defineProps<{
  order: MockWorkOrder
}>()

const emit = defineEmits<{
  (e: 'click', order: MockWorkOrder): void
}>()
</script>

<template>
  <button
    type="button"
    class="cb-card cb-order-card cb-pressable"
    :aria-label="`查看工单：${order.customerDisplayName}，${order.categoryName} ${order.subcategoryName}，数量 ${order.quantity}${order.unit}`"
    @click="emit('click', order)"
  >
    <!-- 顶部行：客户信息 + 状态 -->
    <div class="cb-card-header">
      <div class="cb-card-cust">
        <span class="cb-cust-code-pill">{{ order.customerCode }}</span>
        <span class="cb-cust-title">{{ order.customerDisplayName }}</span>
        <span class="cb-order-date">{{ order.orderDate.slice(5) }}</span>
      </div>
      <div class="cb-card-badges">
        <StatusBadge type="sync" :value="order.syncStatus" />
      </div>
    </div>

    <!-- 中部行：服务项目 -->
    <div class="cb-card-service">
      <span class="cb-service-tag">{{ order.categoryName }}</span>
      <span class="cb-service-sub">{{ order.subcategoryName }}</span>
    </div>

    <!-- 底部数据行：等宽大字 -->
    <div class="cb-card-footer cb-tabular-nums">
      <div class="cb-card-qty-group">
        <span class="cb-card-qty">{{ order.quantity.toLocaleString() }}</span>
        <span class="cb-card-unit">{{ order.unit }}</span>
      </div>

      <div class="cb-card-price-group">
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
  </button>
</template>

<style scoped>
.cb-order-card {
  width: 100%;
  text-align: left;
  padding: 14px 16px;
  background: var(--md-sys-color-surface);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  box-shadow: var(--md-sys-elevation-1);
  margin-bottom: 12px;
  cursor: pointer;
  transition: box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
              transform var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-order-card:hover {
  box-shadow: var(--md-sys-elevation-2);
}

.cb-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.cb-card-cust {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.cb-cust-code-pill {
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

.cb-cust-title {
  font-size: 16px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cb-order-date {
  font-family: var(--cb-font-numeric);
  font-size: 12px;
  color: var(--md-sys-color-outline);
  margin-left: 2px;
  flex-shrink: 0;
}

.cb-card-badges {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.cb-card-service {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--md-sys-color-on-surface-variant);
  margin-bottom: 10px;
}

.cb-service-tag {
  background: var(--md-sys-color-surface-container);
  padding: 2px 8px;
  border-radius: var(--md-sys-shape-corner-extra-small);
  font-weight: 600;
}

.cb-service-sub {
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

.cb-card-footer {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding-top: 10px;
  border-top: 1px dashed var(--md-sys-color-outline-variant);
}

.cb-card-qty-group {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.cb-card-qty {
  font-family: var(--cb-font-numeric);
  font-size: 22px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  letter-spacing: -0.4px;
}

.cb-card-unit {
  font-size: 13px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface-variant);
}

.cb-card-price-group {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.cb-unit-price {
  font-family: var(--cb-font-numeric);
  font-size: 12px;
  color: var(--md-sys-color-outline);
}

.cb-total-price {
  font-family: var(--cb-font-numeric);
  font-size: 18px;
  font-weight: 800;
  color: #059669;
}

.cb-unpriced-pill {
  font-size: 12px;
  font-weight: 700;
  color: #d97706;
  background: #fffbeb;
  padding: 2px 8px;
  border-radius: var(--md-sys-shape-corner-extra-small);
}
</style>
