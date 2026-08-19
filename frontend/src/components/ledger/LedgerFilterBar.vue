<script setup lang="ts">
import { ref, computed } from 'vue'
import { appState } from '../../state/appState'
import { localDateToday, shiftLocalDate } from '../../utils/localDate'

const showSearchInput = ref(false)
const showDateRangeModal = ref(false)

const today = computed(() => localDateToday())
const tempStartDate = ref(today.value)
const tempEndDate = ref(today.value)

const startDateInputRef = ref<HTMLInputElement | null>(null)
const endDateInputRef = ref<HTMLInputElement | null>(null)

function triggerDatePicker(input: HTMLInputElement | null) {
  if (!input) return
  if ('showPicker' in HTMLInputElement.prototype && typeof input.showPicker === 'function') {
    try {
      input.showPicker()
    } catch {
      input.focus()
    }
  } else {
    input.focus()
  }
}

const datePresets = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'this_week', label: '本周' },
  { key: 'this_month', label: '本月' },
  { key: 'all', label: '全部' },
] as const

const quickRanges = computed(() => [
  { label: '近3天', start: shiftLocalDate(today.value, -2), end: today.value },
  { label: '近7天', start: shiftLocalDate(today.value, -6), end: today.value },
  { label: '近30天', start: shiftLocalDate(today.value, -29), end: today.value },
  { label: `${Number(today.value.slice(5, 7))}月上旬`, start: `${today.value.slice(0, 7)}-01`, end: `${today.value.slice(0, 7)}-10` },
])

const customDateLabel = computed(() => {
  if (appState.ledgerFilters.datePreset === 'custom') {
    const s = appState.ledgerFilters.customStartDate.slice(5)
    const e = appState.ledgerFilters.customEndDate.slice(5)
    return `${s} ~ ${e}`
  }
  return '区间'
})

function selectDate(key: typeof datePresets[number]['key']) {
  appState.ledgerFilters.datePreset = key
}

function openDateRangeModal() {
  if (appState.ledgerFilters.datePreset === 'custom') {
    tempStartDate.value = appState.ledgerFilters.customStartDate
    tempEndDate.value = appState.ledgerFilters.customEndDate
  } else {
    tempStartDate.value = today.value
    tempEndDate.value = today.value
  }
  showDateRangeModal.value = true
}

function applyQuickRange(start: string, end: string) {
  tempStartDate.value = start
  tempEndDate.value = end
}

function confirmDateRange() {
  if (tempStartDate.value > tempEndDate.value) {
    alert('起始日期不能大于截止日期')
    return
  }
  appState.ledgerFilters.customStartDate = tempStartDate.value
  appState.ledgerFilters.customEndDate = tempEndDate.value
  appState.ledgerFilters.datePreset = 'custom'
  showDateRangeModal.value = false
}

function selectCustomer(id: number | null) {
  appState.ledgerFilters.customerId = id
}
</script>

