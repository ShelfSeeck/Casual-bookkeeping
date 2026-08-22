<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { showConfirmDialog, showFailToast, showSuccessToast } from 'vant'
import type { WorkOrderUi } from '../../types/ui'
import StatusBadge from '../common/StatusBadge.vue'
import { appState } from '../../state/appState'
import { toErrorMessage } from '../../services/errorMessages'
import {
  isAllowedDecimalKey,
  isAllowedIntegerKey,
  sanitizeDecimalInput,
  sanitizeIntegerInput,
} from '../../utils/numericInput'
import { localDateToday, shiftLocalDate } from '../../utils/localDate'

const props = defineProps<{
  order: WorkOrderUi
}>()

const emit = defineEmits<{
  (e: 'back'): void
}>()

// 表单响应式数据（与首页工单台完全一致）
const selectedCustomerId = ref<number>(props.order.customerId)
const selectedCategoryName = ref(props.order.categoryName)
const selectedSubcategoryName = ref(props.order.subcategoryName)
const unit = ref(props.order.unit)
const quantityStr = ref(String(props.order.quantity))
const unitPriceStr = ref(
  props.order.unitPriceCents != null ? (props.order.unitPriceCents / 100).toFixed(2) : ''
)
const quantityError = ref('')
const unitPriceError = ref('')
const orderDate = ref(props.order.orderDate)
const isCompleted = ref<boolean>(Boolean(props.order.isCompleted))
const today = computed(() => localDateToday())
const yesterday = computed(() => shiftLocalDate(today.value, -1))
const dayBefore = computed(() => shiftLocalDate(today.value, -2))

// 内部操作中标志位，防止 appState.reload() 触发 watch 误重置表单
let isInternalAction = false

// 记忆每个大类下用户选择的小类名称
const categorySubcategoryMemory = reactive<Record<string, string>>({
  [props.order.categoryName]: props.order.subcategoryName,
})

// activeOrder 改为 computed 后，reload 会用新对象替换 props.order；表单 refs 需在外部变化时重新初始化，
// 否则面板仍显示旧值。以 orderId 为唯一切换重置触发条件（避免同单由于局部更新 reload 导致编辑中的表单被覆盖）。
function syncFormFromOrder() {
  selectedCustomerId.value = props.order.customerId
  selectedCategoryName.value = props.order.categoryName
  selectedSubcategoryName.value = props.order.subcategoryName
  unit.value = props.order.unit
  quantityStr.value = String(props.order.quantity)
  unitPriceStr.value =
    props.order.unitPriceCents != null ? (props.order.unitPriceCents / 100).toFixed(2) : ''
  orderDate.value = props.order.orderDate
  isCompleted.value = Boolean(props.order.isCompleted)
  quantityError.value = ''
  unitPriceError.value = ''
  categorySubcategoryMemory[props.order.categoryName] = props.order.subcategoryName
}

watch(
  () => props.order.orderId,
  (newId, oldId) => {
    if (newId !== oldId && !isInternalAction) {
      syncFormFromOrder()
    }
  },
)

// 弹窗控制
const showCustomerSheet = ref(false)
const showSubcategorySheet = ref(false)
const showDatePickerSheet = ref(false)
const customerSearch = ref('')
const customDateInputRef = ref<HTMLInputElement | null>(null)

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
  return (
    appState.customers.find((c) => c.customerId === selectedCustomerId.value) ||
    appState.customers[0]
  )
})

// 过滤后的客户列表
const filteredCustomers = computed(() => {
  if (!customerSearch.value.trim()) {
    return appState.customers
  }
  const q = customerSearch.value.trim().toLowerCase()
  return appState.customers.filter((c) => {
    return (
      c.code.toLowerCase().includes(q) ||
      c.displayName.toLowerCase().includes(q) ||
      c.customerName.toLowerCase().includes(q)
    )
  })
})

// 可选大类列表（启用大类在前，已停用大类在后）
const selectableCategories = computed(() => {
  const activeList = appState.categories.filter((c) => c.isActive)
  const inactiveList = appState.categories.filter((c) => !c.isActive)
  return [...activeList, ...inactiveList]
})

// 当前激活的大类
const activeCategory = computed(() => {
  return appState.categories.find((c) => c.name === selectedCategoryName.value)
})

// 小类数量是否较多
const isSubcatMany = computed(() => {
  if (!activeCategory.value) return false
  return activeCategory.value.subcategories.length > 6
})

