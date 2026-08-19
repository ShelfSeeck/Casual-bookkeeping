<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { appState } from '../../state/appState'
import { toErrorMessage } from '../../services/errorMessages'
import {
  isAllowedDecimalKey,
  isAllowedIntegerKey,
  sanitizeDecimalInput,
  sanitizeIntegerInput,
} from '../../utils/numericInput'
import { localDateToday, shiftLocalDate } from '../../utils/localDate'

// 表单状态
const selectedCustomerId = ref<number | null>(null)
const selectedCategoryName = ref('')
const selectedSubcategoryName = ref<string | null>(null)
const unit = ref('件')
const quantityStr = ref('')
const unitPriceStr = ref('')
const quantityError = ref('')
const unitPriceError = ref('')
const today = computed(() => localDateToday())
const yesterday = computed(() => shiftLocalDate(today.value, -1))
const dayBefore = computed(() => shiftLocalDate(today.value, -2))
const orderDate = ref(today.value)

// 底部滑出弹窗控制
const showCustomerSheet = ref(false)
const showSubcategorySheet = ref(false)
const showDatePickerSheet = ref(false)
const customerSearch = ref('')
const customDateInputRef = ref<HTMLInputElement | null>(null)

function triggerCustomDatePicker() {
  if (customDateInputRef.value) {
    if (typeof customDateInputRef.value.showPicker === 'function') {
      customDateInputRef.value.showPicker()
    } else {
      customDateInputRef.value.focus()
    }
  }
}

function onCustomDateChanged(e: Event) {
  const val = (e.target as HTMLInputElement).value
  if (val) {
    orderDate.value = val
    showDatePickerSheet.value = false
  }
}

function setOrderDate(value: string) {
  orderDate.value = value
  showDatePickerSheet.value = false
}

// 当前选中的客户
const currentCustomer = computed(() => {
  return appState.customers.find((c) => c.customerId === selectedCustomerId.value) || appState.customers[0]
})

// 过滤后的客户列表
const filteredCustomers = computed(() => {
  if (!customerSearch.value.trim()) {
    return appState.customers
  }
  const q = customerSearch.value.trim().toLowerCase()
  return appState.customers.filter((c) => {
    return c.code.toLowerCase().includes(q) || c.displayName.toLowerCase().includes(q) || c.customerName.toLowerCase().includes(q)
  })
})

// 当前激活的大类
const activeCategory = computed(() => {
  return appState.categories.find((c) => c.name === selectedCategoryName.value)
})

// 小类数量是否较多（大于 6 个走下拉弹窗，少于等于 6 个直接大按钮平铺直选）
const isSubcatMany = computed(() => {
  if (!activeCategory.value) return false
  return activeCategory.value.subcategories.length > 6
})

function selectCategory(catName: string) {
  selectedCategoryName.value = catName
  const cat = appState.categories.find((c) => c.name === catName)
  if (cat && cat.subcategories.length > 0) {
    selectedSubcategoryName.value = cat.subcategories[0].name
    unit.value = cat.subcategories[0].defaultUnit
  } else {
    selectedSubcategoryName.value = null
    unit.value = '件'
  }
}

function chooseCustomer(id: number) {
  selectedCustomerId.value = id
  showCustomerSheet.value = false
  customerSearch.value = ''
}

function chooseSubcategory(subName: string, defaultUnit: string) {
  selectedSubcategoryName.value = subName
  unit.value = defaultUnit
  showSubcategorySheet.value = false
}

// 真实数据加载后，自动选中第一个客户与第一个大类
watch(
  () => appState.customers.length,
  () => {
    if (appState.customers.length > 0 && selectedCustomerId.value === null) {
      selectedCustomerId.value = appState.customers[0].customerId
    }
  },
  { immediate: true },
)

watch(
  () => appState.categories.length,
  () => {
    if (appState.categories.length === 0) return
    const exists = appState.categories.some((c) => c.name === selectedCategoryName.value)
    if (!selectedCategoryName.value || !exists) {
      selectCategory(appState.categories[0].name)
    }
  },
  { immediate: true },
)

function onQuantityKeydown(e: KeyboardEvent) {
  if (!isAllowedIntegerKey(e)) {
    e.preventDefault()
    quantityError.value = '只能输入数字'
  }
}

function onQuantityInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  const cleaned = sanitizeIntegerInput(raw)
  quantityStr.value = cleaned
  quantityError.value = raw !== cleaned ? '只能输入数字' : ''
}

