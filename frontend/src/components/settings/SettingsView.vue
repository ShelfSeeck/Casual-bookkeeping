<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { appState } from '../../state/appState'
import { toErrorMessage } from '../../services/errorMessages'
import { getActiveAccount } from '../../services/apiClient'
import { getOrCreateDeviceId } from '../../db/device'
import { applyTheme, getThemePreference, type ThemePreference } from '../../utils/theme'
import type { ServiceCategoryUi } from '../../types/ui'

type SubPageKey = 'main' | 'appearance' | 'customers' | 'customer_new' | 'categories' | 'category_new' | 'sync'

const currentSubPage = ref<SubPageKey>('main')

// ==================== 0. 外观主题（浅色 / 深色 / 跟随系统） ====================
const themePreference = ref<ThemePreference>(getThemePreference())
const themeOptions: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

const themeOptionLabel = computed(
  () => themeOptions.find((option) => option.value === themePreference.value)?.label ?? '跟随系统',
)

function setTheme(preference: ThemePreference) {
  themePreference.value = preference
  applyTheme(preference)
}

// ==================== 1. 客户档案管理 ====================
const customerSearchKeyword = ref('')

const filteredCustomerList = computed(() => {
  const kw = customerSearchKeyword.value.trim().toLowerCase()
  if (!kw) return appState.customers
  return appState.customers.filter(
    (c) =>
      c.code.toLowerCase().includes(kw) ||
      c.displayName.toLowerCase().includes(kw) ||
      c.customerName.toLowerCase().includes(kw)
  )
})

const formCode = ref('')
const formDisplayName = ref('')
const formCustomerName = ref('')
const _today = new Date()
const _todayStr = `${_today.getFullYear()}-${String(_today.getMonth() + 1).padStart(2, '0')}-${String(_today.getDate()).padStart(2, '0')}`
const formValidFrom = ref(_todayStr)

function resetCustomerForm() {
  formCode.value = ''
  formDisplayName.value = ''
  formCustomerName.value = ''
  formValidFrom.value = _todayStr
}

function openNewCustomerPage() {
  resetCustomerForm()
  currentSubPage.value = 'customer_new'
}

async function submitNewCustomer() {
  if (!formCode.value.trim() || !formDisplayName.value.trim() || !formCustomerName.value.trim()) {
    showFailToast('请完整填写速记编号、客户简称与正式全称')
    return
  }
  try {
    await appState.addCustomerWithMapping({
      canonicalName: formCustomerName.value.trim(),
      customerCode: formCode.value.trim(),
      customerName: formDisplayName.value.trim(),
      validFrom: formValidFrom.value || _todayStr,
      validTo: null,
    })
    resetCustomerForm()
    currentSubPage.value = 'customers'
    showSuccessToast('客户档案添加成功')
  } catch (e) {
    showFailToast(toErrorMessage(e))
  }
}

// ==================== 2. 服务品类与项目管理（严格区分大类和小类） ====================
const QUICK_UNITS = ['件', '打', '条', '套', '包', '公斤', '米', '双']

const formNewCatName = ref('')

function openNewCategoryPage() {
  formNewCatName.value = ''
  currentSubPage.value = 'category_new'
}

async function submitNewCategory() {
  const catName = formNewCatName.value.trim()
  if (!catName) {
    showFailToast('请填写大类名称')
    return
  }
  try {
    await appState.addCategory(catName)
    formNewCatName.value = ''
    currentSubPage.value = 'categories'
    showSuccessToast(`服务大类「${catName}」创建成功`)
  } catch (e) {
    showFailToast(toErrorMessage(e))
  }
}

async function toggleCategoryActive(cat: ServiceCategoryUi) {
  try {
    await appState.updateCategory(cat.syncId!, { isActive: !cat.isActive })
    showSuccessToast(cat.isActive ? '已停用该大类' : '已启用该大类')
  } catch (e) {
    showFailToast(toErrorMessage(e))
  }
}

// 在已有大类下添加具体小类项目（小类项目拥有名称与默认计价单位）
const activeAddingCatId = ref<string | null>(null)
const inlineSubName = ref('')
const inlineSubUnit = ref('件')

function startAddSubcategory(cat: ServiceCategoryUi) {
  activeAddingCatId.value = cat.syncId ?? null
  inlineSubName.value = ''
  inlineSubUnit.value = '件'
}

function cancelAddSubcategory() {
  activeAddingCatId.value = null
  inlineSubName.value = ''
  inlineSubUnit.value = '件'
}

async function saveInlineSubcategory(cat: ServiceCategoryUi) {
  const subName = inlineSubName.value.trim()
  const unit = inlineSubUnit.value.trim() || '件'
  if (!subName) {
    showFailToast('请填写项目名称')
    return
  }
  if (cat.subcategories.some((s) => s.name === subName)) {
    showFailToast('该大类下已存在同名项目')
    return
  }
  try {
    await appState.updateCategory(cat.syncId!, {
      subcategories: [
        ...cat.subcategories.map((s) => ({ name: s.name, defaultUnit: s.defaultUnit, isActive: s.isActive })),
        { name: subName, defaultUnit: unit, isActive: true },
      ],
    })
    cancelAddSubcategory()
    showSuccessToast('项目已添加')
  } catch (e) {
    showFailToast(toErrorMessage(e))
  }
}