// 切换大类（若选择已停用大类，弹窗就地引导恢复启用，并保持记忆的小类）
async function selectCategory(catName: string) {
  let cat = appState.categories.find((c) => c.name === catName)
  if (!cat) return

  // 若改选的大类已停用，且并非当前工单原始所属的大类，提示就地恢复启用
  if (!cat.isActive && catName !== props.order.categoryName) {
    try {
      await showConfirmDialog({
        title: '启用服务大类',
        message: `大类「${catName}」当前处于停用状态。确认恢复启用该大类并应用到当前工单吗？`,
        confirmButtonText: '恢复启用',
        cancelButtonText: '取消',
      })
      isInternalAction = true
      await appState.updateCategory(cat.syncId!, { isActive: true })
      showSuccessToast(`已恢复启用大类「${catName}」`)
      // reload 之后重新获取最新的类别对象
      const updatedCat = appState.categories.find((c) => c.name === catName)
      if (updatedCat) cat = updatedCat
    } catch {
      return
    } finally {
      isInternalAction = false
    }
  }

  selectedCategoryName.value = catName

  // 记忆与恢复小类
  if (cat.subcategories.length > 0) {
    // 优先 1：如果是切回工单原始大类，优先选择工单原始小类
    const originalSubName = props.order.categoryName === catName ? props.order.subcategoryName : null
    // 优先 2：使用此大类之前记录过的小类选择
    const rememberedSubName = categorySubcategoryMemory[catName]
    const targetSubName = originalSubName || rememberedSubName

    const foundSub = targetSubName ? cat.subcategories.find((s) => s.name === targetSubName) : null
    if (foundSub) {
      selectedSubcategoryName.value = foundSub.name
      unit.value = foundSub.defaultUnit
    } else {
      const activeSubs = cat.subcategories.filter((s) => s.isActive)
      const fallback = activeSubs.length > 0 ? activeSubs[0] : cat.subcategories[0]
      selectedSubcategoryName.value = fallback.name
      unit.value = fallback.defaultUnit
    }
  } else {
    selectedSubcategoryName.value = ''
    unit.value = '件'
  }

  // 记录选择
  if (selectedSubcategoryName.value) {
    categorySubcategoryMemory[catName] = selectedSubcategoryName.value
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
  if (selectedCategoryName.value) {
    categorySubcategoryMemory[selectedCategoryName.value] = subName
  }
}

// ---------- 实时变更 Diff 状态计算（反色黄色高亮） ----------

// 1. 日期是否已修改
const isDateDirty = computed(() => orderDate.value !== props.order.orderDate)

// 2. 客户是否已修改
const isCustomerDirty = computed(() => selectedCustomerId.value !== props.order.customerId)

// 3. 服务大类是否已修改
const isCategoryDirty = computed(() => selectedCategoryName.value !== props.order.categoryName)

// 4. 服务小类是否已修改（只要大类变更，或小类名称变更，小类均属于修改状态）
const isSubcategoryDirty = computed(
  () =>
    selectedCategoryName.value !== props.order.categoryName ||
    selectedSubcategoryName.value !== props.order.subcategoryName
)

// 5. 数量是否已修改
const isQuantityDirty = computed(() => {
  const current = parseInt(quantityStr.value, 10)
  return !isNaN(current) && current !== props.order.quantity
})

// 6. 单价是否已修改
const parsedPriceCents = computed(() => {
  if (unitPriceStr.value.trim() === '') return null
  const p = parseFloat(unitPriceStr.value)
  return !isNaN(p) && p > 0 ? Math.round(p * 100) : null
})

const isUnitPriceDirty = computed(() => {
  return parsedPriceCents.value !== props.order.unitPriceCents
})

// 7. 是否完成状态是否已修改
const isCompletedDirty = computed(() => isCompleted.value !== props.order.isCompleted)

// 8. 统计已修改字段数量
const dirtyFieldsCount = computed(() => {
  let count = 0
  if (isDateDirty.value) count++
  if (isCustomerDirty.value) count++
  if (isCategoryDirty.value) count++
  if (isSubcategoryDirty.value) count++
  if (isQuantityDirty.value) count++
  if (isUnitPriceDirty.value) count++
  if (isCompletedDirty.value) count++
  return count
})

// 动态总价计算
const computedTotalAmount = computed(() => {
  const p = parseFloat(unitPriceStr.value)
  const qty = parseInt(quantityStr.value, 10)
  if (isNaN(p) || p <= 0 || isNaN(qty) || qty <= 0) return null
  return (p * qty).toFixed(2)
})

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

// 保存修改：按需提交差异字段（Surgical Patch）
async function handleSave() {
  const qty = parseInt(quantityStr.value, 10)
  if (isNaN(qty) || qty <= 0) {
    alert('请输入有效工单数量')
    return
  }

  const cust = currentCustomer.value
  if (!cust) {
    alert('请选择有效客户')
    return
  }

  let priceCents: number | null = null
  if (unitPriceStr.value.trim() !== '') {
    const p = parseFloat(unitPriceStr.value)
    if (!isNaN(p)) {
      priceCents = Math.round(p * 100)
    }
  }

  const patch: Partial<WorkOrderUi> = {}

  if (orderDate.value !== props.order.orderDate) {
    patch.orderDate = orderDate.value
  }
  if (cust.customerId !== props.order.customerId) {
    patch.customerId = cust.customerId
  }
  if (selectedCategoryName.value !== props.order.categoryName) {
    patch.categoryName = selectedCategoryName.value
  }
  if (selectedSubcategoryName.value !== props.order.subcategoryName) {
    patch.subcategoryName = selectedSubcategoryName.value
  }
  if (qty !== props.order.quantity) {
    patch.quantity = qty
  }
  if (unit.value !== props.order.unit) {
    patch.unit = unit.value
  }
  if (priceCents !== props.order.unitPriceCents) {
    patch.unitPriceCents = priceCents
  }
  if (isCompleted.value !== props.order.isCompleted) {
    patch.isCompleted = isCompleted.value
  }

  if (Object.keys(patch).length === 0) {
    showSuccessToast('工单内容未变更')
    emit('back')
    return
  }

  try {
    await appState.updateWorkOrder(props.order.orderId, patch)
    showSuccessToast('工单修改已保存')
    emit('back')
  } catch (e) {
    showFailToast(toErrorMessage(e))
  }
}

// 完成标记切换（纳入统一修改流，只在本地响应式切换状态）
function toggleComplete() {
  isCompleted.value = !isCompleted.value
}

// 删除工单（软删，提交后由 UndoSnackbar 提供即时撤回）
async function handleDelete() {
  if (!confirm(`确定要删除【${props.order.customerDisplayName} - ${props.order.subcategoryName}】这张工单吗？`)) {
    return
  }
  // 先关闭详情面板再执行删除：删除会立即把工单从列表移除、导致本组件被卸载，
  // 若等删除完成后再 emit('back')，父组件监听器已解绑，activeOrderId 会残留在
  // LedgerView，撤回恢复工单后面板会意外自动重开（回归见 UI 冒烟 A3）。
  emit('back')
  try {
    await appState.deleteWorkOrder(props.order.syncId ?? props.order.orderId)
    showSuccessToast('工单已删除')
  } catch (e) {
    showFailToast(toErrorMessage(e))
  }
}

// 撤回历史中的某次修改：本地列表不立即变，Push→Pull 后生效
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
  <div class="cb-order-edit-page">
    <!-- 顶部导航栏 -->
    <header class="md3-top-app-bar">
      <button
        type="button"
        class="md3-icon-button cb-pressable"
        aria-label="返回账本列表"
        @click="emit('back')"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5M12 19l-7-7 7-7"/>
        </svg>
      </button>
      <div class="md3-top-app-bar-title-group">
        <h1 class="md3-top-app-bar-title">工单详情与编辑</h1>
        <div class="md3-top-app-bar-sub cb-tabular-nums">
          <span>单号: {{ order.orderId }}</span>
          <StatusBadge type="sync" :value="order.syncStatus" />
        </div>
      </div>
      <button
        type="button"
        class="md3-icon-button md3-icon-button--error cb-pressable"
        aria-label="删除工单"
        @click="handleDelete"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    </header>

    <!-- 主编辑控制面板（与首页工单台完全一致） -->
    <div class="cb-console-panel">
      <!-- 顶部时间大字监控行 -->
      <div class="cb-top-time-bar" :class="{ 'cb-top-time-bar--dirty': isDateDirty }">
        <button
          type="button"
          class="cb-time-big-trigger cb-pressable"
          aria-label="点击修改工单日期"
          @click="showDatePickerSheet = true"
        >
          <div class="cb-time-big-group cb-tabular-nums">
            <span class="cb-time-big-date" :class="{ 'cb-text-dirty': isDateDirty }">{{ orderDate }}</span>
            <span v-if="orderDate === today" class="cb-time-today-tag" :class="{ 'cb-time-today-tag--dirty': isDateDirty }">今天</span>
            <span v-else-if="orderDate === yesterday" class="cb-time-today-tag" :class="{ 'cb-time-today-tag--dirty': isDateDirty }">昨天</span>
          </div>
          <span class="cb-time-switch-icon" :class="{ 'cb-text-dirty': isDateDirty }" aria-hidden="true">切换日期 ▾</span>
        </button>
      </div>

      <!-- 1. 客户选择卡片（M3 Elevated Card 风格） -->
      <div class="cb-monitor-section">
        <label class="cb-section-tag">客户 (编号 + 简称)</label>
        <button
          type="button"
          class="cb-cust-placard-btn cb-pressable"
          :class="{ 'cb-cust-placard-btn--dirty': isCustomerDirty }"
          aria-label="选择客户"
          @click="showCustomerSheet = true"
        >
          <div class="cb-placard-left">
            <div class="cb-placard-code-box">
              <span class="cb-placard-code-val" :class="{ 'cb-text-dirty': isCustomerDirty }">{{ currentCustomer.code }}</span>
            </div>
            <div class="cb-placard-names-col">
              <span class="cb-placard-name-main" :class="{ 'cb-text-dirty': isCustomerDirty }">{{ currentCustomer.displayName }}</span>
              <span class="cb-placard-fullname-sub">{{ currentCustomer.customerName }}</span>
            </div>
          </div>
          <div class="cb-placard-right">
            <span class="cb-clean-switch-text" :class="{ 'cb-text-dirty': isCustomerDirty }">切换 ▾</span>
          </div>
        </button>
      </div>

      <!-- 2. 服务大类（M3 Primary Tabs） -->
      <div class="cb-monitor-section">
        <label class="cb-section-tag">服务大类</label>
        <div class="cb-major-tabs-third-grid" role="tablist" aria-label="服务大类">
          <button
            v-for="cat in selectableCategories"
            :key="cat.categoryId"
            type="button"
            class="cb-major-third-tab cb-pressable"
            :class="{
              'cb-major-third-tab--active': selectedCategoryName === cat.name && !isCategoryDirty,
              'cb-major-third-tab--dirty-active': selectedCategoryName === cat.name && isCategoryDirty,
              'cb-major-third-tab--inactive': !cat.isActive
            }"
            role="tab"
            :aria-selected="selectedCategoryName === cat.name"
            @click="selectCategory(cat.name)"
          >
            <span class="cb-tab-name-text">
              {{ cat.name }}<span v-if="!cat.isActive" class="cb-inactive-tag"> (已停用)</span>
            </span>
          </button>
        </div>
      </div>

      <!-- 3. 小类展示区（无边界 + 微阴影 M3 Elevated 风格） -->
      <div v-if="activeCategory" class="cb-monitor-section">
        <div class="cb-subcat-section-header">
          <label class="cb-section-tag">具体小类 ({{ selectedCategoryName }})</label>
          <span class="cb-unit-reminder">默认单位: <strong :class="{ 'cb-text-dirty': isSubcategoryDirty }">{{ unit }}</strong></span>
        </div>

        <!-- 数量 <= 6 时，无边界 + 微阴影直选卡片平铺 -->
        <div v-if="!isSubcatMany" class="cb-subcat-direct-grid" role="group" aria-label="具体小类选项">
          <button
            v-for="sub in activeCategory.subcategories"
            :key="sub.name"
            type="button"
            class="cb-subcat-direct-btn cb-pressable"
            :class="{
              'cb-subcat-direct-btn--active': selectedSubcategoryName === sub.name && !isSubcategoryDirty,
              'cb-subcat-direct-btn--dirty-active': selectedSubcategoryName === sub.name && isSubcategoryDirty,
            }"
            @click="chooseSubcategory(sub.name, sub.defaultUnit)"
          >
            <span class="cb-direct-name">{{ sub.name }}</span>
            <span class="cb-direct-unit">({{ sub.defaultUnit }})</span>
          </button>
        </div>

        <!-- 数量 > 6 时，无边界 + 微阴影下拉菜单条 -->
        <button
          v-else
          type="button"
          class="cb-subcat-dropdown-row cb-pressable"
          :class="{ 'cb-subcat-dropdown-row--dirty': isSubcategoryDirty }"
          aria-label="选择具体小类"
          @click="showSubcategorySheet = true"
        >
          <div class="cb-dropdown-row-left">
            <span class="cb-subcat-focus-name" :class="{ 'cb-text-dirty': isSubcategoryDirty }">{{ selectedSubcategoryName }}</span>
            <span class="cb-subcat-focus-unit" :class="{ 'cb-text-dirty': isSubcategoryDirty }">单位: {{ unit }}</span>
          </div>
          <span class="cb-clean-switch-text" :class="{ 'cb-text-dirty': isSubcategoryDirty }" aria-hidden="true">切换小类 ▾</span>
        </button>
      </div>

      <!-- 4. 数量输入（M3 浅下划线直输模式） -->
      <div class="cb-monitor-section">
        <div class="cb-field-header-row">
          <label for="edit-order-qty-input" class="cb-section-tag">工单数量 *</label>
          <span class="cb-unit-reminder">单位: <strong :class="{ 'cb-text-dirty': isQuantityDirty }">{{ unit }}</strong></span>
        </div>
        <div class="m3-underline-field">
          <div class="m3-underline-input-box">
            <input
              id="edit-order-qty-input"
              :value="quantityStr"
              type="text"
              inputmode="numeric"
              pattern="[0-9]*"
              class="m3-native-input cb-tabular-nums"
              :class="{ 'cb-input--dirty': isQuantityDirty }"
              placeholder="0"
              autocomplete="off"
              aria-label="工单数量"
              @keydown="onQuantityKeydown"
              @input="onQuantityInput"
            />
            <span class="m3-unit-suffix" :class="{ 'cb-text-dirty': isQuantityDirty }">{{ unit }}</span>
          </div>
          <p v-if="quantityError" class="cb-inline-error" role="alert">{{ quantityError }}</p>
          <div class="m3-bottom-line" :class="{ 'm3-bottom-line--dirty': isQuantityDirty }" aria-hidden="true"></div>
        </div>
      </div>

      <!-- 5. 单价输入（M3 浅下划线直输模式） -->
      <div class="cb-monitor-section">
        <div class="cb-field-header-row">
          <label for="edit-order-price-input" class="cb-section-tag">
            单价 <span class="cb-tag-optional">可选 (元/{{ unit }})</span>
          </label>
          <span
            v-if="computedTotalAmount != null"
            class="cb-computed-total-tag cb-tabular-nums"
            :class="{ 'cb-computed-total-tag--dirty': isUnitPriceDirty || isQuantityDirty }"
          >
            合计: <strong>¥{{ computedTotalAmount }}</strong>
          </span>
        </div>
        <div class="m3-underline-field">
          <div class="m3-underline-input-box">
            <span class="m3-currency-prefix" :class="{ 'cb-text-dirty': isUnitPriceDirty }">¥</span>
            <input
              id="edit-order-price-input"
              :value="unitPriceStr"
              type="text"
              inputmode="decimal"
              class="m3-native-input cb-tabular-nums"
              :class="{ 'cb-input--dirty': isUnitPriceDirty }"
              placeholder="未定价"
              autocomplete="off"
              aria-label="工单单价"
              @keydown="onUnitPriceKeydown"
              @input="onUnitPriceInput"
            />
          </div>
          <p v-if="unitPriceError" class="cb-inline-error" role="alert">{{ unitPriceError }}</p>
          <div class="m3-bottom-line" :class="{ 'm3-bottom-line--dirty': isUnitPriceDirty }" aria-hidden="true"></div>
        </div>
      </div>

      <!-- 6. 完成标记切换 + 满宽 M3 Filled Button 保存按钮 -->
      <button
        type="button"
        class="cb-complete-toggle-btn cb-pressable"
        :class="{ 'cb-complete-toggle-btn--dirty': isCompletedDirty }"
        :aria-label="isCompleted ? '标记为未完成' : '标记为完成'"
        @click="toggleComplete"
      >
        {{ isCompleted ? '✓ 已完成，点击改为未完成' : '○ 未完成，点击改为已完成' }}
      </button>

      <button
        type="button"
        class="cb-large-submit-btn cb-pressable"
        :class="{ 'cb-large-submit-btn--dirty': dirtyFieldsCount > 0 }"
        aria-label="保存工单修改"
        @click="handleSave"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>{{ dirtyFieldsCount > 0 ? `保存工单修改 (${dirtyFieldsCount} 处变更)` : '保存工单修改' }}</span>
      </button>

      <!-- 7. 修改轨迹追溯 -->
      <div class="cb-history-card">
        <div class="cb-history-header">
          <div class="cb-history-header-left">
            <span class="cb-history-title">修改轨迹追溯</span>
            <span v-if="orderHistory.length > 0" class="cb-history-count-badge">
              {{ orderHistory.length }} 次记录
            </span>
          </div>
          <span class="cb-history-tip">可追溯历史并一键撤回</span>
        </div>

        <div v-if="orderHistory.length === 0" class="cb-history-empty">
          <div class="cb-history-empty-icon" aria-hidden="true">📋</div>
          <span>暂无历史修改记录</span>
        </div>

        <div v-else class="cb-timeline-list">
          <div
            v-for="(h, idx) in orderHistory"
            :key="h.operationId"
            class="cb-timeline-item"
            :class="{ 'cb-timeline-item--reverted': h.isReverted }"
          >
            <!-- 左侧时间轴轨道与图标 -->
            <div class="cb-timeline-rail">
              <div
                class="cb-timeline-node"
                :class="`cb-timeline-node--${h.iconType || 'update'}`"
                aria-hidden="true"
              >
                <span v-if="h.iconType === 'create'">➕</span>
                <span v-else-if="h.iconType === 'price'">💰</span>
                <span v-else-if="h.iconType === 'complete'">✓</span>
                <span v-else-if="h.iconType === 'revert'">↩️</span>
                <span v-else>✏️</span>
              </div>
              <div
                v-if="idx < orderHistory.length - 1"
                class="cb-timeline-line"
                aria-hidden="true"
              ></div>
            </div>

            <!-- 右侧卡片内容 -->
            <div class="cb-timeline-content">
              <div class="cb-timeline-content-top">
                <div class="cb-timeline-title-wrap">
                  <span class="cb-timeline-summary" :class="{ 'cb-line-through': h.isReverted }">
                    {{ h.summary }}
                  </span>
                  <div class="cb-timeline-badges">
                    <span
                      class="cb-actor-tag"
                      :class="{ 'cb-actor-tag--ai': h.actorType === 'ai' }"
                    >
                      {{ h.actorLabel || (h.actorType === 'ai' ? 'AI 助手' : '本人') }}
                    </span>
                    <span class="cb-device-tag">{{ h.deviceLabel || '本机' }}</span>
                  </div>
                </div>

                <!-- 撤回按钮 / 状态标签 -->
                <div class="cb-timeline-action">
                  <button
                    v-if="h.canRevert"
                    type="button"
                    class="cb-history-revert-btn cb-pressable"
                    aria-label="撤回这次修改"
                    @click="handleRevert(h.operationId)"
                  >
                    撤回这次修改
                  </button>
                  <span
                    v-else-if="h.isReverted"
                    class="cb-history-revert-tag cb-history-revert-tag--dim"
                  >
                    已撤回
                  </span>
                  <span
                    v-else-if="h.operationType === 'revert_operation'"
                    class="cb-history-revert-tag"
                  >
                    撤回记录
                  </span>
                </div>
              </div>

              <!-- 时间行 -->
              <div class="cb-timeline-time-row">
                <span class="cb-timeline-time cb-tabular-nums">
                  {{ h.formattedTime || h.timestamp }}
                </span>
              </div>

              <!-- 变更前后对比 (Diffs) -->
              <div v-if="h.diffs && h.diffs.length > 0" class="cb-timeline-diffs">
                <div
                  v-for="diff in h.diffs"
                  :key="diff.fieldKey"
                  class="cb-diff-pill"
                >
                  <span class="cb-diff-label">{{ diff.fieldLabel }}</span>
                  <div class="cb-diff-comparison cb-tabular-nums">
                    <span class="cb-diff-before">{{ diff.beforeText }}</span>
                    <span class="cb-diff-arrow" aria-hidden="true">→</span>
                    <span class="cb-diff-after">{{ diff.afterText }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
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
            :class="{
              'cb-sheet-option-item--active': sub.name === selectedSubcategoryName && !isSubcategoryDirty,
              'cb-sheet-option-item--dirty-active': sub.name === selectedSubcategoryName && isSubcategoryDirty,
            }"
            role="option"
            :aria-selected="sub.name === selectedSubcategoryName"
            @click="chooseSubcategory(sub.name, sub.defaultUnit)"
          >
            <span class="cb-option-sub-name">{{ sub.name }}</span>
            <span class="cb-option-sub-unit">单位: {{ sub.defaultUnit }}</span>
          </button>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 底部滑出弹窗 3：录入日期快捷选择抽屉 -->
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
.cb-order-edit-page {
  min-height: 100%;
  padding-bottom: calc(var(--cb-tabbar-height) + env(safe-area-inset-bottom, 0px) + 24px);
  background: var(--md-sys-color-surface-dim);
  display: flex;
  flex-direction: column;
}