function onUnitPriceKeydown(e: KeyboardEvent) {
  if (!isAllowedDecimalKey(e)) {
    e.preventDefault()
    unitPriceError.value = '只能输入数字和小数点'
  }
}

function onUnitPriceInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value
  const cleaned = sanitizeDecimalInput(raw)
  unitPriceStr.value = cleaned
  unitPriceError.value = raw !== cleaned ? '只能输入数字和小数点' : ''
}

async function handleSave() {
  if (!selectedCustomerId.value) {
    showFailToast('请选择客户')
    return
  }
  if (!selectedCategoryName.value) {
    showFailToast('请选择服务大类')
    return
  }
  const qty = parseInt(quantityStr.value, 10)
  if (isNaN(qty) || qty <= 0) {
    showFailToast('请输入有效数量')
    return
  }

  let priceCents: number | null = null
  if (unitPriceStr.value.trim() !== '') {
    const p = parseFloat(unitPriceStr.value)
    if (isNaN(p) || p < 0) {
      showFailToast('请输入有效单价')
      return
    }
    priceCents = Math.round(p * 100)
  }

  try {
    await appState.createWorkOrder({
      customerId: selectedCustomerId.value,
      categoryName: selectedCategoryName.value,
      subcategoryName: selectedSubcategoryName.value || null,
      quantity: qty,
      unit: unit.value,
      unitPriceCents: priceCents,
      orderDate: orderDate.value,
    })
    showSuccessToast('已保存到本机')
    quantityStr.value = ''
  } catch (e) {
    showFailToast(toErrorMessage(e))
  }
}

function scrollToTodayFlow() {
  const el = document.getElementById('desk-today-flow-block')
  if (el) {
    el.scrollIntoView({ behavior: 'smooth' })
  }
}
</script>