async function deleteSubcategory(cat: ServiceCategoryUi, subName: string) {
  try {
    await appState.updateCategory(cat.syncId!, {
      subcategories: cat.subcategories
        .filter((s) => s.name !== subName)
        .map((s) => ({ name: s.name, defaultUnit: s.defaultUnit, isActive: s.isActive })),
    })
    showSuccessToast('项目已删除')
  } catch (e) {
    showFailToast(toErrorMessage(e))
  }
}

// ==================== 3. 同步面板 ====================
const syncCounts = ref({ pending: 0, conflict: 0, rejected: 0 })
const syncLoading = ref(false)
const activePhone = ref('')
const deviceId = ref('')

async function loadSyncInfo() {
  syncCounts.value = await appState.syncCounts()
}

async function runSyncNow() {
  if (syncLoading.value) return
  syncLoading.value = true
  try {
    await appState.syncNow()
    await loadSyncInfo()
    showSuccessToast('同步完成')
  } catch (e) {
    showFailToast(toErrorMessage(e))
  } finally {
    syncLoading.value = false
  }
}

async function runRetryRejected() {
  if (syncLoading.value) return
  syncLoading.value = true
  try {
    await appState.retryRejected()
    await loadSyncInfo()
    showSuccessToast('已重试被拒操作')
  } catch (e) {
    showFailToast(toErrorMessage(e))
  } finally {
    syncLoading.value = false
  }
}

onMounted(async () => {
  void loadSyncInfo()
  activePhone.value = (await getActiveAccount()) ?? ''
  deviceId.value = await getOrCreateDeviceId()
})
</script>