<template>
  <div class="cb-filter-bar">
    <!-- 第 1 行：【搜索按钮】+【中间常用日期】+【右侧查区间按钮】 -->
    <div class="cb-filter-row-top">
      <!-- 搜索展开按键（左侧） -->
      <button
        type="button"
        class="cb-search-trigger-btn cb-pressable"
        :class="{ 'cb-search-trigger-btn--active': showSearchInput || appState.ledgerFilters.searchKeyword }"
        aria-label="展开搜索框"
        title="搜索工单"
        @click="showSearchInput = !showSearchInput"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
      </button>

      <!-- 中间常用日期横滑胶囊 -->
      <div class="cb-date-scroll-row" role="tablist" aria-label="常用日期筛选">
        <button
          v-for="d in datePresets"
          :key="d.key"
          type="button"
          class="cb-date-pill cb-pressable"
          :class="{ 'cb-date-pill--active': appState.ledgerFilters.datePreset === d.key }"
          role="tab"
          :aria-selected="appState.ledgerFilters.datePreset === d.key"
          @click="selectDate(d.key)"
        >
          {{ d.label }}
        </button>
      </div>

      <!-- 右侧查区间大按钮（同排显眼位置） -->
      <button
        type="button"
        class="cb-range-trigger-btn cb-pressable"
        :class="{ 'cb-range-trigger-btn--active': appState.ledgerFilters.datePreset === 'custom' }"
        role="tab"
        :aria-selected="appState.ledgerFilters.datePreset === 'custom'"
        aria-label="自定义日期区间查询"
        @click="openDateRangeModal"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="16" y1="2" x2="16" y2="6"></line>
          <line x1="8" y1="2" x2="8" y2="6"></line>
          <line x1="3" y1="10" x2="21" y2="10"></line>
        </svg>
        <span class="cb-tabular-nums cb-range-btn-text">{{ customDateLabel }}</span>
        <span class="cb-range-arrow" aria-hidden="true">▾</span>
      </button>
    </div>

    <!-- 展开的搜索框（当点击搜索按钮时展示） -->
    <div v-if="showSearchInput" class="cb-search-box-wrap">
      <input
        v-model="appState.ledgerFilters.searchKeyword"
        type="text"
        placeholder="搜索客户编号、简称、品类…"
        class="cb-search-input"
        autocomplete="off"
        spellcheck="false"
        aria-label="按关键词搜索单据"
      />
      <button
        v-if="appState.ledgerFilters.searchKeyword"
        type="button"
        class="cb-search-clear"
        aria-label="清空搜索"
        @click="appState.ledgerFilters.searchKeyword = ''"
      >
        ✕
      </button>
    </div>

    <!-- 第 2 行：纯客户选择行（通栏横向滑动，大触控气泡） -->
    <div class="cb-cust-full-row">
      <div class="cb-cust-bubbles-scroll" role="radiogroup" aria-label="按客户筛选">
        <button
          type="button"
          class="cb-filter-bubble cb-pressable"
          :class="{ 'cb-filter-bubble--active': appState.ledgerFilters.customerId === null }"
          role="radio"
          :aria-checked="appState.ledgerFilters.customerId === null"
          @click="selectCustomer(null)"
        >
          全部客户
        </button>
        <button
          v-for="c in appState.customers"
          :key="c.customerId"
          type="button"
          class="cb-filter-bubble cb-pressable"
          :class="{ 'cb-filter-bubble--active': appState.ledgerFilters.customerId === c.customerId }"
          role="radio"
          :aria-checked="appState.ledgerFilters.customerId === c.customerId"
          @click="selectCustomer(c.customerId)"
        >
          <span class="cb-bubble-code">{{ c.code }}</span>
          <span>{{ c.displayName }}</span>
        </button>
      </div>
    </div>

    <!-- 自定义日期区间选择抽屉模态框 (M3 Modal Bottom Sheet) -->
    <div
      v-if="showDateRangeModal"
      class="cb-date-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="选择自定义日期区间"
      @click.self="showDateRangeModal = false"
    >
      <div class="cb-date-modal-sheet">
        <div class="cb-date-sheet-handle">
          <div class="cb-date-handle-bar"></div>
        </div>

        <div class="cb-date-sheet-header">
          <div class="cb-date-sheet-title-group">
            <h2 class="cb-date-sheet-title">自定义日期区间</h2>
            <span class="cb-date-sheet-sub">支持按起始与截止日期精确查账</span>
          </div>
          <button
            type="button"
            class="cb-date-sheet-close"
            aria-label="关闭日期区间选择"
            @click="showDateRangeModal = false"
          >
            ✕
          </button>
        </div>

        <!-- 快捷区间胶囊 -->
        <div class="cb-quick-ranges-wrap">
          <span class="cb-quick-ranges-label">常用区间：</span>
          <div class="cb-quick-ranges-scroll">
            <button
              v-for="r in quickRanges"
              :key="r.label"
              type="button"
              class="cb-quick-range-chip cb-pressable"
              :class="{ 'cb-quick-range-chip--active': tempStartDate === r.start && tempEndDate === r.end }"
              @click="applyQuickRange(r.start, r.end)"
            >
              {{ r.label }}
            </button>
          </div>
        </div>

        <!-- 区间段日期选择框（大字号思源宋体输入框，直接唤起手机原生日期选择器） -->
        <div class="cb-range-pickers-grid">
          <div
            class="cb-picker-card cb-pressable"
            role="button"
            tabindex="0"
            aria-label="选择起始日期"
            @click="triggerDatePicker(startDateInputRef)"
            @keydown.enter="triggerDatePicker(startDateInputRef)"
          >
            <label class="cb-picker-label">起始日期</label>
            <input
              ref="startDateInputRef"
              v-model="tempStartDate"
              type="date"
              class="cb-native-date-input cb-tabular-nums"
              aria-label="筛选起始日期"
            />
          </div>

          <div class="cb-picker-arrow" aria-hidden="true">➔</div>

          <div
            class="cb-picker-card cb-pressable"
            role="button"
            tabindex="0"
            aria-label="选择截止日期"
            @click="triggerDatePicker(endDateInputRef)"
            @keydown.enter="triggerDatePicker(endDateInputRef)"
          >
            <label class="cb-picker-label">截止日期</label>
            <input
              ref="endDateInputRef"
              v-model="tempEndDate"
              type="date"
              class="cb-native-date-input cb-tabular-nums"
              aria-label="筛选截止日期"
            />
          </div>
        </div>

        <!-- 底部确认操作栏 -->
        <div class="cb-date-modal-actions">
          <button
            type="button"
            class="cb-date-reset-btn cb-pressable"
            aria-label="重置为今天"
            @click="applyQuickRange(today, today)"
          >
            设为今日
          </button>
          <button
            type="button"
            class="cb-date-confirm-btn cb-pressable"
            aria-label="确认筛选该日期区间"
            @click="confirmDateRange"
          >
            确认查询该区间
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cb-filter-bar {
  background: var(--md-sys-color-surface);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  padding: 12px 16px 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cb-filter-row-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cb-date-scroll-row {
  flex: 1;
  display: flex;
  gap: 8px;
  overflow-x: auto;
  scrollbar-width: none;
}
.cb-date-scroll-row::-webkit-scrollbar {
  display: none;
}

.cb-date-pill {
  min-height: 42px;
  padding: 0 16px;
  background: var(--md-sys-color-surface-container);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: 15px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-date-pill--active {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  box-shadow: var(--md-sys-elevation-1);
}

.cb-search-trigger-btn {
  width: 44px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--md-sys-color-surface-container);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  color: var(--md-sys-color-on-surface-variant);
  flex-shrink: 0;
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-search-trigger-btn--active {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  box-shadow: var(--md-sys-elevation-1);
}

.cb-search-box-wrap {
  position: relative;
}

.cb-search-input {
  width: 100%;
  height: 44px;
  background: var(--md-sys-color-surface-container-low);
  border: 1.5px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  padding: 0 36px 0 14px;
  font-size: 16px;
  color: var(--md-sys-color-on-surface);
  outline: none;
  box-sizing: border-box;
}
.cb-search-input:focus {
  border-color: var(--md-sys-color-primary);
  box-shadow: 0 0 0 2px var(--md-sys-color-primary-container);
}

.cb-search-clear {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--md-sys-color-outline);
  font-size: 15px;
  cursor: pointer;
}

/* 查区间大按钮（同排显眼位置） */
.cb-range-trigger-btn {
  min-height: 42px;
  padding: 0 14px;
  background: var(--md-sys-color-surface-container);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: 14px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  cursor: pointer;
  box-shadow: var(--md-sys-elevation-1);
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-range-trigger-btn:hover {
  background: var(--md-sys-color-surface-container-high);
}

.cb-range-trigger-btn--active {
  background: var(--md-sys-color-primary-container);
  border-color: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary-container);
  box-shadow: var(--md-sys-elevation-2);
}

.cb-range-btn-text {
  font-size: 13px;
  letter-spacing: 0.2px;
}

.cb-range-arrow {
  font-size: 11px;
  opacity: 0.7;
}

/* ==========================================================================
   第 2 行：纯客户选择行（通栏横向滑动，大触控气泡）
   ========================================================================== */
.cb-cust-full-row {
  width: 100%;
  display: flex;
}

.cb-cust-bubbles-scroll {
  width: 100%;
  display: flex;
  gap: 8px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 2px 0;
}
.cb-cust-bubbles-scroll::-webkit-scrollbar {
  display: none;
}

.cb-filter-bubble {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 0 14px;
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 14px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-bubble-code {
  font-family: var(--cb-font-numeric);
  font-size: 11px;
  font-weight: 800;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface);
}

.cb-filter-bubble--active {
  background: var(--md-sys-color-on-surface);
  border-color: var(--md-sys-color-on-surface);
  color: var(--md-sys-color-surface);
  box-shadow: var(--md-sys-elevation-1);
}
.cb-filter-bubble--active .cb-bubble-code {
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface);
}