<template>
  <div
    v-if="appState.customers.length === 0 || appState.categories.length === 0"
    class="cb-empty-console"
  >
    <div class="cb-empty-console-icon" aria-hidden="true">📋</div>
    <h2 class="cb-empty-console-title">请先维护基础档案</h2>
    <p class="cb-empty-console-desc">
      工单录入前需要至少一个客户编号映射和一个服务大类。请前往「设置」完成维护。
    </p>
    <button
      type="button"
      class="cb-large-submit-btn cb-pressable"
      aria-label="前往设置维护基础档案"
      @click="appState.setTab('settings')"
    >
      前往设置
    </button>
  </div>

  <div v-else class="cb-console-wrapper">
    <!-- 主录入监控控制台 -->
    <div class="cb-console-panel">
      <!-- 顶部时间大字监控行 -->
      <div class="cb-top-time-bar">
        <button
          type="button"
          class="cb-time-big-trigger cb-pressable"
          aria-label="点击修改工单日期"
          @click="showDatePickerSheet = true"
        >
          <div class="cb-time-big-group cb-tabular-nums">
            <span class="cb-time-big-date">{{ orderDate }}</span>
            <span v-if="orderDate === today" class="cb-time-today-tag">今天</span>
            <span v-else-if="orderDate === yesterday" class="cb-time-today-tag">昨天</span>
          </div>
          <span class="cb-time-switch-icon" aria-hidden="true">切换日期 ▾</span>
        </button>
      </div>

      <!-- 1. 客户选择卡片（M3 Elevated Card 风格） -->
      <div class="cb-monitor-section">
        <label class="cb-section-tag">客户 (编号 + 简称)</label>
        <button
          type="button"
          class="cb-cust-placard-btn cb-pressable"
          aria-label="选择客户"
          @click="showCustomerSheet = true"
        >
          <div class="cb-placard-left">
            <div class="cb-placard-code-box">
              <span class="cb-placard-code-val">{{ currentCustomer.code }}</span>
            </div>
            <div class="cb-placard-names-col">
              <span class="cb-placard-name-main">{{ currentCustomer.displayName }}</span>
              <span class="cb-placard-fullname-sub">{{ currentCustomer.customerName }}</span>
            </div>
          </div>
          <div class="cb-placard-right">
            <span class="cb-clean-switch-text">切换 ▾</span>
          </div>
        </button>
      </div>

      <!-- 2. 服务大类（M3 Primary Tabs） -->
      <div class="cb-monitor-section">
        <label class="cb-section-tag">服务大类</label>
        <div class="cb-major-tabs-third-grid" role="tablist" aria-label="服务大类">
          <button
            v-for="cat in appState.categories"
            :key="cat.categoryId"
            type="button"
            class="cb-major-third-tab cb-pressable"
            :class="{ 'cb-major-third-tab--active': selectedCategoryName === cat.name }"
            role="tab"
            :aria-selected="selectedCategoryName === cat.name"
            @click="selectCategory(cat.name)"
          >
            <span class="cb-tab-name-text">{{ cat.name }}</span>
          </button>
        </div>
      </div>

      <!-- 3. 小类展示区（无边界 + 微阴影 M3 Elevated 风格） -->
      <div v-if="activeCategory" class="cb-monitor-section">
        <div class="cb-subcat-section-header">
          <label class="cb-section-tag">具体小类 ({{ selectedCategoryName }})</label>
          <span class="cb-unit-reminder">默认单位: <strong>{{ unit }}</strong></span>
        </div>

        <!-- 数量 <= 6 时，无边界 + 微阴影直选卡片平铺 -->
        <div v-if="!isSubcatMany" class="cb-subcat-direct-grid" role="group" aria-label="具体小类选项">
          <button
            v-for="sub in activeCategory.subcategories"
            :key="sub.name"
            type="button"
            class="cb-subcat-direct-btn cb-pressable"
            :class="{ 'cb-subcat-direct-btn--active': selectedSubcategoryName === sub.name }"
            @click="chooseSubcategory(sub.name, sub.defaultUnit)"
          >
            <span class="cb-direct-name">{{ sub.name }}</span>
            <span class="cb-direct-unit">({{ sub.defaultUnit }})</span>
          </button>
          <button
            type="button"
            class="cb-subcat-direct-btn cb-pressable"
            :class="{ 'cb-subcat-direct-btn--active': selectedSubcategoryName === null }"
            @click="selectedSubcategoryName = null"
          >
            <span class="cb-direct-name">暂不选小类</span>
          </button>
        </div>

        <!-- 数量 > 6 时，无边界 + 微阴影下拉菜单条 -->
        <button
          v-else
          type="button"
          class="cb-subcat-dropdown-row cb-pressable"
          aria-label="选择具体小类"
          @click="showSubcategorySheet = true"
        >
          <div class="cb-dropdown-row-left">
            <span class="cb-subcat-focus-name">{{ selectedSubcategoryName || '暂不选小类' }}</span>
            <span class="cb-subcat-focus-unit">单位: {{ unit }}</span>
          </div>
          <span class="cb-clean-switch-text" aria-hidden="true">切换小类 ▾</span>
        </button>
      </div>

      <!-- 4. 数量输入（M3 浅下划线直输模式，系统输入法直接唤起） -->
      <div class="cb-monitor-section">
        <div class="cb-field-header-row">
          <label for="work-order-qty-input" class="cb-section-tag">数量 *</label>
          <span class="cb-unit-reminder">单位: <strong>{{ unit }}</strong></span>
        </div>
        <div class="m3-underline-field">
          <div class="m3-underline-input-box">
            <input
              id="work-order-qty-input"
              :value="quantityStr"
              type="text"
              inputmode="numeric"
              pattern="[0-9]*"
              class="m3-native-input cb-tabular-nums"
              placeholder="0"
              autocomplete="off"
              aria-label="工单数量"
              @keydown="onQuantityKeydown"
              @input="onQuantityInput"
            />
            <span class="m3-unit-suffix">{{ unit }}</span>
          </div>
          <p v-if="quantityError" class="cb-inline-error" role="alert">{{ quantityError }}</p>
          <div class="m3-bottom-line" aria-hidden="true"></div>
        </div>
      </div>

      <!-- 5. 单价输入（M3 浅下划线直输模式，系统输入法小数键盘） -->
      <div class="cb-monitor-section">
        <div class="cb-field-header-row">
          <label for="work-order-price-input" class="cb-section-tag">
            单价 <span class="cb-tag-optional">可选 (元/{{ unit }})</span>
          </label>
        </div>
        <div class="m3-underline-field">
          <div class="m3-underline-input-box">
            <span class="m3-currency-prefix">¥</span>
            <input
              id="work-order-price-input"
              :value="unitPriceStr"
              type="text"
              inputmode="decimal"
              class="m3-native-input cb-tabular-nums"
              placeholder="未定价"
              autocomplete="off"
              aria-label="工单单价"
              @keydown="onUnitPriceKeydown"
              @input="onUnitPriceInput"
            />
          </div>
          <p v-if="unitPriceError" class="cb-inline-error" role="alert">{{ unitPriceError }}</p>
          <div class="m3-bottom-line" aria-hidden="true"></div>
        </div>
      </div>

      <!-- 6. 满宽 M3 Filled Button 保存按钮 -->
      <button
        type="button"
        class="cb-large-submit-btn cb-pressable"
        aria-label="保存工单"
        @click="handleSave"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>立即保存工单</span>
      </button>

      <!-- 下滑提示条 -->
      <button
        type="button"
        class="cb-down-cue-handle cb-pressable"
        aria-label="查看今日流水"
        @click="scrollToTodayFlow"
      >
        <span>今日已录流水 ({{ appState.todayOrders.value.length }} 笔)</span>
        <span aria-hidden="true">▼ 向下滑动查看</span>
      </button>
    </div>

    <!-- 下方：今日流水列表区 -->
    <div id="desk-today-flow-block" class="cb-flow-stream-panel">
      <div class="cb-stream-header">
        <h2 class="cb-stream-title">今日已录流水明细</h2>
        <span class="cb-stream-count-badge">{{ appState.todayOrders.value.length }} 笔</span>
      </div>

      <div v-if="appState.todayOrders.value.length === 0" class="cb-stream-empty">
        今日暂无已录单据
      </div>

      <div v-else class="cb-stream-items-wrap">
        <button
          v-for="item in appState.todayOrders.value"
          :key="item.orderId"
          type="button"
          class="cb-stream-row-btn cb-pressable"
          @click="appState.setTab('ledger')"
        >
          <div class="cb-stream-col-left">
            <div class="cb-stream-cust-line">
              <span class="cb-stream-code">{{ item.customerCode }}</span>
              <span class="cb-stream-name">{{ item.customerDisplayName }}</span>
              <span class="cb-stream-service">{{ item.categoryName }} · {{ item.subcategoryName }}</span>
            </div>
            <span class="cb-stream-time">{{ item.createdAt.slice(11, 16) }}</span>
          </div>

          <div class="cb-stream-col-right cb-tabular-nums">
            <div class="cb-stream-qty-line">
              <span class="cb-stream-qty-val">{{ item.quantity.toLocaleString() }}</span>
              <span class="cb-stream-qty-unit">{{ item.unit }}</span>
            </div>
            <div class="cb-stream-money-line">
              <span v-if="item.unitPriceCents != null" class="cb-stream-money-val">
                ¥{{ ((item.quantity * item.unitPriceCents) / 100).toFixed(2) }}
              </span>
              <span v-else class="cb-stream-unpriced-val">未定价</span>
            </div>
          </div>
        </button>
      </div>
    </div>

    <!-- 底部滑出弹窗 1：客户全量选择抽屉 -->
    <Transition name="cb-sheet">
    <div
      v-if="showCustomerSheet"
      class="cb-sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="选择客户"
      @click.self="showCustomerSheet = false"
    >
      <div class="cb-sheet-drawer">
        <div class="m3-sheet-handle-pill" aria-hidden="true"></div>
        <div class="cb-sheet-drawer-header">
          <h2 class="cb-sheet-drawer-title">选择客户 (编号 + 简称)</h2>
          <button type="button" class="cb-sheet-drawer-close" aria-label="关闭" @click="showCustomerSheet = false">✕</button>
        </div>
        <div class="cb-sheet-search-wrap">
          <input
            v-model="customerSearch"
            type="text"
            placeholder="搜索编号或客户简称…"
            class="cb-sheet-search-field"
            autocomplete="off"
            spellcheck="false"
            autofocus
          />
        </div>
        <div class="cb-sheet-options-list" role="listbox">
          <button
            v-for="c in filteredCustomers"
            :key="c.customerId"
            type="button"
            class="cb-sheet-option-item cb-pressable"
            :class="{ 'cb-sheet-option-item--active': c.customerId === selectedCustomerId }"
            role="option"
            :aria-selected="c.customerId === selectedCustomerId"
            @click="chooseCustomer(c.customerId)"
          >
            <div class="cb-option-left-group">
              <span class="cb-option-code-pill">{{ c.code }}</span>
              <span class="cb-option-name-title">{{ c.displayName }}</span>
            </div>
            <span class="cb-option-fullname">{{ c.customerName }}</span>
          </button>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 底部滑出弹窗 2：小类选择抽屉 (当小类过多时) -->
    <Transition name="cb-sheet">
    <div
      v-if="showSubcategorySheet && activeCategory"
      class="cb-sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="选择具体小类"
      @click.self="showSubcategorySheet = false"
    >
      <div class="cb-sheet-drawer">
        <div class="m3-sheet-handle-pill" aria-hidden="true"></div>
        <div class="cb-sheet-drawer-header">
          <h2 class="cb-sheet-drawer-title">选择【{{ selectedCategoryName }}】小类</h2>
          <button type="button" class="cb-sheet-drawer-close" aria-label="关闭" @click="showSubcategorySheet = false">✕</button>
        </div>
        <div class="cb-sheet-options-list" role="listbox">
          <button
            v-for="sub in activeCategory.subcategories"
            :key="sub.name"
            type="button"
            class="cb-sheet-option-item cb-pressable"
            :class="{ 'cb-sheet-option-item--active': sub.name === selectedSubcategoryName }"
            role="option"
            :aria-selected="sub.name === selectedSubcategoryName"
            @click="chooseSubcategory(sub.name, sub.defaultUnit)"
          >
            <span class="cb-option-sub-name">{{ sub.name }}</span>
            <span class="cb-option-sub-unit">默认单位: {{ sub.defaultUnit }}</span>
          </button>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 底部滑出弹窗 3：日期切换抽屉 -->
    <Transition name="cb-sheet">
    <div
      v-if="showDatePickerSheet"
      class="cb-sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="选择工单录入日期"
      @click.self="showDatePickerSheet = false"
    >
      <div class="cb-sheet-drawer">
        <div class="m3-sheet-handle-pill" aria-hidden="true"></div>
        <div class="cb-sheet-drawer-header">
          <h2 class="cb-sheet-drawer-title">选择录入日期</h2>
          <button type="button" class="cb-sheet-drawer-close" aria-label="关闭" @click="showDatePickerSheet = false">✕</button>
        </div>
        <div class="cb-sheet-options-list" role="listbox">
          <button
            type="button"
            class="cb-sheet-option-item cb-pressable"
            :class="{ 'cb-sheet-option-item--active': orderDate === today }"
            @click="setOrderDate(today)"
          >
            <span class="cb-option-sub-name">{{ today }} (今天)</span>
          </button>
          <button
            type="button"
            class="cb-sheet-option-item cb-pressable"
            :class="{ 'cb-sheet-option-item--active': orderDate === yesterday }"
            @click="setOrderDate(yesterday)"
          >
            <span class="cb-option-sub-name">{{ yesterday }} (昨天)</span>
          </button>
          <button
            type="button"
            class="cb-sheet-option-item cb-pressable"
            :class="{ 'cb-sheet-option-item--active': orderDate === dayBefore }"
            @click="setOrderDate(dayBefore)"
          >
            <span class="cb-option-sub-name">{{ dayBefore }} (前天)</span>
          </button>

          <!-- 分隔线 -->
          <div class="cb-sheet-divider" aria-hidden="true"></div>

          <!-- 指定具体日期按键 (呼出原生日历) -->
          <div class="cb-custom-date-picker-row cb-pressable" @click="triggerCustomDatePicker">
            <div class="cb-custom-date-left">
              <span class="cb-calendar-emoji" aria-hidden="true">📅</span>
              <div class="cb-custom-date-text-col">
                <span class="cb-custom-date-title">指定具体日期...</span>
                <span class="cb-custom-date-desc">调出系统原生日历选择任意日期</span>
              </div>
            </div>
            <div class="cb-custom-date-right">
              <input
                ref="customDateInputRef"
                type="date"
                class="cb-native-date-hidden-trigger"
                :value="orderDate"
                aria-label="选择具体日期"
                @change="onCustomDateChanged"
              />
              <span class="cb-pick-arrow" aria-hidden="true">›</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    </Transition>
  </div>