<template>
  <div class="cb-settings-view">
    <!-- ====================================================================
         页面 1：主设置页 (MD3 List Group & Tonal Cards)
         ==================================================================== -->
    <div v-if="currentSubPage === 'main'" class="cb-page-container">
      <header class="md3-top-app-bar">
        <h1 class="md3-top-app-bar-large-title">设置</h1>
      </header>

      <main class="cb-settings-body">
        <!-- 组 0：个人信息 -->
        <section class="md3-list-group" aria-label="个人信息">
          <div class="md3-list-group-header">个人信息</div>
          <div class="md3-list-container">
            <div class="md3-list-item">
              <div class="md3-list-item-leading" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                  <circle cx="12" cy="7" r="4"></circle>
                </svg>
              </div>
              <div class="md3-list-item-content">
                <span class="md3-list-item-headline">登录账号</span>
              </div>
              <div class="md3-list-item-trailing">
                <span class="md3-mono-text cb-tabular-nums">{{ activePhone || '—' }}</span>
              </div>
            </div>
          </div>
        </section>

        <!-- 组 1：基础档案 -->
        <section class="md3-list-group" aria-label="基础档案">
          <div class="md3-list-group-header">基础档案</div>
          <div class="md3-list-container">
            <button
              type="button"
              class="md3-list-item cb-pressable"
              aria-label="进入客户与编号管理"
              @click="currentSubPage = 'customers'"
            >
              <div class="md3-list-item-leading" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                  <circle cx="9" cy="7" r="4"></circle>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                  <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>
              </div>
              <div class="md3-list-item-content">
                <span class="md3-list-item-headline">客户与编号</span>
                <span class="md3-list-item-supporting">常用客户速记编号与全称</span>
              </div>
              <div class="md3-list-item-trailing">
                <span class="md3-list-item-meta cb-tabular-nums">{{ appState.customers.length }} 家客户</span>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 18l6-6-6-6"/>
                </svg>
              </div>
            </button>

            <div class="md3-list-divider" aria-hidden="true"></div>

            <button
              type="button"
              class="md3-list-item cb-pressable"
              aria-label="进入服务品类配置"
              @click="currentSubPage = 'categories'"
            >
              <div class="md3-list-item-leading" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
                  <line x1="7" y1="7" x2="7.01" y2="7"></line>
                </svg>
              </div>
              <div class="md3-list-item-content">
                <span class="md3-list-item-headline">服务品类</span>
                <span class="md3-list-item-supporting">服务大类、具体项目与默认单位</span>
              </div>
              <div class="md3-list-item-trailing">
                <span class="md3-list-item-meta cb-tabular-nums">{{ appState.categories.length }} 个大类</span>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 18l6-6-6-6"/>
                </svg>
              </div>
            </button>
          </div>
        </section>

        <!-- 组 2：数据同步 -->
        <section class="md3-list-group" aria-label="数据同步">
          <div class="md3-list-group-header">数据同步</div>
          <div class="md3-list-container">
            <button
              type="button"
              class="md3-list-item cb-pressable"
              aria-label="进入数据同步页面"
              @click="currentSubPage = 'sync'"
            >
              <div class="md3-list-item-leading" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="23 4 23 10 17 10"></polyline>
                  <polyline points="1 20 1 14 7 14"></polyline>
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                </svg>
              </div>
              <div class="md3-list-item-content">
                <span class="md3-list-item-headline">数据同步</span>
                <span class="md3-list-item-supporting">检查与云端数据对齐</span>
              </div>
              <div class="md3-list-item-trailing">
                <span class="md3-badge-success">{{ syncCounts.pending > 0 || syncCounts.conflict > 0 || syncCounts.rejected > 0 ? '待同步' : '已同步' }}</span>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 18l6-6-6-6"/>
                </svg>
              </div>
            </button>
          </div>
        </section>

        <!-- 组 3：账号与设备 -->
        <section class="md3-list-group" aria-label="账号与设备">
          <div class="md3-list-group-header">账号与设备</div>
          <div class="md3-list-container">
            <div class="md3-list-item">
              <div class="md3-list-item-leading" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
                  <line x1="12" y1="18" x2="12.01" y2="18"></line>
                </svg>
              </div>
              <div class="md3-list-item-content">
                <span class="md3-list-item-headline">本机设备编号</span>
              </div>
              <div class="md3-list-item-trailing">
                <span class="md3-mono-text">{{ deviceId || '—' }}</span>
              </div>
            </div>
          </div>
        </section>

        <!-- 组 4：外观（低频设置放在最后） -->
        <section class="md3-list-group" aria-label="外观">
          <div class="md3-list-group-header">外观</div>
          <div class="md3-list-container">
            <button
              type="button"
              class="md3-list-item cb-pressable"
              aria-label="进入外观设置"
              @click="currentSubPage = 'appearance'"
            >
              <div class="md3-list-item-leading" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="13.5" cy="6.5" r="2.5"></circle>
                  <circle cx="17.5" cy="10.5" r="1.5"></circle>
                  <circle cx="8.5" cy="7.5" r="1.5"></circle>
                  <circle cx="6.5" cy="12.5" r="2.5"></circle>
                  <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.8-.1 2.6-.4.5-.2.9-.5 1.3-.9l.9-1.4c.7-1.1.7-2.5 0-3.6l-.4-.6c-.4-.6-1-1-1.7-1.3-2.2-.9-4.9.1-6.2 2-.9 1.3-1.2 3-.7 4.5.2.7.6 1.2 1.1 1.7-1.3.4-2.7-.1-3.5-1.3C3.7 14.6 2 10.3 4.2 6.7 6.3 3.4 10.5 2 12 2z"></path>
                </svg>
              </div>
              <div class="md3-list-item-content">
                <span class="md3-list-item-headline">外观设置</span>
                <span class="md3-list-item-supporting">深浅模式与跟随系统</span>
              </div>
              <div class="md3-list-item-trailing">
                <span class="md3-list-item-meta">{{ themeOptionLabel }}</span>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 18l6-6-6-6"/>
                </svg>
              </div>
            </button>
          </div>
        </section>
      </main>
    </div>

    <!-- ====================================================================
         页面 1.5：外观设置（深浅模式）
         ==================================================================== -->
    <div v-else-if="currentSubPage === 'appearance'" class="cb-page-container">
      <header class="md3-top-app-bar">
        <button
          type="button"
          class="md3-icon-button cb-pressable"
          aria-label="返回设置页"
          @click="currentSubPage = 'main'"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <h1 class="md3-top-app-bar-title">外观设置</h1>
        <div style="width: 48px;"></div>
      </header>

      <main class="cb-subpage-body">
        <section class="md3-list-group" aria-label="深浅模式">
          <div class="md3-list-group-header">深浅模式</div>
          <div class="md3-theme-option-card">
            <p class="md3-theme-option-desc">默认跟随系统自动切换，也可以固定为浅色或深色。</p>
            <div class="md3-segmented-set" role="group" aria-label="选择深浅模式">
              <button
                v-for="option in themeOptions"
                :key="option.value"
                type="button"
                class="md3-segment cb-pressable"
                :class="{ 'md3-segment--selected': themePreference === option.value }"
                :aria-pressed="themePreference === option.value"
                @click="setTheme(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>

    <!-- ====================================================================
         页面 2：客户与编号列表独立页 (MD3 Card Collection & Search Bar)
         ==================================================================== -->
    <div v-else-if="currentSubPage === 'customers'" class="cb-page-container">
      <header class="md3-top-app-bar">
        <button
          type="button"
          class="md3-icon-button cb-pressable"
          aria-label="返回设置页"
          @click="currentSubPage = 'main'"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <h1 class="md3-top-app-bar-title">客户与编号</h1>
        <div style="width: 48px;"></div>
      </header>

      <main class="cb-subpage-body">
        <!-- MD3 Outlined Search Bar (52px, Rounded Full) -->
        <div class="md3-search-bar">
          <svg class="md3-search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            v-model="customerSearchKeyword"
            type="text"
            placeholder="搜索编号或客户名称..."
            class="md3-search-input"
            aria-label="搜索客户"
          />
          <button
            v-if="customerSearchKeyword"
            type="button"
            class="md3-search-clear-btn"
            aria-label="清空搜索"
            @click="customerSearchKeyword = ''"
          >
            ✕
          </button>
        </div>

        <!-- 客户列表卡片流 (MD3 Outlined Cards) -->
        <div class="cb-customer-card-list">
          <div
            v-for="c in filteredCustomerList"
            :key="c.customerId"
            class="md3-card md3-card--outlined cb-cust-item-card"
          >
            <div class="cb-cust-item-left">
              <span class="md3-badge-tonal cb-tabular-nums">{{ c.code }}</span>
              <div class="cb-cust-names-col">
                <span class="cb-cust-disp-name">{{ c.displayName }}</span>
                <span class="cb-cust-full-name">{{ c.customerName }}</span>
              </div>
            </div>
            <div class="cb-cust-item-right">
              <span class="cb-cust-valid-date cb-tabular-nums">自 {{ c.validFrom }} 生效</span>
            </div>
          </div>

          <div v-if="filteredCustomerList.length === 0" class="cb-empty-state">
            <span class="cb-empty-icon">🔍</span>
            <span class="cb-empty-text">未找到匹配的客户档案</span>
          </div>
        </div>
      </main>

      <!-- 底部常驻 MD3 Filled Button -->
      <footer class="md3-bottom-app-bar-cta">
        <button
          type="button"
          class="md3-filled-button cb-pressable"
          aria-label="新增客户档案"
          @click="openNewCustomerPage"
        >
          + 新增客户档案
        </button>
      </footer>
    </div>

    <!-- ====================================================================
         页面 3：新增客户表单独立页 (MD3 Outlined Text Fields)
         ==================================================================== -->
    <div v-else-if="currentSubPage === 'customer_new'" class="cb-page-container">
      <header class="md3-top-app-bar">
        <button
          type="button"
          class="md3-icon-button cb-pressable"
          aria-label="返回客户列表"
          @click="currentSubPage = 'customers'"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <h1 class="md3-top-app-bar-title">新增客户</h1>
        <div style="width: 48px;"></div>
      </header>

      <main class="cb-subpage-body">
        <form class="cb-form-sections" @submit.prevent="submitNewCustomer">
          <!-- 分组 1：日常速记信息 (MD3 Outlined Card) -->
          <section class="md3-card md3-card--outlined" aria-label="速记与日常显示">
            <div class="md3-card-title">速记与日常显示</div>

            <div class="md3-text-field-container">
              <label class="md3-text-field-label">
                速记编号 <span class="cb-required-star">*</span>
              </label>
              <div class="md3-outlined-text-field">
                <input
                  v-model="formCode"
                  type="text"
                  placeholder="例如 009（3位数字）"
                  class="md3-text-field-input cb-tabular-nums"
                  autocomplete="off"
                  spellcheck="false"
                  required
                  aria-label="速记编号"
                />
              </div>
              <span class="md3-supporting-text">工单录入时直接键入该编号快速关联客户</span>
            </div>

            <div class="md3-divider"></div>

            <div class="md3-text-field-container">
              <label class="md3-text-field-label">
                客户简称 <span class="cb-required-star">*</span>
              </label>
              <div class="md3-outlined-text-field">
                <input
                  v-model="formDisplayName"
                  type="text"
                  placeholder="例如 宏兴"
                  class="md3-text-field-input"
                  autocomplete="off"
                  spellcheck="false"
                  required
                  aria-label="客户简称"
                />
              </div>
              <span class="md3-supporting-text">用于手机端工单列表与流水快捷显示</span>
            </div>
          </section>

          <!-- 分组 2：正式全称与生效期 (MD3 Outlined Card) -->
          <section class="md3-card md3-card--outlined" aria-label="正式档案与有效期">
            <div class="md3-card-title">正式档案与有效期</div>

            <div class="md3-text-field-container">
              <label class="md3-text-field-label">
                客户正式全称 <span class="cb-required-star">*</span>
              </label>
              <div class="md3-outlined-text-field">
                <input
                  v-model="formCustomerName"
                  type="text"
                  placeholder="例如 广州宏兴制衣厂"
                  class="md3-text-field-input"
                  autocomplete="off"
                  spellcheck="false"
                  required
                  aria-label="客户正式全称"
                />
              </div>
              <span class="md3-supporting-text">用于对账单与流水汇总导出时的完整抬头</span>
            </div>

            <div class="md3-divider"></div>

            <div class="md3-text-field-container">
              <label class="md3-text-field-label">生效起始日期</label>
              <div class="md3-outlined-text-field">
                <input
                  v-model="formValidFrom"
                  type="date"
                  class="md3-text-field-input cb-tabular-nums"
                  aria-label="生效起始日期"
                />
              </div>
            </div>
          </section>

          <!-- 底部常驻 MD3 Filled Button -->
          <div class="md3-bottom-app-bar-cta">
            <button
              type="submit"
              class="md3-filled-button cb-pressable"
              aria-label="保存客户档案"
            >
              保存客户档案
            </button>
          </div>
        </form>
      </main>
    </div>

    <!-- ====================================================================
         页面 4：服务品类与项目配置独立页 (MD3 Outlined Cards & Input Chips)
         ==================================================================== -->
    <div v-else-if="currentSubPage === 'categories'" class="cb-page-container">
      <header class="md3-top-app-bar">
        <button
          type="button"
          class="md3-icon-button cb-pressable"
          aria-label="返回设置页"
          @click="currentSubPage = 'main'"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <h1 class="md3-top-app-bar-title">服务品类</h1>
        <div style="width: 48px;"></div>
      </header>

      <main class="cb-subpage-body">
        <div class="cb-category-card-list">
          <div
            v-for="cat in appState.categories"
            :key="cat.categoryId"
            class="md3-card md3-card--outlined cb-cat-section-card"
          >
            <div class="cb-cat-header-row">
              <div class="cb-cat-header-left">
                <span class="cb-cat-main-title">{{ cat.name }}</span>
                <span class="md3-badge-tonal-small cb-tabular-nums">{{ cat.subcategories.length }} 个项目</span>
              </div>
              <button
                type="button"
                class="md3-text-button-error cb-pressable"
                :aria-label="(cat.isActive ? '停用大类 ' : '启用大类 ') + cat.name"
                @click="toggleCategoryActive(cat)"
              >
                {{ cat.isActive ? '停用大类' : '启用大类' }}
              </button>
            </div>

            <!-- 小类项目 MD3 Input Chips (含默认单位与删除) -->
            <div class="md3-chip-set">
              <div
                v-for="sub in cat.subcategories"
                :key="sub.name"
                class="md3-input-chip"
              >
                <span class="md3-input-chip-label">{{ sub.name }}</span>
                <span class="md3-input-chip-unit">/ {{ sub.defaultUnit }}</span>
                <button
                  type="button"
                  class="md3-input-chip-del"
                  :aria-label="'删除项目 ' + sub.name"
                  @click.stop="deleteSubcategory(cat, sub.name)"
                >
                  ✕
                </button>
              </div>
            </div>

            <!-- 内联添加小类项目表单（MD3 Outlined Container） -->
            <div v-if="activeAddingCatId === cat.syncId" class="md3-inline-add-container">
              <div class="md3-card-title">为「{{ cat.name }}」添加服务项目</div>
              <div class="cb-form-2col-grid">
                <div class="md3-text-field-container">
                  <label class="md3-text-field-label">项目名称</label>
                  <div class="md3-outlined-text-field">
                    <input
                      v-model="inlineSubName"
                      type="text"
                      placeholder="如 标准 / 加急"
                      class="md3-text-field-input"
                      autocomplete="off"
                      aria-label="项目名称"
                    />
                  </div>
                </div>
                <div class="md3-text-field-container">
                  <label class="md3-text-field-label">默认单位</label>
                  <div class="md3-outlined-text-field">
                    <input
                      v-model="inlineSubUnit"
                      type="text"
                      placeholder="件"
                      class="md3-text-field-input"
                      aria-label="默认单位"
                    />
                  </div>
                </div>
              </div>

              <!-- MD3 Filter Chips: 快捷单位选择 -->
              <div class="md3-field-group" style="margin-top: 4px;">
                <label class="md3-text-field-label">快捷选取单位</label>
                <div class="md3-chip-set">
                  <button
                    v-for="u in QUICK_UNITS"
                    :key="u"
                    type="button"
                    class="md3-filter-chip cb-pressable"
                    :class="{ 'md3-filter-chip--selected': inlineSubUnit === u }"
                    @click="inlineSubUnit = u"
                  >
                    {{ u }}
                  </button>
                </div>
              </div>

              <div class="md3-inline-actions">
                <button
                  type="button"
                  class="md3-outlined-button-small cb-pressable"
                  @click="cancelAddSubcategory"
                >
                  取消
                </button>
                <button
                  type="button"
                  class="md3-filled-button-small cb-pressable"
                  @click="saveInlineSubcategory(cat)"
                >
                  确认添加
                </button>
              </div>
            </div>

            <!-- 未添加时显示的展开按键 -->
            <button
              v-else
              type="button"
              class="md3-dashed-action-btn cb-pressable"
              @click="startAddSubcategory(cat)"
            >
              + 添加服务项目与默认单位
            </button>
          </div>

          <div v-if="appState.categories.length === 0" class="cb-empty-state">
            <span class="cb-empty-icon">🏷️</span>
            <span class="cb-empty-text">暂无服务品类，点击下方按钮添加大类</span>
          </div>
        </div>
      </main>

      <footer class="md3-bottom-app-bar-cta">
        <button
          type="button"
          class="md3-filled-button cb-pressable"
          aria-label="新增服务大类"
          @click="openNewCategoryPage"
        >
          + 新增服务大类
        </button>
      </footer>
    </div>

    <!-- ====================================================================
         页面 5：新增服务大类独立页 (大类仅为分组，无需配置单位)
         ==================================================================== -->
    <div v-else-if="currentSubPage === 'category_new'" class="cb-page-container">
      <header class="md3-top-app-bar">
        <button
          type="button"
          class="md3-icon-button cb-pressable"
          aria-label="返回品类列表"
          @click="currentSubPage = 'categories'"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <h1 class="md3-top-app-bar-title">新增大类</h1>
        <div style="width: 48px;"></div>
      </header>

      <main class="cb-subpage-body">
        <form class="cb-form-sections" @submit.prevent="submitNewCategory">
          <section class="md3-card md3-card--outlined" aria-label="大类名称配置">
            <div class="md3-card-title">大类基础信息</div>

            <div class="md3-text-field-container">
              <label class="md3-text-field-label">
                大类名称 <span class="cb-required-star">*</span>
              </label>
              <div class="md3-outlined-text-field">
                <input
                  v-model="formNewCatName"
                  type="text"
                  placeholder="例如 清洁 / 养护 / 定制"
                  class="md3-text-field-input"
                  autocomplete="off"
                  spellcheck="false"
                  required
                  aria-label="大类名称"
                />
              </div>
              <span class="md3-supporting-text">大类仅作为分组容器。创建完成后可在该大类卡片下添加具体项目与默认单位。</span>
            </div>
          </section>

          <div class="md3-bottom-app-bar-cta">
            <button
              type="submit"
              class="md3-filled-button cb-pressable"
              aria-label="保存大类"
            >
              保存大类
            </button>
          </div>
        </form>
      </main>
    </div>

    <!-- ====================================================================
         页面 6：数据同步状态独立页 (MD3 Elevated Card)
         ==================================================================== -->
    <div v-else-if="currentSubPage === 'sync'" class="cb-page-container">
      <header class="md3-top-app-bar">
        <button
          type="button"
          class="md3-icon-button cb-pressable"
          aria-label="返回设置页"
          @click="currentSubPage = 'main'"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <h1 class="md3-top-app-bar-title">数据同步</h1>
        <div style="width: 48px;"></div>
      </header>

      <main class="cb-subpage-body">
        <div class="md3-card md3-card--elevated cb-sync-status-hero">
          <div class="cb-sync-hero-icon" aria-hidden="true">⚡</div>
          <h2 class="cb-sync-hero-title">
            {{ syncCounts.pending > 0 || syncCounts.conflict > 0 || syncCounts.rejected > 0 ? '有数据待同步' : '数据已完全同步' }}
          </h2>
          <p class="cb-sync-hero-desc">
            {{ syncCounts.pending > 0 || syncCounts.conflict > 0 || syncCounts.rejected > 0 ? '请保持网络可用，点击下方按钮立即同步' : '所有工单与基础档案均已与云端对齐' }}
          </p>
        </div>

        <div class="md3-list-container">
          <div class="md3-list-item">
            <div class="md3-list-item-content">
              <span class="md3-list-item-headline">待上传记录</span>
            </div>
            <div class="md3-list-item-trailing">
              <span class="md3-mono-text">{{ syncCounts.pending }} 笔</span>
            </div>
          </div>

          <div class="md3-list-divider" aria-hidden="true"></div>

          <div class="md3-list-item">
            <div class="md3-list-item-content">
              <span class="md3-list-item-headline">冲突 / 被拒</span>
            </div>
            <div class="md3-list-item-trailing">
              <span class="md3-mono-text">{{ syncCounts.conflict }} / {{ syncCounts.rejected }} 笔</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          class="md3-filled-button cb-pressable"
          style="margin-top: 24px;"
          aria-label="立即同步数据"
          :disabled="syncLoading"
          @click="runSyncNow"
        >
          {{ syncLoading ? '同步中…' : '立即同步数据' }}
        </button>

        <button
          v-if="syncCounts.rejected > 0"
          type="button"
          class="md3-outlined-button-small cb-pressable"
          style="margin-top: 12px;"
          aria-label="重试被拒操作"
          :disabled="syncLoading"
          @click="runRetryRejected"
        >
          重试被拒操作
        </button>
      </main>
    </div>
  </div>