/* ==========================================================================
   自定义日期区间抽屉模态框 (M3 Modal Bottom Sheet)
   ========================================================================== */
.cb-date-modal-backdrop {
  position: fixed;
  inset: 0;
  background: var(--cb-overlay);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 1000;
}

.cb-date-modal-sheet {
  width: 100%;
  max-width: 600px;
  background: var(--md-sys-color-surface);
  border-radius: var(--md-sys-shape-corner-extra-large) var(--md-sys-shape-corner-extra-large) 0 0;
  padding: 12px 20px calc(24px + env(safe-area-inset-bottom, 0px));
  box-shadow: var(--md-sys-elevation-4);
  box-sizing: border-box;
}

.cb-date-sheet-handle {
  display: flex;
  justify-content: center;
  margin-bottom: 12px;
}

.cb-date-handle-bar {
  width: 36px;
  height: 4px;
  background: var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-full);
}

.cb-date-sheet-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}

.cb-date-sheet-title {
  margin: 0;
  font-size: 19px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  letter-spacing: -0.3px;
}

.cb-date-sheet-sub {
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
}

.cb-date-sheet-close {
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

/* 常用快捷区间 */
.cb-quick-ranges-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}

.cb-quick-ranges-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--md-sys-color-outline);
  white-space: nowrap;
}