</template>

<style scoped>
.cb-empty-console {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  padding: 24px;
  text-align: center;
  gap: 8px;
}

.cb-empty-console-icon {
  font-size: 40px;
}

.cb-empty-console-title {
  margin: 8px 0 0;
  font-size: 18px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

.cb-empty-console-desc {
  margin: 0 0 16px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--md-sys-color-on-surface-variant);
}

.cb-empty-console .cb-large-submit-btn {
  max-width: 320px;
}

.cb-console-wrapper {
  display: flex;
  flex-direction: column;
  background: var(--md-sys-color-surface-dim);
}

/* 主监控控制面板 */
.cb-console-panel {
  background: var(--md-sys-color-surface);
  padding: calc(22px + env(safe-area-inset-top, 0px)) 18px 22px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 顶部超大字日期栏 */
.cb-top-time-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 14px;
  border-bottom: 2px solid var(--md-sys-color-on-surface);
}

.cb-time-big-trigger {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
}

.cb-time-big-group {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.cb-time-big-date {
  font-family: var(--cb-font-numeric);
  font-size: 36px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  letter-spacing: -0.5px;
  line-height: 1;
}

.cb-time-today-tag {
  font-size: 13px;
  font-weight: 700;
  color: var(--md-sys-color-primary);
  background: var(--md-sys-color-primary-container);
  padding: 3px 8px;
  border-radius: var(--md-sys-shape-corner-small);
}

.cb-time-switch-icon {
  font-size: 14px;
  font-weight: 700;
  color: var(--md-sys-color-primary);
}

/* 监控面板字段 */
.cb-monitor-section {
  display: flex;
  flex-direction: column;
}

.cb-section-tag {
  font-size: 14px;
  font-weight: 700;
  color: var(--md-sys-color-outline);
  margin-bottom: 8px;
  letter-spacing: 0.3px;
}

.cb-field-header-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 6px;
}