</template>

<style scoped>
.cb-settings-view {
  min-height: 100vh;
  padding-bottom: calc(var(--cb-tabbar-height) + 24px);
  background: var(--md-sys-color-surface);
}

.cb-page-container {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

/* ==========================================================================
   1. MD3 Top App Bar (64px Center-Aligned / Large Title)
   ========================================================================== */
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

.md3-top-app-bar-large-title {
  margin: 0;
  padding: 0 8px;
  font-family: var(--cb-font-numeric);
  font-size: 36px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  letter-spacing: -0.3px;
}

.md3-top-app-bar-title {
  margin: 0;
  font-size: 18px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  letter-spacing: -0.2px;
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

/* ==========================================================================
   2. MD3 Lists & Groups
   ========================================================================== */
.cb-settings-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.cb-subpage-body {
  padding: 16px;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.md3-list-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.md3-list-group-header {
  font-size: 13px;
  font-weight: 800;
  color: var(--md-sys-color-outline);
  padding-left: 4px;
  letter-spacing: 0.3px;
}

.md3-list-container {
  overflow: hidden;
}

.md3-list-item {
  width: 100%;
  min-height: 64px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-list-item:hover {
  background: var(--md-sys-color-surface-container-low);
}

/* MD3 设置列表 leading：普通 24dp 图标，不用色块容器 */
.md3-list-item-leading {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-right: 16px;
  color: var(--md-sys-color-on-surface-variant);
}

.md3-list-item-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.md3-list-item-headline {
  font-size: 15px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
}

.md3-list-item-supporting {
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
}

.md3-list-item-trailing {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  color: var(--md-sys-color-outline);
}

.md3-list-item-meta {
  font-size: 13px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface-variant);
}

.md3-list-divider {
  height: 1px;
  background: var(--md-sys-color-outline-variant);
  margin-left: 56px;
}

/* MD3 Segmented Button：外观三态选择 */
.md3-theme-option-card {
  padding: 4px 16px;
}

.md3-theme-option-desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--md-sys-color-on-surface-variant);
}

.md3-segmented-set {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  padding: 4px;
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-full);
  box-sizing: border-box;
}