/* 顶部导航栏 */
.md3-top-app-bar {
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: env(safe-area-inset-top, 0px) 12px 0;
  background: var(--md-sys-color-surface);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  position: sticky;
  top: 0;
  z-index: 100;
  box-sizing: border-box;
}

.md3-icon-button {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  color: var(--md-sys-color-on-surface);
  cursor: pointer;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-icon-button:hover {
  background: var(--md-sys-color-surface-container-high);
}

.md3-icon-button--error {
  color: var(--md-sys-color-error);
}
.md3-icon-button--error:hover {
  background: var(--md-sys-color-error-container);
}

.md3-top-app-bar-title-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.md3-top-app-bar-title {
  margin: 0;
  font-size: 18px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  letter-spacing: -0.2px;
}

.md3-top-app-bar-sub {
  font-size: 11px;
  color: var(--md-sys-color-on-surface-variant);
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 主监控控制面板 */
.cb-console-panel {
  background: var(--md-sys-color-surface);
  padding: 16px 18px 22px;
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

.cb-computed-total-tag {
  font-size: 13px;
  color: var(--md-sys-color-on-surface-variant);
}
.cb-computed-total-tag strong {
  font-family: var(--cb-font-numeric);
  font-size: 16px;
  color: var(--md-sys-color-primary);
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

.cb-major-third-tab--inactive {
  color: var(--md-sys-color-outline);
}

.cb-inactive-tag {
  font-size: 13px;
  font-weight: 500;
  color: var(--md-sys-color-outline);
  margin-left: 4px;
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
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
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

/* 数量 & 单价直输输入框 */
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

.cb-complete-toggle-btn {
  width: 100%;
  height: 48px;
  background: var(--md-sys-color-surface-container);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: 15px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
  cursor: pointer;
  box-shadow: var(--md-sys-elevation-1);
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-complete-toggle-btn:hover {
  background: var(--md-sys-color-surface-container-high);
  box-shadow: var(--md-sys-elevation-2);
}

.cb-complete-toggle-btn--dirty {
  background: var(--cb-status-warning-text, #d97706) !important;
  color: #ffffff !important;
  border: none !important;
  box-shadow: var(--md-sys-elevation-2);
}
.cb-complete-toggle-btn--dirty:hover {
  background: #b45309 !important;
  box-shadow: var(--md-sys-elevation-3);
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
  gap: 8px;
  cursor: pointer;
  box-shadow: var(--md-sys-elevation-2);
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
  margin-top: 10px;
}
.cb-large-submit-btn:hover {
  box-shadow: var(--md-sys-elevation-3);
}

/* ==========================================================================
   实时变更状态高亮 (Live Diff / Dirty Fields - Amber / Warning High Contrast)
   ========================================================================== */

/* ==========================================================================
   实时变更状态高亮 (Live Diff / M3 Warning Tonal Container - 无生硬边线)
   ========================================================================== */

/* 顶部日期修改高亮 */
.cb-top-time-bar--dirty {
  border-bottom-color: var(--cb-status-warning-text, #d97706);
}

.cb-time-today-tag--dirty {
  background: var(--cb-status-warning-bg, #fef3c7) !important;
  color: var(--cb-status-warning-text, #b45309) !important;
}

/* 文本与数字反色黄高亮 */
.cb-text-dirty {
  color: var(--cb-status-warning-text, #d97706) !important;
}

/* 客户卡片脏状态：保持 M3 Elevated 纯净卡片，无边框，采用 Tonal 浅暖底色与强调文字 */
.cb-cust-placard-btn--dirty {
  background: var(--cb-status-warning-bg, #fffbeb) !important;
  border: none !important;
}

/* 服务大类 Tab 脏状态：激活下划线指示条切换为暖黄色 */
.cb-major-third-tab--dirty-active {
  color: var(--cb-status-warning-text, #d97706) !important;
  font-weight: 800;
}

.cb-major-third-tab--dirty-active::after {
  content: '';
  position: absolute;
  bottom: -2px;
  left: 15%;
  right: 15%;
  height: 3.5px;
  background: var(--cb-status-warning-text, #d97706);
  border-radius: 2px;
}

/* 小类按钮脏状态：与下方保存按钮完全统一的中性黄实色填充 (#d97706) */
.cb-subcat-direct-btn--dirty-active {
  background: var(--cb-status-warning-text, #d97706) !important;
  color: #ffffff !important;
  border: none !important;
  box-shadow: var(--md-sys-elevation-2);
}
.cb-subcat-direct-btn--dirty-active .cb-direct-name {
  color: #ffffff !important;
  font-weight: 800;
}
.cb-subcat-direct-btn--dirty-active .cb-direct-unit {
  color: rgba(255, 255, 255, 0.9) !important;
  opacity: 1;
}

.cb-subcat-dropdown-row--dirty {
  background: var(--cb-status-warning-bg, #fffbeb) !important;
  border: none !important;
}

/* 输入框数字变色 */
.cb-input--dirty {
  color: var(--cb-status-warning-text, #d97706) !important;
}

/* 下划线变色 */
.m3-bottom-line--dirty {
  background-color: var(--cb-status-warning-text, #d97706) !important;
  height: 2.5px !important;
}

/* 合计标签变色 */
.cb-computed-total-tag--dirty strong {
  color: var(--cb-status-warning-text, #d97706) !important;
}

/* 保存按钮脏状态：M3 Filled Button 切换为强调填充色 */
.cb-large-submit-btn--dirty {
  background: var(--cb-status-warning-text, #d97706) !important;
  color: #ffffff !important;
  border: none !important;
  box-shadow: var(--md-sys-elevation-2);
}
.cb-large-submit-btn--dirty:hover {
  background: #b45309 !important;
  box-shadow: var(--md-sys-elevation-3);
}

/* 历史轨迹卡片容器 */
.cb-history-card {
  padding: 16px;
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 10px;
}

.cb-history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.cb-history-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cb-history-title {
  font-size: 14px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  letter-spacing: 0.2px;
}

.cb-history-count-badge {
  font-size: 11px;
  font-weight: 700;
  color: var(--md-sys-color-primary);
  background: var(--md-sys-color-primary-container);
  padding: 2px 8px;
  border-radius: var(--md-sys-shape-corner-full);
}

.cb-history-tip {
  font-size: 11px;
  color: var(--md-sys-color-outline);
}

.cb-history-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 20px 0;
  color: var(--md-sys-color-outline);
  font-size: 13px;
}

.cb-history-empty-icon {
  font-size: 24px;
}

/* 时间轴列表 */
.cb-timeline-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.cb-timeline-item {
  display: flex;
  gap: 12px;
  position: relative;
}

.cb-timeline-item--reverted {
  opacity: 0.65;
}

/* 左侧轨道 */
.cb-timeline-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 24px;
  flex-shrink: 0;
}

.cb-timeline-node {
  width: 24px;
  height: 24px;
  border-radius: var(--md-sys-shape-corner-full);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface);
  border: 1.5px solid var(--md-sys-color-outline-variant);
  box-sizing: border-box;
  z-index: 1;
}

.cb-timeline-node--create {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-primary);
  border-color: var(--md-sys-color-primary);
}

.cb-timeline-node--price {
  background: var(--cb-accent-soft, #fef3c7);
  color: var(--cb-accent, #d97706);
  border-color: var(--cb-accent, #f59e0b);
}

.cb-timeline-node--complete {
  background: #dcfce7;
  color: #16a34a;
  border-color: #22c55e;
}

.cb-timeline-node--revert {
  background: var(--md-sys-color-surface-variant);
  color: var(--md-sys-color-outline);
  border-color: var(--md-sys-color-outline);
}

.cb-timeline-line {
  flex: 1;
  width: 2px;
  background: var(--md-sys-color-outline-variant);
  margin: 4px 0;
  min-height: 18px;
}

/* 右侧内容 */
.cb-timeline-content {
  flex: 1;
  min-width: 0;
  padding-bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cb-timeline-content-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}

.cb-timeline-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.cb-timeline-summary {
  font-size: 13px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  line-height: 1.3;
}

.cb-line-through {
  text-decoration: line-through;
  color: var(--md-sys-color-outline);
}

.cb-timeline-badges {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.cb-actor-tag {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface-variant);
}

.cb-actor-tag--ai {
  background: #ede9fe;
  color: #6d28d9;
}

.cb-device-tag {
  font-size: 10px;
  color: var(--md-sys-color-outline);
}

.cb-timeline-time-row {
  display: flex;
  align-items: center;
}

.cb-timeline-time {
  font-size: 11px;
  font-family: var(--cb-font-numeric);
  color: var(--md-sys-color-outline);
}

.cb-timeline-action {
  flex-shrink: 0;
}

.cb-history-revert-btn {
  height: 28px;
  padding: 0 10px;
  background: var(--md-sys-color-primary-container);
  border: 1px solid var(--md-sys-color-primary);
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 11px;
  font-weight: 700;
  color: var(--md-sys-color-on-primary-container);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-history-revert-btn:hover {
  background: var(--cb-accent-hover);
  color: var(--md-sys-color-on-primary);
}

.cb-history-revert-tag {
  font-size: 10px;
  font-weight: 700;
  color: var(--md-sys-color-outline);
  background: var(--md-sys-color-surface-container);
  padding: 3px 8px;
  border-radius: var(--md-sys-shape-corner-full);
  white-space: nowrap;
}

.cb-history-revert-tag--dim {
  background: var(--md-sys-color-surface-variant);
  color: var(--md-sys-color-outline);
}

/* Diffs 胶囊对比块 */
.cb-timeline-diffs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
  background: var(--md-sys-color-surface);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  padding: 8px 10px;
}

.cb-diff-pill {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.cb-diff-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--md-sys-color-outline);
  flex-shrink: 0;
  min-width: 52px;
}

.cb-diff-comparison {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
}

.cb-diff-before {
  color: var(--md-sys-color-outline);
  background: var(--md-sys-color-surface-container);
  padding: 1px 6px;
  border-radius: 4px;
  text-decoration: line-through;
  font-size: 11px;
}

.cb-diff-arrow {
  color: var(--md-sys-color-outline);
  font-size: 11px;
}

.cb-diff-after {
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-high);
  padding: 1px 6px;
  border-radius: 4px;
}

/* 底部滑出抽屉通用样式 (M3 Modal Bottom Sheet) */
.cb-sheet-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--cb-overlay);
  z-index: 1000;
  display: flex;
  align-items: flex-end;
  animation: cb-fade-in 0.2s ease-out;
}

.cb-sheet-drawer {
  width: 100%;
  max-height: 80vh;
  background: var(--md-sys-color-surface);
  border-radius: 20px 20px 0 0;
  padding: 12px 18px calc(24px + env(safe-area-inset-bottom, 0px));
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

.m3-sheet-handle-pill {
  width: 36px;
  height: 4px;
  background: var(--md-sys-color-outline-variant);
  border-radius: 2px;
  margin: 0 auto 12px;
}

.cb-sheet-drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.cb-sheet-drawer-title {
  margin: 0;
  font-size: 17px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

.cb-sheet-drawer-close {
  background: none;
  border: none;
  font-size: 16px;
  font-weight: 800;
  color: var(--md-sys-color-outline);
  cursor: pointer;
  padding: 4px 8px;
}

.cb-sheet-search-wrap {
  margin-bottom: 12px;
}

.cb-sheet-search-field {
  width: 100%;
  height: 44px;
  background: var(--md-sys-color-surface-container);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  padding: 0 14px;
  font-size: 16px;
  color: var(--md-sys-color-on-surface);
  box-sizing: border-box;
  outline: none;
}

.cb-sheet-options-list {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 50vh;
}

.cb-sheet-option-item {
  width: 100%;
  padding: 12px 14px;
  background: var(--md-sys-color-surface-container-low);
  border: 1.5px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  text-align: left;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-sheet-option-item--active {
  background: var(--md-sys-color-primary-container);
  border-color: var(--md-sys-color-primary);
}

.cb-sheet-option-item--dirty-active {
  background: var(--cb-status-warning-text, #d97706) !important;
  border-color: var(--cb-status-warning-text, #d97706) !important;
}
.cb-sheet-option-item--dirty-active .cb-option-sub-name,
.cb-sheet-option-item--dirty-active .cb-option-sub-unit {
  color: #ffffff !important;
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
  font-size: 16px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

.cb-option-fullname {
  font-size: 12px;
  color: var(--md-sys-color-outline);
}

.cb-option-sub-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
}

.cb-option-sub-unit {
  font-size: 13px;
  color: var(--md-sys-color-outline);
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
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
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

@keyframes cb-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes cb-slide-up {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
</style>