.cb-tag-optional {
  font-size: 12px;
  font-weight: 500;
  color: var(--md-sys-color-outline);
}

/* 客户选择：通栏 M3 Elevated Card 风格 */
.cb-cust-placard-btn {
  width: 100%;
  min-height: 64px;
  background: var(--md-sys-color-surface);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  box-shadow: var(--md-sys-elevation-1);
  padding: 12px 18px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-sizing: border-box;
  text-align: left;
  transition: box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-cust-placard-btn:hover {
  box-shadow: var(--md-sys-elevation-2);
}

.cb-placard-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

/* 编号牌：无容器，主题色 + 加粗 + 下划线 */
.cb-placard-code-box {
  padding: 0;
  height: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.cb-placard-code-val {
  font-family: var(--cb-font-numeric);
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.5px;
  line-height: 1;
  color: var(--cb-accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-thickness: 2px;
}

.cb-placard-names-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.cb-placard-name-main {
  font-size: 20px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  line-height: 1.25;
}

.cb-placard-fullname-sub {
  font-size: 13px;
  color: var(--md-sys-color-on-surface-variant);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cb-placard-right {
  flex-shrink: 0;
  padding-left: 10px;
}

.cb-clean-switch-text {
  font-size: 14px;
  font-weight: 700;
  color: var(--md-sys-color-primary);
  letter-spacing: 0.2px;
}

/* 大类 1/3 满宽横向均分 M3 Primary Tabs */
.cb-major-tabs-third-grid {
  display: flex;
  width: 100%;
  border-bottom: 2px solid var(--md-sys-color-outline-variant);
}

.cb-major-third-tab {
  flex: 1;
  text-align: center;
  padding: 14px 0 16px;
  background: transparent;
  border: none;
  font-size: 19px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface-variant);
  position: relative;
  cursor: pointer;
  box-sizing: border-box;
}

.cb-major-third-tab--active {
  color: var(--md-sys-color-on-surface);
  font-weight: 800;
}

.cb-major-third-tab--active::after {
  content: '';
  position: absolute;
  bottom: -2px;
  left: 15%;
  right: 15%;
  height: 3.5px;
  background: var(--md-sys-color-primary);
  border-radius: 2px;
}

/* 小类头部 */
.cb-subcat-section-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 8px;
}

.cb-unit-reminder {
  font-size: 13px;
  color: var(--md-sys-color-on-surface-variant);
}

.cb-unit-reminder strong {
  color: var(--md-sys-color-on-surface);
}

/* 小类展示：无边界 + 微阴影 M3 Elevated Card 风格 */
.cb-subcat-direct-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(105px, 1fr));
  gap: 12px;
}