.md3-segment {
  height: 40px;
  padding: 0 8px;
  background: transparent;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  color: var(--md-sys-color-on-surface-variant);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.md3-segment--selected {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  box-shadow: var(--md-sys-elevation-1);
}

.md3-badge-success {
  background: var(--cb-status-success-bg);
  color: var(--cb-status-success-text);
  font-size: 12px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: var(--md-sys-shape-corner-full);
}

.md3-mono-text {
  font-size: 13px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
}

/* ==========================================================================
   3. MD3 Cards (Outlined & Elevated)
   ========================================================================== */
.md3-card {
  border-radius: var(--md-sys-shape-corner-large);
  padding: 16px;
  box-sizing: border-box;
}

.md3-card--elevated {
  background: var(--md-sys-color-surface);
  box-shadow: var(--md-sys-elevation-1);
}

.md3-card--outlined {
  background: var(--md-sys-color-surface);
  border: 1px solid var(--md-sys-color-outline-variant);
}

.md3-card-title {
  font-size: 13px;
  font-weight: 800;
  color: var(--md-sys-color-outline);
  letter-spacing: 0.3px;
  margin-bottom: 12px;
}

.md3-divider {
  height: 1px;
  background: var(--md-sys-color-outline-variant);
  margin: 14px 0;
}

.md3-field-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ==========================================================================
   4. MD3 Outlined Text Field
   ========================================================================== */
.md3-text-field-container {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.md3-text-field-label {
  font-size: 13px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface-variant);
}

.cb-required-star {
  color: var(--md-sys-color-error);
}

.md3-outlined-text-field {
  height: 52px;
  border: 1.5px solid var(--md-sys-color-outline);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface);
  display: flex;
  align-items: center;
  padding: 0 14px;
  box-sizing: border-box;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-outlined-text-field:focus-within {
  border-color: var(--md-sys-color-primary);
  box-shadow: 0 0 0 1px var(--md-sys-color-primary);
}

.md3-text-field-input {
  width: 100%;
  height: 100%;
  border: none;
  background: transparent;
  outline: none;
  font-size: 15px;
  color: var(--md-sys-color-on-surface);
}

.md3-supporting-text {
  font-size: 12px;
  color: var(--md-sys-color-outline);
  line-height: 1.4;
}

.cb-form-sections {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 70px;
}

.cb-form-2col-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

/* ==========================================================================
   5. MD3 Search Bar
   ========================================================================== */
.md3-search-bar {
  position: relative;
  width: 100%;
  height: 52px;
  background: var(--md-sys-color-surface);
  border: 1.5px solid var(--md-sys-color-outline);
  border-radius: var(--md-sys-shape-corner-full);
  display: flex;
  align-items: center;
  padding: 0 16px;
  box-sizing: border-box;
  box-shadow: var(--md-sys-elevation-1);
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-search-bar:focus-within {
  border-color: var(--md-sys-color-primary);
  box-shadow: 0 0 0 1px var(--md-sys-color-primary);
}

.md3-search-icon {
  color: var(--md-sys-color-outline);
  margin-right: 10px;
  flex-shrink: 0;
}

.md3-search-input {
  width: 100%;
  height: 100%;
  border: none;
  background: transparent;
  outline: none;
  font-size: 15px;
  color: var(--md-sys-color-on-surface);
}

.md3-search-clear-btn {
  background: none;
  border: none;
  color: var(--md-sys-color-outline);
  font-size: 14px;
  cursor: pointer;
  padding: 4px;
}

/* 客户列表卡片流 */
.cb-customer-card-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 70px;
}

.cb-cust-item-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.cb-cust-item-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.md3-badge-tonal {
  background: var(--md-sys-color-on-surface);
  color: var(--md-sys-color-surface);
  font-family: var(--cb-font-numeric);
  font-size: 12px;
  font-weight: 800;
  padding: 3px 8px;
  border-radius: var(--md-sys-shape-corner-extra-small);
  flex-shrink: 0;
}

.md3-badge-tonal-small {
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface-variant);
  font-size: 12px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: var(--md-sys-shape-corner-full);
}