.cb-quick-ranges-scroll {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
}
.cb-quick-ranges-scroll::-webkit-scrollbar {
  display: none;
}

.cb-quick-range-chip {
  padding: 6px 12px;
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: 13px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
  white-space: nowrap;
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-quick-range-chip:hover {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}

.cb-quick-range-chip--active {
  background: var(--md-sys-color-primary-container);
  border-color: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary-container);
  font-weight: 800;
}

/* 起止日期卡片网格 */
.cb-range-pickers-grid {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 8px;
  margin-bottom: 20px;
}

.cb-picker-card {
  background: var(--md-sys-color-surface-container-low);
  border: 1.5px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
  transition: border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-picker-card:focus-within {
  border-color: var(--md-sys-color-primary);
  box-shadow: 0 0 0 2px var(--md-sys-color-primary-container);
}

.cb-picker-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--md-sys-color-outline);
}

.cb-native-date-input {
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--cb-font-numeric);
  font-size: 16px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  box-sizing: border-box;
  cursor: pointer;
}

.cb-picker-arrow {
  color: var(--md-sys-color-outline);
  font-size: 16px;
  font-weight: 800;
}

/* 底部操作 */
.cb-date-modal-actions {
  display: flex;
  gap: 10px;
}

.cb-date-reset-btn {
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

.cb-date-confirm-btn {
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
.cb-date-confirm-btn:hover {
  background: var(--cb-accent-hover);
  box-shadow: var(--md-sys-elevation-3);
}
</style>