.cb-subcat-direct-btn {
  height: 52px;
  background: var(--md-sys-color-surface);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  box-shadow: var(--md-sys-elevation-1);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 12px;
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-direct-name {
  font-size: 16px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
}

.cb-direct-unit {
  font-size: 13px;
  color: var(--md-sys-color-on-surface-variant);
  font-weight: 500;
}

.cb-subcat-direct-btn:hover {
  box-shadow: var(--md-sys-elevation-2);
}

.cb-subcat-direct-btn--active {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  box-shadow: var(--md-sys-elevation-2);
  border: none;
}

.cb-subcat-direct-btn--active .cb-direct-name {
  color: var(--md-sys-color-on-primary-container);
  font-weight: 800;
}

.cb-subcat-direct-btn--active .cb-direct-unit {
  color: var(--md-sys-color-on-primary-container);
  opacity: 0.85;
}

.cb-subcat-dropdown-row {
  width: 100%;
  height: 56px;
  background: var(--md-sys-color-surface);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  box-shadow: var(--md-sys-elevation-1);
  padding: 0 18px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  transition: box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-subcat-dropdown-row:hover {
  box-shadow: var(--md-sys-elevation-2);
}

.cb-dropdown-row-left {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.cb-subcat-focus-name {
  font-size: 18px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

.cb-subcat-focus-unit {
  font-size: 14px;
  color: var(--md-sys-color-on-surface-variant);
  font-weight: 600;
}

/* ==========================================================================
   4 & 5. M3 浅下划线直输输入框 (系统输入法唤起)
   ========================================================================== */
.m3-underline-field {
  position: relative;
  padding: 4px 0 2px;
}

.m3-underline-input-box {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.cb-inline-error {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--md-sys-color-error);
}

.m3-native-input {
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--cb-font-numeric);
  font-size: 38px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  line-height: 1.2;
  padding: 6px 0 8px;
  letter-spacing: -0.5px;
}

.m3-native-input::placeholder {
  color: var(--md-sys-color-outline);
  font-weight: 500;
  font-size: 28px;
}

.m3-unit-suffix {
  font-size: 20px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface-variant);
  flex-shrink: 0;
}

.m3-currency-prefix {
  font-size: 26px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface-variant);
  flex-shrink: 0;
}

/* 浅下划线指示线及 Focus 动画 */
.m3-bottom-line {
  position: relative;
  width: 100%;
  height: 2px;
  background-color: var(--md-sys-color-outline-variant);
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
              height var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.m3-underline-field:focus-within .m3-bottom-line {
  height: 3px;
  background-color: var(--md-sys-color-primary);
}

/* M3 Filled Button 保存按钮 */
.cb-large-submit-btn {
  width: 100%;
  height: 56px;
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: 18px;
  font-weight: 800;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  box-shadow: var(--md-sys-elevation-2);
  margin-top: 6px;
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-large-submit-btn:hover {
  box-shadow: var(--md-sys-elevation-3);
  background: var(--cb-accent-hover);
}

/* 下滑提示 */
.cb-down-cue-handle {
  width: 100%;
  padding: 10px 0 4px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: transparent;
  border: none;
  border-top: 1px dashed var(--md-sys-color-outline-variant);
  font-size: 13px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
}

/* 下方流水明细面板 */
.cb-flow-stream-panel {
  padding: 16px 14px calc(var(--cb-tabbar-height) + env(safe-area-inset-bottom, 0px) + 24px);
  background: var(--md-sys-color-surface-dim);
}

.cb-stream-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.cb-stream-title {
  margin: 0;
  font-size: 16px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

.cb-stream-count-badge {
  font-size: 12px;
  font-weight: 700;
  background: var(--md-sys-color-surface);
  box-shadow: var(--md-sys-elevation-1);
  padding: 2px 8px;
  border-radius: var(--md-sys-shape-corner-small);
  color: var(--md-sys-color-on-surface-variant);
}

.cb-stream-empty {
  text-align: center;
  padding: 36px;
  color: var(--md-sys-color-outline);
  font-size: 14px;
}

.cb-stream-items-wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cb-stream-row-btn {
  width: 100%;
  text-align: left;
  background: var(--md-sys-color-surface);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  box-shadow: var(--md-sys-elevation-1);
  padding: 12px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  transition: box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-stream-row-btn:hover {
  box-shadow: var(--md-sys-elevation-2);
}

.cb-stream-col-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.cb-stream-cust-line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cb-stream-code {
  color: var(--cb-accent);
  font-family: var(--cb-font-numeric);
  font-size: 15px;
  font-weight: 800;
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-thickness: 2px;
}

.cb-stream-name {
  font-size: 16px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

.cb-stream-service {
  font-size: 13px;
  color: var(--md-sys-color-on-surface-variant);
}

.cb-stream-time {
  font-family: var(--cb-font-numeric);
  font-size: 11px;
  color: var(--md-sys-color-outline);
}

.cb-stream-col-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
}

.cb-stream-qty-line {
  display: flex;
  align-items: baseline;
  gap: 2px;
}

.cb-stream-qty-val {
  font-family: var(--cb-font-numeric);
  font-size: 19px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

.cb-stream-qty-unit {
  font-size: 12px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface-variant);
}

.cb-stream-money-val {
  font-family: var(--cb-font-numeric);
  font-size: 14px;
  font-weight: 700;
  color: var(--cb-status-success-text);
}

.cb-stream-unpriced-val {
  font-family: var(--cb-font-numeric);
  font-size: 12px;
  font-weight: 600;
  color: var(--cb-status-warning-text);
}

/* 底部滑出抽屉（M3 Modal Bottom Sheet） */
.cb-sheet-backdrop {
  position: fixed;
  inset: 0;
  background: var(--cb-overlay);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 1000;
}

.cb-sheet-drawer {
  width: 100%;
  max-width: 500px;
  max-height: 75vh;
  background: var(--md-sys-color-surface);
  border-radius: var(--md-sys-shape-corner-extra-large) var(--md-sys-shape-corner-extra-large) 0 0;
  padding: 12px 18px calc(24px + env(safe-area-inset-bottom, 0));
  display: flex;
  flex-direction: column;
  box-shadow: var(--md-sys-elevation-4);
}

.m3-sheet-handle-pill {
  width: 36px;
  height: 4px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-outline-variant);
  margin: 0 auto 12px;
}

.cb-sheet-drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.cb-sheet-drawer-title {
  margin: 0;
  font-size: 18px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

.cb-sheet-drawer-close {
  background: var(--md-sys-color-surface-container);
  border: none;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  font-size: 13px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
}

.cb-sheet-search-wrap {
  margin-bottom: 10px;
}

.cb-sheet-search-field {
  width: 100%;
  height: 44px;
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  padding: 0 14px;
  font-size: 16px;
  box-sizing: border-box;
  outline: none;
  color: var(--md-sys-color-on-surface);
}

.cb-sheet-options-list {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cb-sheet-option-item {
  width: 100%;
  height: 52px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 14px;
  background: var(--md-sys-color-surface);
  border: none;
  box-shadow: var(--md-sys-elevation-1);
  border-radius: var(--md-sys-shape-corner-medium);
  text-align: left;
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-sheet-option-item--active {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}

.cb-option-left-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.cb-option-code-pill {
  color: var(--cb-accent);
  font-family: var(--cb-font-numeric);
  font-size: 16px;
  font-weight: 800;
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-thickness: 2px;
}

.cb-option-name-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
}

.cb-option-fullname {
  font-size: 13px;
  color: var(--md-sys-color-on-surface-variant);
}

.cb-option-sub-name {
  font-size: 16px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
}

.cb-option-sub-unit {
  font-size: 13px;
  font-weight: 500;
  color: var(--md-sys-color-on-surface-variant);
}

.cb-sheet-divider {
  height: 1px;
  background: var(--md-sys-color-outline-variant);
  margin: 6px 0;
}

.cb-custom-date-picker-row {
  position: relative;
  width: 100%;
  padding: 12px 14px;
  background: var(--md-sys-color-surface-container-low);
  border: 1.5px dashed var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-sizing: border-box;
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-custom-date-picker-row:hover {
  background: var(--md-sys-color-surface);
  border-color: var(--md-sys-color-primary);
  box-shadow: var(--md-sys-elevation-1);
}

.cb-custom-date-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.cb-calendar-emoji {
  font-size: 24px;
}

.cb-custom-date-text-col {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cb-custom-date-title {
  font-size: 15px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

.cb-custom-date-desc {
  font-size: 12px;
  color: var(--md-sys-color-outline);
}

.cb-custom-date-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cb-native-date-hidden-trigger {
  width: 28px;
  height: 28px;
  opacity: 0.01;
  cursor: pointer;
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  height: 100%;
}

.cb-pick-arrow {
  font-size: 20px;
  font-weight: 700;
  color: var(--md-sys-color-primary);
}
</style>