.cb-cust-names-col {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.cb-cust-disp-name {
  font-size: 16px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
}

.cb-cust-full-name {
  font-size: 12px;
  color: var(--md-sys-color-outline);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cb-cust-valid-date {
  font-size: 11px;
  color: var(--md-sys-color-outline);
  flex-shrink: 0;
}

/* ==========================================================================
   6. MD3 Chips (Input Chips & Filter Chips)
   ========================================================================== */
.md3-chip-set {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.md3-input-chip {
  height: 32px;
  padding: 0 8px 0 12px;
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.md3-input-chip-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
}

.md3-input-chip-unit {
  font-size: 11px;
  color: var(--md-sys-color-outline);
}

.md3-input-chip-del {
  background: none;
  border: none;
  color: var(--md-sys-color-outline);
  font-size: 11px;
  font-weight: 800;
  padding: 2px 4px;
  cursor: pointer;
}
.md3-input-chip-del:hover {
  color: var(--md-sys-color-error);
}

.md3-filter-chip {
  height: 32px;
  padding: 0 12px;
  border-radius: var(--md-sys-shape-corner-small);
  border: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface-variant);
  font-size: 13px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-filter-chip--selected {
  background: var(--md-sys-color-primary);
  border-color: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  font-weight: 800;
}

/* ==========================================================================
   7. 服务品类管理特殊卡片与内联表单
   ========================================================================== */
.cb-category-card-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 70px;
}

.cb-cat-section-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cb-cat-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.cb-cat-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cb-cat-main-title {
  font-size: 17px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

.md3-text-button-error {
  background: none;
  border: none;
  font-size: 12px;
  font-weight: 700;
  color: var(--md-sys-color-error);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--md-sys-shape-corner-small);
}
.md3-text-button-error:hover {
  background: var(--md-sys-color-error-container);
}

.md3-inline-add-container {
  padding: 14px;
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.md3-inline-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.md3-outlined-button-small {
  height: 36px;
  padding: 0 14px;
  background: transparent;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 13px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
}

.md3-filled-button-small {
  height: 36px;
  padding: 0 16px;
  background: var(--md-sys-color-primary);
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 13px;
  font-weight: 800;
  color: var(--md-sys-color-on-primary);
  cursor: pointer;
}

.md3-dashed-action-btn {
  width: 100%;
  height: 44px;
  background: transparent;
  border: 1.5px dashed var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: 13px;
  font-weight: 700;
  color: var(--md-sys-color-primary);
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-dashed-action-btn:hover {
  background: var(--md-sys-color-surface-container-low);
  border-color: var(--md-sys-color-primary);
}

/* ==========================================================================
   8. 同步 Hero 状态
   ========================================================================== */
.cb-sync-status-hero {
  padding: 28px 20px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.cb-sync-hero-icon {
  font-size: 40px;
  margin-bottom: 8px;
}

.cb-sync-hero-title {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

.cb-sync-hero-desc {
  margin: 0;
  font-size: 13px;
  color: var(--md-sys-color-on-surface-variant);
}

/* ==========================================================================
   9. 底部固定 MD3 Filled Button
   ========================================================================== */
.md3-bottom-app-bar-cta {
  position: fixed;
  bottom: calc(var(--cb-tabbar-height) + 10px);
  left: 16px;
  right: 16px;
  z-index: 90;
}

.md3-filled-button {
  width: 100%;
  height: 52px;
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 15px;
  font-weight: 800;
  box-shadow: var(--md-sys-elevation-2);
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
  display: flex;
  align-items: center;
  justify-content: center;
}
.md3-filled-button:hover {
  box-shadow: var(--md-sys-elevation-3);
}

.cb-empty-state {
  padding: 40px 20px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.cb-empty-icon {
  font-size: 32px;
}

.cb-empty-text {
  font-size: 14px;
  color: var(--md-sys-color-outline);
}
</style>
