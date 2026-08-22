<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, inject, type ShallowRef } from 'vue'
import { showConfirmDialog, showFailToast, showSuccessToast } from 'vant'
import { dragAndDrop, animations, tearDown } from '@formkit/drag-and-drop'
import { appState } from '../../state/appState'
import { toErrorMessage } from '../../services/errorMessages'
import { getActiveAccount } from '../../services/apiClient'
import { getOrCreateDeviceId } from '../../db/device'
import { applyTheme, getThemePreference, type ThemePreference } from '../../utils/theme'
import { mergeCategoryOrders } from '../../utils/categoryReorder'
import { buildTime } from '../../services/buildInfo'
import type { ServiceCategoryUi, CustomerEntityUi, CustomerMappingUi } from '../../types/ui'
import type { AuthStore } from '../../services/authStore'
import ConflictCenter from './ConflictCenter.vue'

const props = defineProps<{ store?: Pick<AuthStore, 'logout'> }>()
const injectedStoreRef = inject<ShallowRef<AuthStore | null> | AuthStore | null>('authStore', null)

type SubPageKey =
  | 'main'
  | 'appearance'
  | 'customers'          // 客户档案总览（主界面，仅展示客户及名下有效代号）
  | 'customer_new'       // 新建/修改客户档案主体
  | 'mappings'           // 编号与代称管理（TopBar 右上角进入的独立子界面）
  | 'mapping_new'        // 新增/修改编号与代称映射
  | 'categories'
  | 'category_new'
  | 'sync'
  | 'conflicts'

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

// 最近构建时间：本地时区 "YYYY-MM-DD HH:mm"
const buildTimeLabel = computed(() => {
  const d = new Date(buildTime())
  if (Number.isNaN(d.getTime())) return buildTime()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
})

function setTheme(preference: ThemePreference) {
  themePreference.value = preference
  applyTheme(preference)
}

// ==================== 1. 客户档案（主）与编号代称管理（子） ====================
const customerEntitySearchKeyword = ref('')
const mappingSearchKeyword = ref('')

const _today = new Date()
const _todayStr = `${_today.getFullYear()}-${String(_today.getMonth() + 1).padStart(2, '0')}-${String(_today.getDate()).padStart(2, '0')}`

// 1.1 客户档案主列表与搜索（主界面仅展示客户档案主体及其名下代号）
const filteredCustomerEntityList = computed(() => {
  const kw = customerEntitySearchKeyword.value.trim().toLowerCase()
  if (!kw) return appState.customerEntities
  return appState.customerEntities.filter(
    (c) =>
      c.canonicalName.toLowerCase().includes(kw) ||
      c.activeCodes.some((code) => code.toLowerCase().includes(kw)) ||
      c.mappings.some((m) => m.customerName.toLowerCase().includes(kw)),
  )
})

// 1.2 编号与代称列表与搜索（TopBar 右上角进入的编号管理子界面）
const filteredMappingList = computed(() => {
  const kw = mappingSearchKeyword.value.trim().toLowerCase()
  if (!kw) return appState.customerMappings
  return appState.customerMappings.filter(
    (m) =>
      m.customerCode.toLowerCase().includes(kw) ||
      m.customerName.toLowerCase().includes(kw) ||
      m.canonicalName.toLowerCase().includes(kw),
  )
})

// 1.3 编号与代称分配/修改
const isEditingMapping = ref(false)
const editingMappingSyncId = ref<string | null>(null)
const formMappingCustomerId = ref<number | null>(null)
const formMappingCode = ref('')
const formMappingDisplayName = ref('')
const formMappingValidFrom = ref(_todayStr)
const formMappingValidTo = ref<string | null>(null)
const isMappingSubmitting = ref(false)

function openNewMappingPage(prefillCustomerId?: number) {
  isEditingMapping.value = false
  editingMappingSyncId.value = null
  formMappingCustomerId.value = prefillCustomerId ?? (appState.customerEntities[0]?.customerId ?? null)
  const cust = appState.customerEntities.find((c) => c.customerId === formMappingCustomerId.value)
  formMappingCode.value = ''
  formMappingDisplayName.value = cust?.canonicalName ?? ''
  formMappingValidFrom.value = _todayStr
  formMappingValidTo.value = null
  currentSubPage.value = 'mapping_new'
}

function openEditMappingPage(m: CustomerMappingUi) {
  isEditingMapping.value = true
  editingMappingSyncId.value = m.syncId
  formMappingCustomerId.value = m.customerId
  formMappingCode.value = m.customerCode
  formMappingDisplayName.value = m.customerName
  formMappingValidFrom.value = m.validFrom
  formMappingValidTo.value = m.validTo
  currentSubPage.value = 'mapping_new'
}

async function handleDeleteMappingFromEdit() {
  if (!editingMappingSyncId.value) return
  const m = appState.customerMappings.find((x) => x.syncId === editingMappingSyncId.value)
  if (!m) return
  try {
    await showConfirmDialog({
      title: '删除编号映射',
      message: `确定要结束并删除代号「${m.customerCode}」（${m.customerName}）吗？\n该操作将该编号有效截止期置为今日。`,
      confirmButtonText: '删除',
      confirmButtonColor: 'var(--md-sys-color-error, #ba1a1a)',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }

  try {
    await appState.deleteMapping(m.syncId)
    showSuccessToast(`已移除编号 ${m.customerCode}`)
    currentSubPage.value = 'mappings'
  } catch (e) {
    showFailToast(toErrorMessage(e))
  }
}

async function submitNewMapping() {
  if (isMappingSubmitting.value) return
  if (!formMappingCustomerId.value) {
    showFailToast('请选择关联的客户主体')
    return
  }
  if (!formMappingCode.value.trim() || !formMappingDisplayName.value.trim()) {
    showFailToast('请完整填写编号与显示简称/代称')
    return
  }
  isMappingSubmitting.value = true
  try {
    if (isEditingMapping.value && editingMappingSyncId.value) {
      await appState.updateMapping(editingMappingSyncId.value, {
        customerId: formMappingCustomerId.value,
        customerCode: formMappingCode.value.trim(),
        customerName: formMappingDisplayName.value.trim(),
        validFrom: formMappingValidFrom.value || _todayStr,
        validTo: formMappingValidTo.value || null,
      })
      showSuccessToast('编号代称修改成功')
    } else {
      await appState.addMapping({
        customerId: formMappingCustomerId.value,
        customerCode: formMappingCode.value.trim(),
        customerName: formMappingDisplayName.value.trim(),
        validFrom: formMappingValidFrom.value || _todayStr,
        validTo: null,
      })
      showSuccessToast('编号代称新增成功')
    }
    currentSubPage.value = 'mappings'
  } catch (e) {
    showFailToast(toErrorMessage(e))
  } finally {
    isMappingSubmitting.value = false
  }
}

// 1.4 客户档案新建/修改名称/归档
const isEditingCustomer = ref(false)
const editingCustomerSyncId = ref<string | null>(null)
const editingCustomerEntity = ref<CustomerEntityUi | null>(null)
const formCanonicalName = ref('')
const formInitialCode = ref('')
const formInitialDisplayName = ref('')
const isCustomerSubmitting = ref(false)

function openNewCustomerPage() {
  isEditingCustomer.value = false
  editingCustomerSyncId.value = null
  editingCustomerEntity.value = null
  formCanonicalName.value = ''
  formInitialCode.value = ''
  formInitialDisplayName.value = ''
  currentSubPage.value = 'customer_new'
}

function openEditCustomerPage(c: CustomerEntityUi) {
  isEditingCustomer.value = true
  editingCustomerSyncId.value = c.syncId
  editingCustomerEntity.value = c
  formCanonicalName.value = c.canonicalName
  formInitialCode.value = ''
  formInitialDisplayName.value = ''
  currentSubPage.value = 'customer_new'
}

async function handleArchiveCustomer(c: CustomerEntityUi) {
  try {
    await showConfirmDialog({
      title: '归档客户档案',
      message: `确定要归档客户「${c.canonicalName}」吗？\n归档后该客户及其名下所有编号将不再出现在日常录单中。`,
      confirmButtonText: '归档',
      confirmButtonColor: 'var(--md-sys-color-error, #ba1a1a)',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }

  try {
    await appState.archiveCustomer(c.syncId)
    showSuccessToast(`已归档客户「${c.canonicalName}」`)
    currentSubPage.value = 'customers'
  } catch (e) {
    showFailToast(toErrorMessage(e))
  }
}

async function handleArchiveCustomerFromEdit() {
  if (!editingCustomerEntity.value) return
  await handleArchiveCustomer(editingCustomerEntity.value)
}

async function submitNewCustomer() {
  if (isCustomerSubmitting.value) return
  const canonical = formCanonicalName.value.trim()
  if (!canonical) {
    showFailToast('请填写客户正式全称')
    return
  }

  isCustomerSubmitting.value = true
  try {
    if (isEditingCustomer.value && editingCustomerSyncId.value) {
      await appState.updateCustomerName(editingCustomerSyncId.value, canonical)
      showSuccessToast('客户档案修改成功')
      currentSubPage.value = 'customers'
    } else {
      const code = formInitialCode.value.trim()
      const disp = formInitialDisplayName.value.trim() || canonical

      if (code) {
        await appState.addCustomerWithMapping({
          canonicalName: canonical,
          customerCode: code,
          customerName: disp,
          validFrom: _todayStr,
          validTo: null,
        })
        showSuccessToast('客户档案与初始编号建立成功')
      } else {
        await appState.addCustomer(canonical)
        showSuccessToast('客户档案建立成功')
      }
      currentSubPage.value = 'customers'
    }
  } catch (e) {
    showFailToast(toErrorMessage(e))
  } finally {
    isCustomerSubmitting.value = false
  }
}

// ==================== 2. 服务品类与项目管理（严格区分大类和小类） ====================
const QUICK_UNITS = ['件', '打', '条', '套', '包', '公斤', '米', '双']

const formNewCatName = ref('')
const isCategorySubmitting = ref(false)

const activeCategoriesList = computed(() => appState.categories.filter((c) => c.isActive))
const inactiveCategoriesList = computed(() => appState.categories.filter((c) => !c.isActive))

// 默认折叠：记录当前展开的大类 syncId 集合
const expandedCatSyncIds = ref<Set<string>>(new Set())

function isCategoryExpanded(syncId?: string): boolean {
  if (!syncId) return false
  return expandedCatSyncIds.value.has(syncId)
}

function toggleCategoryExpanded(syncId?: string) {
  if (!syncId) return
  const s = new Set(expandedCatSyncIds.value)
  if (s.has(syncId)) {
    s.delete(syncId)
  } else {
    s.add(syncId)
  }
  expandedCatSyncIds.value = s
}

function openNewCategoryPage() {
  formNewCatName.value = ''
  currentSubPage.value = 'category_new'
}

async function submitNewCategory() {
  if (isCategorySubmitting.value) return
  const catName = formNewCatName.value.trim()
  if (!catName) {
    showFailToast('请填写大类名称')
    return
  }
  isCategorySubmitting.value = true

  try {
    // 1. 若存在同名且已启用的大类，拒绝重复创建
    const existingActive = appState.categories.find(
      (c) => c.name === catName && c.isActive,
    )
    if (existingActive) {
      showFailToast(`服务大类「${catName}」已存在`)
      return
    }

    // 2. 若存在同名但已停用的大类，就地恢复启用
    const existingInactive = appState.categories.find(
      (c) => c.name === catName && !c.isActive,
    )
    if (existingInactive) {
      await appState.updateCategory(existingInactive.syncId!, { isActive: true })
      formNewCatName.value = ''
      currentSubPage.value = 'categories'
      showSuccessToast(`大类「${catName}」此前已停用，已为您恢复启用`)
      return
    }

    // 3. 正常新建
    await appState.addCategory(catName)
    formNewCatName.value = ''
    currentSubPage.value = 'categories'
    showSuccessToast(`服务大类「${catName}」创建成功`)
  } catch (e) {
    showFailToast(toErrorMessage(e))
  } finally {
    isCategorySubmitting.value = false
  }
}

async function toggleCategoryActive(cat: ServiceCategoryUi) {
  try {
    await appState.updateCategory(cat.syncId!, { isActive: !cat.isActive })
    showSuccessToast(cat.isActive ? '已停用该大类' : '已恢复启用该大类')
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

// 排序模式：进入时拷贝至独立的响应式 ref 列表，拖拽只改本地 ref，点击“完成”统一保存
const sortMode = ref(false)
const sortableActiveCategories = ref<ServiceCategoryUi[]>([])
const sortableInactiveCategories = ref<ServiceCategoryUi[]>([])
const sortInitialSubNames = new Map<string, string[]>()

// FormKit DnD 容器引用和清理函数
const activeCatsContainer = ref<HTMLElement | null>(null)
const inactiveCatsContainer = ref<HTMLElement | null>(null)
const dndCleanups: Array<() => void> = []

function destroyAllDnd() {
  for (const cleanup of dndCleanups) {
    try { cleanup() } catch { /* ignore */ }
  }
  dndCleanups.length = 0
}

function vibrate(ms: number) {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try { navigator.vibrate(ms) } catch { /* ignore */ }
  }
}

function initDndForContainer(
  container: HTMLElement,
  values: ServiceCategoryUi[],
  onUpdate: (newValues: ServiceCategoryUi[]) => void,
  handleSelector: string,
) {
  const state = { values: [...values] }
  dragAndDrop({
    parent: container,
    getValues: () => state.values,
    setValues: (newValues: ServiceCategoryUi[]) => {
      state.values = newValues
      onUpdate(newValues)
    },
    config: {
      dragHandle: handleSelector,
      onDragstart: () => { vibrate(20) },
      // 注意：不能用 handleEnd（会覆盖库内部收尾逻辑，导致拖拽克隆不清理、排序失效）
      onDragend: () => { vibrate(12) },
      plugins: [animations()],
    },
  })
  dndCleanups.push(() => tearDown(container))
}

function initSubcatDnd() {
  const containers = document.querySelectorAll<HTMLElement>('[data-subcat-dnd]')
  for (const el of containers) {
    const syncId = el.getAttribute('data-subcat-dnd')
    if (!syncId) continue
    const cat = sortableActiveCategories.value.find((c) => c.syncId === syncId)
    if (!cat || cat.subcategories.length < 2) continue
    const state = { values: [...cat.subcategories] }
    dragAndDrop({
      parent: el,
      getValues: () => state.values,
      setValues: (newValues: typeof cat.subcategories) => {
        state.values = newValues
        cat.subcategories = newValues
      },
      config: {
        dragHandle: '.cb-sub-drag-handle, .cb-input-chip--sortable',
        onDragstart: () => { vibrate(15) },
        onDragend: () => { vibrate(10) },
        plugins: [animations()],
      },
    })
    dndCleanups.push(() => tearDown(el))
  }
}

async function enterSortMode() {
  activeAddingCatId.value = null
  sortableActiveCategories.value = activeCategoriesList.value.map((c) => ({
    ...c,
    subcategories: c.subcategories.map((s) => ({ ...s })),
  }))
  sortableInactiveCategories.value = inactiveCategoriesList.value.map((c) => ({
    ...c,
    subcategories: c.subcategories.map((s) => ({ ...s })),
  }))
  sortInitialSubNames.clear()
  for (const cat of appState.categories) {
    sortInitialSubNames.set(cat.syncId!, cat.subcategories.map((s) => s.name))
  }
  sortMode.value = true

  await nextTick()
  if (activeCatsContainer.value) {
    initDndForContainer(
      activeCatsContainer.value,
      sortableActiveCategories.value,
      (v) => { sortableActiveCategories.value = v },
      '.cb-drag-handle',
    )
  }
  if (inactiveCatsContainer.value && sortableInactiveCategories.value.length > 0) {
    initDndForContainer(
      inactiveCatsContainer.value,
      sortableInactiveCategories.value,
      (v) => { sortableInactiveCategories.value = v },
      '.cb-drag-handle',
    )
  }
  initSubcatDnd()
}

async function finishSortMode() {
  if (!sortMode.value) return
  destroyAllDnd()
  const allIds = appState.categories.map((c) => c.syncId!)
  const activeIds = sortableActiveCategories.value.map((c) => c.syncId!)
  const inactiveIds = sortableInactiveCategories.value.map((c) => c.syncId!)
  const newAllIds = mergeCategoryOrders(allIds, activeIds, inactiveIds)

  const allDrafts = [...sortableActiveCategories.value, ...sortableInactiveCategories.value]
  const subChanges: Array<{
    syncId: string
    subcategories: Array<{ name: string; defaultUnit: string; isActive: boolean }>
  }> = []

  for (const draft of allDrafts) {
    const initial = sortInitialSubNames.get(draft.syncId!)
    const current = draft.subcategories.map((s) => s.name)
    if (initial && initial.join('\u0000') !== current.join('\u0000')) {
      subChanges.push({
        syncId: draft.syncId!,
        subcategories: draft.subcategories.map((s) => ({
          name: s.name,
          defaultUnit: s.defaultUnit,
          isActive: s.isActive,
        })),
      })
    }
  }

  sortMode.value = false
  try {
    const orderChanged = newAllIds.join('\u0000') !== allIds.join('\u0000')
    if (orderChanged) {
      await appState.reorderCategories(newAllIds)
    }
    for (const change of subChanges) {
      await appState.updateCategory(change.syncId, { subcategories: change.subcategories })
    }
    if (orderChanged || subChanges.length > 0) {
      showSuccessToast('排序已保存')
    }
  } catch (e) {
    showFailToast(toErrorMessage(e))
    await appState.reload()
  } finally {
    sortableActiveCategories.value = []
    sortableInactiveCategories.value = []
  }
}

onBeforeUnmount(() => {
  destroyAllDnd()
})

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

// ==================== 4. 冲突解决中心 ====================
const conflictCount = computed(() => appState.conflictEntries.value.length)

async function openConflictCenter() {
  try {
    await appState.reload()
  } catch (e) {
    showFailToast(toErrorMessage(e))
    return
  }
  if (conflictCount.value === 0) {
    showFailToast('暂无冲突')
    return
  }
  currentSubPage.value = 'conflicts'
}

// ==================== 5. 退出登录 ====================
const logoutLoading = ref(false)

async function handleLogout() {
  try {
    await showConfirmDialog({
      title: '退出登录',
      message: '确定要退出当前账号吗？\n本地已保存的数据将完整保留。',
      confirmButtonText: '退出登录',
      cancelButtonText: '取消',
      confirmButtonColor: 'var(--md-sys-color-error, #ba1a1a)',
    })
  } catch {
    return
  }

  logoutLoading.value = true
  try {
    const store =
      props.store ??
      (injectedStoreRef && typeof injectedStoreRef === 'object' && 'value' in injectedStoreRef
        ? injectedStoreRef.value
        : injectedStoreRef)
    if (store?.logout) {
      await store.logout()
    }
    showSuccessToast('已退出登录')
  } catch (e) {
    showFailToast(toErrorMessage(e))
  } finally {
    logoutLoading.value = false
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
                <span class="md3-list-item-headline">客户档案</span>
                <span class="md3-list-item-supporting">企业客户主体、速记代号与代称</span>
              </div>
              <div class="md3-list-item-trailing">
                <span class="md3-list-item-meta cb-tabular-nums">{{ appState.customerEntities.length }} 家客户</span>
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

            <div class="md3-list-divider" aria-hidden="true"></div>

            <button
              type="button"
              class="md3-list-item cb-pressable"
              aria-label="进入冲突解决中心"
              @click="openConflictCenter"
            >
              <div class="md3-list-item-leading" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 3v12"></path>
                  <path d="M5.6 5.6l8.4 8.4"></path>
                  <path d="M18.4 5.6l-8.4 8.4"></path>
                  <circle cx="12" cy="18" r="1"></circle>
                </svg>
              </div>
              <div class="md3-list-item-content">
                <span class="md3-list-item-headline">冲突解决中心</span>
                <span class="md3-list-item-supporting">逐字段显式决策后重新提交同步</span>
              </div>
              <div class="md3-list-item-trailing">
                <span
                  class="cb-conflict-badge"
                  :class="{ 'cb-conflict-badge--zero': conflictCount === 0 }"
                >
                  {{ conflictCount }}
                </span>
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

        <!-- 组 4：关于（显示最近构建时间，用于确认 PWA 是否已更新） -->
        <section class="md3-list-group" aria-label="关于">
          <div class="md3-list-group-header">关于</div>
          <div class="md3-list-container">
            <div class="md3-list-item">
              <div class="md3-list-item-leading" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
              </div>
              <div class="md3-list-item-content">
                <span class="md3-list-item-headline">最近构建时间</span>
              </div>
              <div class="md3-list-item-trailing">
                <span class="md3-mono-text cb-tabular-nums">{{ buildTimeLabel }}</span>
              </div>
            </div>
          </div>
        </section>

        <!-- 组 5：外观（低频设置放在最后） -->
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

        <!-- 组 6：退出登录 -->
        <section class="cb-logout-section" aria-label="退出登录">
          <button
            type="button"
            class="md3-outlined-button-error cb-pressable"
            :disabled="logoutLoading"
            aria-label="退出当前账号"
            @click="handleLogout"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 8px;">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
            {{ logoutLoading ? '正在退出…' : '退出登录' }}
          </button>
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
         页面 2：客户档案总览（主界面：纯展示与维护客户主体，右上角进编号管理）
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
        <h1 class="md3-top-app-bar-title">客户档案</h1>
        <button
          type="button"
          class="md3-text-button-tonal cb-pressable"
          aria-label="进入编号与代称管理"
          @click="currentSubPage = 'mappings'"
        >
          编号代称 🏷️
        </button>
      </header>

      <main class="cb-subpage-body">
        <!-- MD3 Outlined Search Bar -->
        <div class="md3-search-bar">
          <svg class="md3-search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            v-model="customerEntitySearchKeyword"
            type="text"
            name="customer_search"
            placeholder="搜索客户正式全称或名下代号…"
            class="md3-search-input"
            autocomplete="off"
            spellcheck="false"
            aria-label="搜索客户档案"
          />
          <button
            v-if="customerEntitySearchKeyword"
            type="button"
            class="md3-search-clear-btn"
            aria-label="清空搜索"
            @click="customerEntitySearchKeyword = ''"
          >
            ✕
          </button>
        </div>

        <!-- 客户主体卡片列表（MD3 横向卡片：左侧大名称，右侧代号+代称/加号） -->
        <div class="cb-customer-card-list">
          <div
            v-for="c in filteredCustomerEntityList"
            :key="c.customerId"
            class="md3-card md3-card--outlined cb-entity-card-row cb-pressable"
            @click="openEditCustomerPage(c)"
          >
            <div class="cb-entity-card-left">
              <span class="cb-entity-card-title">{{ c.canonicalName }}</span>
            </div>

            <div class="cb-entity-card-right">
              <div v-if="c.mappings.filter(m => m.validTo === null).length > 0" class="cb-entity-chips-right">
                <span
                  v-for="m in c.mappings.filter(m => m.validTo === null)"
                  :key="m.syncId"
                  class="cb-code-alias-pill"
                >
                  <span class="cb-code-alias-code cb-tabular-nums">{{ m.customerCode }}</span>
                  <span class="cb-code-alias-name">{{ m.customerName }}</span>
                </span>
              </div>
              <button
                v-else
                type="button"
                class="cb-entity-add-btn cb-pressable"
                aria-label="分配编号与代称"
                @click.stop="openNewMappingPage(c.customerId)"
              >
                +
              </button>
            </div>
          </div>

          <div v-if="filteredCustomerEntityList.length === 0" class="cb-empty-state">
            <span class="cb-empty-icon">🔍</span>
            <span class="cb-empty-text">未找到匹配的客户档案</span>
          </div>
        </div>
      </main>

      <footer class="md3-bottom-app-bar-cta">
        <button
          type="button"
          class="md3-filled-button cb-pressable"
          aria-label="新建客户档案"
          @click="openNewCustomerPage"
        >
          + 新建客户档案主体
        </button>
      </footer>
    </div>

    <!-- ====================================================================
         页面 2.1：编号与代称管理（TopBar 右上角进入的子界面）
         ==================================================================== -->
    <div v-else-if="currentSubPage === 'mappings'" class="cb-page-container">
      <header class="md3-top-app-bar">
        <button
          type="button"
          class="md3-icon-button cb-pressable"
          aria-label="返回客户档案"
          @click="currentSubPage = 'customers'"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <h1 class="md3-top-app-bar-title">编号与代称管理</h1>
        <div style="width: 48px;"></div>
      </header>

      <main class="cb-subpage-body">
        <!-- MD3 Outlined Search Bar -->
        <div class="md3-search-bar">
          <svg class="md3-search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            v-model="mappingSearchKeyword"
            type="text"
            name="mapping_search"
            placeholder="搜索编号代号、显示简称或客户全称…"
            class="md3-search-input"
            autocomplete="off"
            spellcheck="false"
            aria-label="搜索编号映射"
          />
          <button
            v-if="mappingSearchKeyword"
            type="button"
            class="md3-search-clear-btn"
            aria-label="清空搜索"
            @click="mappingSearchKeyword = ''"
          >
            ✕
          </button>
        </div>

        <!-- 编号与代称卡片流（点击卡片直接修改/删除） -->
        <div class="cb-customer-card-list">
          <div
            v-for="m in filteredMappingList"
            :key="m.syncId"
            class="md3-card md3-card--outlined cb-mapping-item-card cb-pressable"
            @click="openEditMappingPage(m)"
          >
            <div class="cb-mapping-main-row">
              <div class="cb-cust-item-left">
                <span class="md3-badge-tonal cb-tabular-nums">{{ m.customerCode }}</span>
                <div class="cb-cust-names-col">
                  <span class="cb-cust-disp-name">{{ m.customerName }}</span>
                  <span class="cb-cust-full-name">{{ m.canonicalName }}</span>
                </div>
              </div>
              <div class="cb-cust-item-right">
                <span class="cb-cust-valid-date cb-tabular-nums">
                  {{ m.validTo ? `${m.validFrom} 至 ${m.validTo}` : `自 ${m.validFrom} 生效` }}
                </span>
              </div>
            </div>
          </div>

          <div v-if="filteredMappingList.length === 0" class="cb-empty-state">
            <span class="cb-empty-icon">🔍</span>
            <span class="cb-empty-text">暂无对应编号映射</span>
          </div>
        </div>
      </main>

      <footer class="md3-bottom-app-bar-cta">
        <button
          type="button"
          class="md3-filled-button cb-pressable"
          aria-label="新增编号与代称"
          @click="openNewMappingPage()"
        >
          + 新增编号与代称
        </button>
      </footer>
    </div>

    <!-- ====================================================================
         页面 2：新建/修改客户编号与代称映射独立页
         ==================================================================== -->
    <div v-else-if="currentSubPage === 'mapping_new'" class="cb-page-container">
      <header class="md3-top-app-bar">
        <button
          type="button"
          class="md3-icon-button cb-pressable"
          aria-label="返回编号列表"
          @click="currentSubPage = 'mappings'"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <h1 class="md3-top-app-bar-title">{{ isEditingMapping ? '修改编号与代称' : '分配编号与代称' }}</h1>
        <div style="width: 48px;"></div>
      </header>

      <main class="cb-subpage-body">
        <form id="new-mapping-form" class="cb-form-sections" @submit.prevent="submitNewMapping">
          <!-- 1. 所属客户主体 -->
          <div class="md3-text-field-container">
            <label class="md3-text-field-label">
              关联客户主体 <span class="cb-required-star">*</span>
            </label>
            <div class="md3-filled-select-field">
              <select
                v-model="formMappingCustomerId"
                class="md3-select-input"
                required
                aria-label="选择客户主体"
              >
                <option
                  v-for="c in appState.customerEntities"
                  :key="c.customerId"
                  :value="c.customerId"
                >
                  {{ c.canonicalName }}
                </option>
              </select>
            </div>
          </div>

          <!-- 2. 编号与代称网格 -->
          <div class="cb-form-2col-grid">
            <div class="md3-text-field-container">
              <label class="md3-text-field-label">
                速记编号 <span class="cb-required-star">*</span>
              </label>
              <div class="md3-filled-text-field">
                <input
                  v-model="formMappingCode"
                  type="text"
                  placeholder="例如 009"
                  class="md3-text-field-input cb-tabular-nums"
                  autocomplete="off"
                  spellcheck="false"
                  required
                  aria-label="速记代号"
                />
              </div>
            </div>

            <div class="md3-text-field-container">
              <label class="md3-text-field-label">
                显示简称 <span class="cb-required-star">*</span>
              </label>
              <div class="md3-filled-text-field">
                <input
                  v-model="formMappingDisplayName"
                  type="text"
                  placeholder="例如 宏兴"
                  class="md3-text-field-input"
                  autocomplete="off"
                  spellcheck="false"
                  required
                  aria-label="显示简称"
                />
              </div>
            </div>
          </div>

          <!-- 3. 生效起始日期 -->
          <div class="md3-text-field-container">
            <label class="md3-text-field-label">生效起始日期</label>
            <div class="md3-filled-text-field">
              <input
                v-model="formMappingValidFrom"
                type="date"
                class="md3-text-field-input cb-tabular-nums"
                aria-label="生效起始日期"
              />
            </div>
            <span class="md3-supporting-text">留空或填写当天即时生效；用于追溯历史工单的归属变迁。</span>
          </div>
        </form>
      </main>

      <footer class="md3-bottom-app-bar-cta">
        <div class="cb-form-cta-row">
          <button
            v-if="isEditingMapping && editingMappingSyncId"
            type="button"
            class="md3-outlined-danger-button cb-pressable"
            aria-label="删除此编号映射"
            @click="handleDeleteMappingFromEdit"
          >
            删除编号
          </button>
          <button
            form="new-mapping-form"
            type="submit"
            class="md3-filled-button cb-pressable"
            :disabled="isMappingSubmitting"
            aria-label="保存编号设置"
          >
            {{ isMappingSubmitting ? '保存中…' : '保存编号设置' }}
          </button>
        </div>
      </footer>
    </div>

    <!-- ====================================================================
         页面 3：新建/修改客户档案主体表单独立页
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
        <h1 class="md3-top-app-bar-title">{{ isEditingCustomer ? '修改客户主体' : '新建客户档案' }}</h1>
        <div style="width: 48px;"></div>
      </header>

      <main class="cb-subpage-body">
        <form id="new-customer-form" class="cb-form-sections" @submit.prevent="submitNewCustomer">
          <!-- 客户全称 -->
          <div class="md3-text-field-container">
            <label class="md3-text-field-label">
              客户正式全称 <span class="cb-required-star">*</span>
            </label>
            <div class="md3-filled-text-field">
              <input
                v-model="formCanonicalName"
                type="text"
                placeholder="例如 广州宏兴制衣厂"
                class="md3-text-field-input"
                autocomplete="off"
                spellcheck="false"
                required
                aria-label="客户正式全称"
              />
            </div>
            <span class="md3-supporting-text">代表企业长期稳定主体，用于对账结算与抬头归属</span>
          </div>

          <!-- 初始编号与代称（选填，仅在新建时可用） -->
          <template v-if="!isEditingCustomer">
            <div class="cb-form-2col-grid">
              <div class="md3-text-field-container">
                <label class="md3-text-field-label">初始速记编号 (选填)</label>
                <div class="md3-filled-text-field">
                  <input
                    v-model="formInitialCode"
                    type="text"
                    placeholder="例如 009"
                    class="md3-text-field-input cb-tabular-nums"
                    autocomplete="off"
                    spellcheck="false"
                    aria-label="速记编号"
                  />
                </div>
              </div>

              <div class="md3-text-field-container">
                <label class="md3-text-field-label">日常显示简称 (选填)</label>
                <div class="md3-filled-text-field">
                  <input
                    v-model="formInitialDisplayName"
                    type="text"
                    placeholder="例如 宏兴"
                    class="md3-text-field-input"
                    autocomplete="off"
                    spellcheck="false"
                    aria-label="显示简称"
                  />
                </div>
              </div>
            </div>
          </template>
        </form>
      </main>

      <footer class="md3-bottom-app-bar-cta">
        <div class="cb-form-cta-row">
          <button
            v-if="isEditingCustomer && editingCustomerEntity"
            type="button"
            class="md3-outlined-danger-button cb-pressable"
            aria-label="归档此客户档案"
            @click="handleArchiveCustomerFromEdit"
          >
            归档客户
          </button>
          <button
            form="new-customer-form"
            type="submit"
            class="md3-filled-button cb-pressable"
            :disabled="isCustomerSubmitting"
            aria-label="保存客户档案"
          >
            {{ isCustomerSubmitting ? '保存中…' : '保存客户档案' }}
          </button>
        </div>
      </footer>
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
          @click="async () => { if (sortMode) await finishSortMode(); currentSubPage = 'main' }"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </button>
        <h1 class="md3-top-app-bar-title">{{ sortMode ? '调整品类顺序' : '服务品类' }}</h1>
        <button
          v-if="!sortMode"
          type="button"
          class="cb-sort-btn cb-sort-btn--idle cb-pressable"
          aria-label="调整排序"
          @click="enterSortMode"
        >
          排序
        </button>
        <button
          v-else
          type="button"
          class="cb-sort-btn cb-sort-btn--done cb-pressable"
          aria-label="完成排序"
          @click="finishSortMode"
        >
          完成
        </button>
      </header>

      <main class="cb-subpage-body">
        <!-- 排序模式操作指引条（平滑展开淡入） -->
        <div class="cb-sort-banner-wrap" :class="{ 'cb-sort-banner-wrap--visible': sortMode }">
          <div class="cb-sort-mode-banner">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3 6h18v2H3zM3 11h18v2H3zM3 16h18v2H3z"/>
            </svg>
            <span>按住手柄可上下拖动大类或左右拖动具体项目</span>
          </div>
        </div>

        <div class="cb-category-card-list">
          <div ref="activeCatsContainer" class="cb-drag-list">
              <div
                v-for="cat in (sortMode ? sortableActiveCategories : activeCategoriesList)"
                :key="cat.syncId"
                class="md3-card md3-card--outlined cb-cat-section-card"
                :class="{ 'cb-cat-section-card--expanded': isCategoryExpanded(cat.syncId) || sortMode }"
              >
                <!-- 大类头部：点击折叠/展开，右侧提供排序手柄或展开指示器 -->
                <div
                  class="cb-cat-header-row cb-pressable"
                  @click="!sortMode && toggleCategoryExpanded(cat.syncId)"
                >
                  <div class="cb-cat-header-left">
                    <span class="cb-cat-main-title">{{ cat.name }}</span>
                    <span class="md3-badge-tonal-small cb-tabular-nums">{{ cat.subcategories.length }} 个项目</span>
                  </div>
                  <div class="cb-cat-header-right">
                    <span
                      v-if="sortMode"
                      class="cb-drag-handle"
                      aria-label="拖拽调整大类顺序"
                      title="按住拖拽排序"
                      @click.stop
                    >
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="4" y1="7" x2="20" y2="7"></line>
                        <line x1="4" y1="12" x2="20" y2="12"></line>
                        <line x1="4" y1="17" x2="20" y2="17"></line>
                      </svg>
                    </span>
                    <div v-else class="cb-cat-expand-indicator" :class="{ 'cb-cat-expand-indicator--open': isCategoryExpanded(cat.syncId) }">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M6 9l6 6 6-6"/>
                      </svg>
                    </div>
                  </div>
                </div>

                <!-- 折叠主体：小类项目列表 + 内联添加 + 停用大类选项（默认折叠，通过 CSS Grid 平滑展开） -->
                <div
                  class="cb-cat-dropdown-anim-wrap"
                  :class="{ 'cb-cat-dropdown-anim-wrap--open': isCategoryExpanded(cat.syncId) || sortMode }"
                >
                  <div class="cb-cat-dropdown-inner">
                    <!-- 小类项目列表（支持拖拽排序与常规删除） -->
                    <div
                      v-if="cat.subcategories.length > 0"
                      :data-subcat-dnd="sortMode ? cat.syncId : undefined"
                      class="md3-chip-set"
                    >
                      <div v-for="sub in cat.subcategories" :key="sub.name" class="md3-input-chip" :class="{ 'cb-input-chip--sortable': sortMode }">
                        <div class="cb-sub-drag-wrap" :class="{ 'cb-sub-drag-wrap--visible': sortMode }">
                          <span class="cb-sub-drag-handle" aria-label="拖拽调整项目顺序">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                              <line x1="4" y1="7" x2="20" y2="7"></line>
                              <line x1="4" y1="12" x2="20" y2="12"></line>
                              <line x1="4" y1="17" x2="20" y2="17"></line>
                            </svg>
                          </span>
                        </div>
                        <span class="md3-input-chip-label">{{ sub.name }}</span>
                        <span class="md3-input-chip-unit">/ {{ sub.defaultUnit }}</span>
                        <div class="cb-chip-del-wrap" :class="{ 'cb-chip-del-wrap--hidden': sortMode }">
                          <button
                            type="button"
                            class="md3-input-chip-del"
                            :aria-label="'删除项目 ' + sub.name"
                            :tabindex="sortMode ? -1 : 0"
                            @click.stop="deleteSubcategory(cat, sub.name)"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    </div>
                  <div v-else-if="sortMode" class="cb-subcat-empty-tip">暂无具体项目</div>

                  <!-- 内联添加小类项目表单与展开按键（在排序模式下平滑淡出收起） -->
                  <div class="cb-cat-bottom-action-wrap" :class="{ 'cb-cat-bottom-action-wrap--hidden': sortMode }">
                    <div v-if="activeAddingCatId === cat.syncId" class="md3-inline-add-container">
                      <div class="md3-card-title">为「{{ cat.name }}」添加服务项目</div>
                      <div class="cb-form-2col-grid">
                        <div class="md3-text-field-container">
                          <label class="md3-text-field-label">项目名称</label>
                          <div class="md3-outlined-text-field">
                            <input
                              v-model="inlineSubName"
                              type="text"
                              placeholder="例如 西服上衣"
                              class="md3-text-field-input"
                              autocomplete="off"
                              spellcheck="false"
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
                              placeholder="例如 件"
                              class="md3-text-field-input"
                              autocomplete="off"
                              spellcheck="false"
                              aria-label="默认单位"
                            />
                          </div>
                        </div>
                      </div>

                      <div class="md3-text-field-container" style="margin-top: 10px;">
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

                    <!-- 未添加时显示的展开按键与停用选项 -->
                    <div v-else class="cb-cat-actions-row">
                      <button
                        type="button"
                        class="md3-dashed-action-btn cb-pressable"
                        :tabindex="sortMode ? -1 : 0"
                        @click="startAddSubcategory(cat)"
                      >
                        + 添加服务项目与默认单位
                      </button>
                      <button
                        type="button"
                        class="md3-text-button-error-sm cb-pressable"
                        :aria-label="'停用大类 ' + cat.name"
                        @click="toggleCategoryActive(cat)"
                      >
                        停用大类
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 2. 已停用的大类 -->
          <template v-if="(sortMode ? sortableInactiveCategories : inactiveCategoriesList).length > 0">
            <div class="cb-section-divider-title">
              已停用大类 ({{ (sortMode ? sortableInactiveCategories : inactiveCategoriesList).length }})
            </div>
            <div ref="inactiveCatsContainer" class="cb-drag-list">
                <div
                  v-for="cat in (sortMode ? sortableInactiveCategories : inactiveCategoriesList)"
                  :key="cat.syncId"
                  class="md3-card md3-card--outlined cb-cat-section-card cb-cat-section-card--inactive"
                >
                  <div
                    class="cb-cat-header-row cb-pressable"
                    @click="!sortMode && toggleCategoryExpanded(cat.syncId)"
                  >
                    <div class="cb-cat-header-left">
                      <span class="cb-cat-main-title">{{ cat.name }}</span>
                      <span class="md3-badge-tonal-small cb-tabular-nums">已停用 · {{ cat.subcategories.length }} 个项目</span>
                    </div>
                    <div class="cb-cat-header-right">
                      <span
                        v-if="sortMode"
                        class="cb-drag-handle"
                        aria-label="拖拽调整已停用大类顺序"
                        title="按住拖拽排序"
                        @click.stop
                      >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                          <line x1="4" y1="7" x2="20" y2="7"></line>
                          <line x1="4" y1="12" x2="20" y2="12"></line>
                          <line x1="4" y1="17" x2="20" y2="17"></line>
                        </svg>
                      </span>
                      <div v-else class="cb-cat-expand-indicator" :class="{ 'cb-cat-expand-indicator--open': isCategoryExpanded(cat.syncId) }">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M6 9l6 6 6-6"/>
                        </svg>
                      </div>
                    </div>
                  </div>

                  <!-- 展开后平滑显示恢复启用与小类概览 -->
                  <div
                    class="cb-cat-dropdown-anim-wrap"
                    :class="{ 'cb-cat-dropdown-anim-wrap--open': isCategoryExpanded(cat.syncId) || sortMode }"
                  >
                    <div class="cb-cat-dropdown-inner">
                      <div v-if="cat.subcategories.length > 0" class="md3-chip-set">
                        <div
                          v-for="sub in cat.subcategories"
                          :key="sub.name"
                          class="md3-input-chip"
                          style="opacity: 0.75;"
                        >
                          <span class="md3-input-chip-label">{{ sub.name }}</span>
                          <span class="md3-input-chip-unit">/ {{ sub.defaultUnit }}</span>
                        </div>
                      </div>

                      <div style="display: flex; justify-content: flex-end; margin-top: 8px;">
                        <button
                          type="button"
                          class="md3-filled-button-small cb-pressable"
                          :aria-label="'恢复启用大类 ' + cat.name"
                          @click="toggleCategoryActive(cat)"
                        >
                          恢复启用该大类
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
          </template>

          <div v-if="appState.categories.length === 0" class="cb-empty-state">
            <span class="cb-empty-icon">🏷️</span>
            <span class="cb-empty-text">暂无服务品类，点击下方按钮添加大类</span>
          </div>
        </div>
      </main>

      <footer
        class="md3-bottom-app-bar-cta"
        :class="{ 'md3-bottom-app-bar-cta--hidden': sortMode }"
      >
        <button
          type="button"
          class="md3-filled-button cb-pressable"
          aria-label="新增服务大类"
          :tabindex="sortMode ? -1 : 0"
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
        <form id="new-category-form" class="cb-form-sections" @submit.prevent="submitNewCategory">
          <div class="md3-text-field-container">
            <label class="md3-text-field-label">
              大类名称 <span class="cb-required-star">*</span>
            </label>
            <div class="md3-filled-text-field">
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
            <span class="md3-supporting-text">大类作为服务品类的分组容器。创建完成后可在大类下添加具体项目与默认单位。</span>
          </div>
        </form>
      </main>

      <footer class="md3-bottom-app-bar-cta">
        <button
          form="new-category-form"
          type="submit"
          class="md3-filled-button cb-pressable"
          :disabled="isCategorySubmitting"
          aria-label="保存大类"
        >
          {{ isCategorySubmitting ? '保存中…' : '保存大类' }}
        </button>
      </footer>
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

        <div class="cb-sync-actions-group">
          <button
            type="button"
            class="md3-filled-button cb-pressable"
            aria-label="立即同步数据"
            :disabled="syncLoading"
            @click="runSyncNow"
          >
            {{ syncLoading ? '同步中…' : '立即同步数据' }}
          </button>

          <button
            v-if="syncCounts.rejected > 0"
            type="button"
            class="md3-tonal-action-btn cb-pressable"
            aria-label="重试被拒操作"
            :disabled="syncLoading"
            @click="runRetryRejected"
          >
            重试被拒操作
          </button>
        </div>
      </main>
    </div>

    <!-- ====================================================================
         页面 7：冲突解决中心独立页（推入式子页面）
         ==================================================================== -->
    <ConflictCenter
      v-else-if="currentSubPage === 'conflicts'"
      @back="currentSubPage = 'main'"
    />
  </div>
</template>

<style scoped>
.cb-settings-view {
  min-height: 100%;
  padding-bottom: calc(var(--cb-tabbar-height) + env(safe-area-inset-bottom, 0px) + 24px);
  background: var(--md-sys-color-surface);
}

.cb-page-container {
  display: flex;
  flex-direction: column;
  min-height: 100%;
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
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
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

.cb-conflict-badge {
  min-width: 22px;
  height: 22px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--cb-status-danger-bg);
  color: var(--cb-status-danger-text);
  font-family: var(--cb-font-numeric);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 800;
  border-radius: var(--md-sys-shape-corner-full);
  box-sizing: border-box;
}

.cb-conflict-badge--zero {
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-outline);
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
  padding: 18px 20px;
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
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface);
  display: flex;
  align-items: center;
  padding: 0 16px;
  box-sizing: border-box;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-outlined-text-field:focus-within {
  border-color: var(--md-sys-color-primary);
  box-shadow: 0 0 0 1px var(--md-sys-color-primary);
}

/* MD3 Filled Tonal Text Field（无生硬外框，采用淡雅表面容器色） */
.md3-filled-text-field {
  height: 52px;
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-high);
  display: flex;
  align-items: center;
  padding: 0 16px;
  box-sizing: border-box;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-filled-text-field:focus-within {
  background: var(--md-sys-color-surface);
  box-shadow: 0 0 0 2px var(--md-sys-color-primary);
}

.md3-filled-select-field {
  height: 52px;
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-high);
  display: flex;
  align-items: center;
  padding: 0 16px;
  box-sizing: border-box;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-filled-select-field:focus-within {
  background: var(--md-sys-color-surface);
  box-shadow: 0 0 0 2px var(--md-sys-color-primary);
}

.md3-text-field-input {
  width: 100%;
  height: 100%;
  border: none;
  background: transparent;
  outline: none;
  font-size: 16px;
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
  padding-bottom: calc(var(--cb-tabbar-height) + env(safe-area-inset-bottom, 0px) + 32px);
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
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
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
  padding-bottom: calc(var(--cb-tabbar-height) + env(safe-area-inset-bottom, 0px) + 84px);
}

.cb-cust-item-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.cb-mapping-item-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cb-mapping-main-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.cb-card-actions-row {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.md3-text-button-sm {
  background: transparent;
  color: var(--md-sys-color-primary);
  border: none;
  font-size: 14px;
  font-weight: 700;
  padding: 8px 14px;
  border-radius: var(--md-sys-shape-corner-full);
  cursor: pointer;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-text-button-sm:hover {
  background: var(--md-sys-color-surface-container-high);
}

.md3-text-button-error-sm {
  height: 44px;
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
  border: none;
  font-size: 14px;
  font-weight: 600;
  padding: 0 16px;
  border-radius: var(--md-sys-shape-corner-full);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    transform var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-text-button-error-sm:hover {
  filter: brightness(0.96);
}
.md3-text-button-error-sm:active {
  transform: scale(0.98);
}

.cb-cust-item-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.md3-badge-tonal {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  font-family: var(--cb-font-numeric);
  font-size: 13px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: var(--md-sys-shape-corner-full);
  flex-shrink: 0;
}

.md3-badge-tonal-small {
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface-variant);
  font-size: 12px;
  font-weight: 500;
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
  font-size: 17px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
}

.cb-cust-full-name {
  font-size: 13px;
  font-weight: 400;
  color: var(--md-sys-color-outline);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cb-cust-valid-date {
  font-size: 12px;
  color: var(--md-sys-color-outline);
  flex-shrink: 0;
}

/* 客户主界面卡片 */
.cb-customer-master-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  cursor: pointer;
  transition: transform var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-customer-master-card:active {
  transform: scale(0.99);
}

.cb-customer-master-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.cb-customer-master-name {
  font-size: 16px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

/* 客户详情子界面卡片与分组 */
.cb-detail-main-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--md-sys-color-surface-container-low);
}

.cb-detail-card-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.cb-detail-title-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.cb-detail-title-name {
  font-size: 20px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  line-height: 1.3;
  margin: 0;
}

.cb-detail-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.cb-mapping-group-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cb-section-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 4px;
}

.cb-mapping-item-card--history {
  opacity: 0.7;
  background: var(--md-sys-color-surface-container-lowest);
  border-style: dashed;
}

/* 客户档案实体横向卡片（MD3 规范：主信息在左，次级元数据/代称在右） */
.cb-entity-card-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  min-height: 68px;
  padding: 18px 20px;
  border-radius: var(--md-sys-shape-corner-large);
  cursor: pointer;
  transition: transform var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-entity-card-row:active {
  transform: scale(0.99);
}

.cb-entity-card-left {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1;
}

.cb-entity-card-title {
  font-size: 20px;
  font-weight: 400;
  color: var(--md-sys-color-on-surface);
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cb-entity-card-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.cb-entity-chips-right {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
}

/* 编号 + 代称组合胶囊 */
.cb-code-alias-pill {
  display: inline-flex;
  align-items: center;
  background: var(--md-sys-color-surface-container-high);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-full);
  overflow: hidden;
  font-size: 15px;
}

.cb-code-alias-code {
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  font-weight: 700;
  padding: 6px 12px;
  font-size: 14px;
}

.cb-code-alias-name {
  color: var(--md-sys-color-on-surface);
  font-weight: 600;
  padding: 6px 14px;
  font-size: 15px;
}

.cb-entity-add-btn {
  width: 36px;
  height: 36px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-high);
  border: 1px dashed var(--md-sys-color-outline);
  color: var(--md-sys-color-primary);
  font-size: 22px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  line-height: 1;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-entity-add-btn:hover {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  border-style: solid;
}

.md3-text-button-tonal {
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-primary);
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 14px;
  font-weight: 700;
  padding: 8px 16px;
  cursor: pointer;
}

.md3-tonal-button-sm {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 13px;
  font-weight: 700;
  padding: 6px 14px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-tonal-button-sm:hover {
  background: var(--md-sys-color-surface-container-highest);
}

.md3-outlined-select-field {
  position: relative;
  height: 52px;
  border: 1.5px solid var(--md-sys-color-outline);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface);
  display: flex;
  align-items: center;
  padding: 0 14px;
  box-sizing: border-box;
}

.md3-select-input {
  width: 100%;
  height: 100%;
  border: none;
  background: transparent;
  outline: none;
  font-size: 16px;
  color: var(--md-sys-color-on-surface);
  cursor: pointer;
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
  height: 38px;
  padding: 0 10px 0 14px;
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.md3-input-chip-label {
  font-size: 14px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
}

.md3-input-chip-unit {
  font-size: 12px;
  color: var(--md-sys-color-outline);
}

.md3-input-chip-del {
  background: transparent;
  border: none;
  color: var(--md-sys-color-outline);
  font-size: 13px;
  font-weight: 800;
  padding: 4px 6px;
  border-radius: var(--md-sys-shape-corner-full);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-input-chip-del:hover {
  color: var(--md-sys-color-error);
  background: var(--md-sys-color-error-container);
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
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
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
  gap: 14px;
  padding-bottom: calc(var(--cb-tabbar-height) + env(safe-area-inset-bottom, 0px) + 84px);
}

.cb-cat-section-card {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 18px 20px;
  min-height: 68px;
  border-radius: var(--md-sys-shape-corner-large);
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-cat-section-card--inactive {
  opacity: 0.78;
  background: var(--md-sys-color-surface-container-low);
  border-style: dashed;
}

.cb-section-divider-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--md-sys-color-outline);
  margin: 16px 4px 4px 4px;
}

.md3-text-button-primary {
  background: var(--md-sys-color-primary-container);
  border: none;
  font-size: 13px;
  font-weight: 700;
  color: var(--md-sys-color-on-primary-container);
  cursor: pointer;
  padding: 6px 14px;
  border-radius: var(--md-sys-shape-corner-full);
}
.md3-text-button-primary:hover {
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
}

.cb-cat-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  cursor: pointer;
}

.cb-cat-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.cb-cat-main-title {
  font-size: 19px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
}

.cb-cat-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cb-cat-expand-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--md-sys-color-outline);
  transition: transform 0.24s cubic-bezier(0.2, 0, 0, 1);
}

.cb-cat-expand-indicator--open {
  transform: rotate(180deg);
}

/* 基于 CSS Grid 的零 JS 损耗平滑折叠/展开动画 */
.cb-cat-dropdown-anim-wrap {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows 0.28s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.22s cubic-bezier(0.2, 0, 0, 1),
    margin 0.24s cubic-bezier(0.2, 0, 0, 1);
  margin-top: 0;
}

.cb-cat-dropdown-anim-wrap--open {
  grid-template-rows: 1fr;
  opacity: 1;
  margin-top: 14px;
}

.cb-cat-dropdown-inner {
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.cb-cat-actions-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 4px;
}

.md3-text-button-error {
  background: none;
  border: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--md-sys-color-error);
  cursor: pointer;
  padding: 6px 10px;
  border-radius: var(--md-sys-shape-corner-full);
}
.md3-text-button-error:hover {
  background: var(--md-sys-color-error-container);
}

.md3-inline-add-container {
  padding: 16px;
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.md3-inline-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 6px;
}

.md3-outlined-button-small {
  height: 38px;
  padding: 0 16px;
  background: transparent;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 14px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
}

.md3-filled-button-small {
  height: 38px;
  padding: 0 18px;
  background: var(--md-sys-color-primary);
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 14px;
  font-weight: 600;
  color: var(--md-sys-color-on-primary);
  cursor: pointer;
}

.md3-dashed-action-btn {
  flex: 1;
  height: 44px;
  background: var(--md-sys-color-surface-container-high);
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 14px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    transform var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-dashed-action-btn:hover {
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-on-surface);
}
.md3-dashed-action-btn:active {
  transform: scale(0.98);
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

.cb-sync-actions-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 24px;
  width: 100%;
}

.md3-tonal-action-btn {
  width: 100%;
  height: 52px;
  min-height: 52px;
  max-height: 52px;
  box-sizing: border-box;
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    transform var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-tonal-action-btn:hover {
  background: var(--md-sys-color-surface-container-highest);
}
.md3-tonal-action-btn:active {
  transform: scale(0.99);
}

/* ==========================================================================
   9. 底部固定 MD3 Filled Button
   ========================================================================== */
.md3-bottom-app-bar-cta {
  position: fixed;
  bottom: calc(var(--cb-tabbar-height) + env(safe-area-inset-bottom, 0px) + 12px);
  left: 16px;
  right: 16px;
  z-index: 90;
  opacity: 1;
  transform: translateY(0);
  transition: opacity 0.22s cubic-bezier(0.2, 0, 0, 1),
    transform 0.24s cubic-bezier(0.2, 0, 0, 1);
}

.md3-bottom-app-bar-cta--hidden {
  opacity: 0;
  transform: translateY(16px);
  pointer-events: none;
}

.cb-form-cta-row {
  display: flex;
  gap: 12px;
  width: 100%;
}

.md3-outlined-danger-button {
  height: 52px;
  min-height: 52px;
  max-height: 52px;
  box-sizing: border-box;
  padding: 0 20px;
  background: transparent;
  color: var(--md-sys-color-error);
  border: 1.5px solid var(--md-sys-color-error);
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-outlined-danger-button:hover {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}

.md3-filled-button {
  width: 100%;
  height: 52px;
  min-height: 52px;
  max-height: 52px;
  box-sizing: border-box;
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 15px;
  font-weight: 700;
  box-shadow: var(--md-sys-elevation-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    transform var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-filled-button:active {
  transform: scale(0.99);
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

/* ==========================================================================
   10. 排序模式：指引条 + 拖拽手柄 + 让位动画 + 平滑过渡
   ========================================================================== */
.cb-sort-banner-wrap {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transform: translateY(-8px);
  transition: max-height 0.26s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.22s cubic-bezier(0.2, 0, 0, 1),
    transform 0.24s cubic-bezier(0.2, 0, 0, 1),
    margin 0.24s cubic-bezier(0.2, 0, 0, 1);
  margin-bottom: 0;
}
.cb-sort-banner-wrap--visible {
  max-height: 80px;
  opacity: 1;
  transform: translateY(0);
  margin-bottom: 8px;
}

.cb-sort-mode-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--md-sys-color-surface-container-high);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: 13px;
  font-weight: 700;
  color: var(--md-sys-color-primary);
}

.cb-sort-btn {
  height: 32px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 700;
  border-radius: var(--md-sys-shape-corner-full);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-sizing: border-box;
  outline: none;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-sort-btn--idle {
  background: var(--md-sys-color-surface-container);
  border: 1px solid var(--md-sys-color-outline-variant);
  color: var(--md-sys-color-primary);
}
.cb-sort-btn--idle:hover {
  background: var(--md-sys-color-surface-container-high);
}

.cb-sort-btn--done {
  background: var(--md-sys-color-primary);
  border: 1px solid var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  font-weight: 800;
}

.cb-drag-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cb-cat-header-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-height: 36px;
  min-width: 36px;
}

/* 1. 小类 Chip 内部手柄容器平滑淡入 */
.cb-sub-drag-wrap {
  width: 0;
  max-width: 0;
  opacity: 0;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  transform: scale(0.6);
  transition: max-width 0.22s cubic-bezier(0.2, 0, 0, 1),
    width 0.22s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.18s cubic-bezier(0.2, 0, 0, 1),
    transform 0.22s cubic-bezier(0.2, 0, 0, 1);
  pointer-events: none;
}
.cb-sub-drag-wrap--visible {
  width: 20px;
  max-width: 20px;
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
}

/* 2. 小类 Chip 内部删除按钮平滑淡出 */
.cb-chip-del-wrap {
  opacity: 1;
  max-width: 30px;
  transform: scale(1);
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  transition: opacity 0.18s cubic-bezier(0.2, 0, 0, 1),
    max-width 0.22s cubic-bezier(0.2, 0, 0, 1),
    transform 0.18s cubic-bezier(0.2, 0, 0, 1);
}
.cb-chip-del-wrap--hidden {
  opacity: 0;
  max-width: 0;
  transform: scale(0.8);
  pointer-events: none;
}

/* 3. 卡片底部添加按钮平滑折叠淡出 */
.cb-cat-bottom-action-wrap {
  opacity: 1;
  max-height: 500px;
  overflow: hidden;
  transform: translateY(0);
  transition: opacity 0.2s cubic-bezier(0.2, 0, 0, 1),
    max-height 0.3s cubic-bezier(0.2, 0, 0, 1),
    transform 0.22s cubic-bezier(0.2, 0, 0, 1),
    margin 0.24s cubic-bezier(0.2, 0, 0, 1);
}
.cb-cat-bottom-action-wrap--hidden {
  opacity: 0;
  max-height: 0;
  transform: translateY(-8px);
  margin-top: 0 !important;
  margin-bottom: 0 !important;
  pointer-events: none;
}

.cb-drag-handle,
.cb-sub-drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--md-sys-color-on-surface-variant);
  cursor: grab;
  touch-action: none;
  -webkit-touch-callout: none;
  user-select: none;
  -webkit-user-select: none;
  flex-shrink: 0;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    transform var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

/* 大类拖拽手柄：满 44px 触控舒适热区 */
.cb-drag-handle {
  width: 44px;
  height: 44px;
  border-radius: var(--md-sys-shape-corner-small);
}

/* 小类拖拽手柄：满 28px 触控舒适热区 */
.cb-sub-drag-handle {
  width: 28px;
  height: 28px;
  margin-right: 2px;
  border-radius: var(--md-sys-shape-corner-extra-small);
}

.cb-drag-handle:active,
.cb-sub-drag-handle:active {
  cursor: grabbing;
  transform: scale(0.92);
}

.cb-drag-handle:hover,
.cb-sub-drag-handle:hover {
  background: var(--md-sys-color-surface-container-highest);
  color: var(--md-sys-color-primary);
}

.cb-input-chip--sortable {
  cursor: grab;
  padding: 0 10px 0 6px;
  border-style: dashed;
  touch-action: none;
  -webkit-touch-callout: none;
  user-select: none;
  -webkit-user-select: none;
}

.cb-subcat-empty-tip {
  font-size: 12px;
  color: var(--md-sys-color-outline);
  padding: 4px 2px;
}

/* FormKit DnD: 被拖拽元素抬起效果与跟手动效保障 */
.cb-drag-list [data-dragging],
.md3-chip-set [data-dragging] {
  transition: none !important;
  background: var(--md-sys-color-surface) !important;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16), 0 2px 6px rgba(0, 0, 0, 0.08) !important;
  transform: scale(1.02) !important;
  border-color: var(--md-sys-color-primary) !important;
  z-index: 9999 !important;
  cursor: grabbing !important;
  opacity: 1 !important;
  touch-action: none !important;
  -webkit-touch-callout: none !important;
  user-select: none !important;
  -webkit-user-select: none !important;
}

/* ==========================================================================
   11. 退出登录按钮
   ========================================================================== */
.cb-logout-section {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
}

.md3-outlined-button-error {
  width: 100%;
  height: 48px;
  background: transparent;
  border: 1.5px solid var(--md-sys-color-error, #ba1a1a);
  border-radius: var(--md-sys-shape-corner-full, 9999px);
  color: var(--md-sys-color-error, #ba1a1a);
  font-size: 15px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-sizing: border-box;
  transition: background-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
    opacity var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.md3-outlined-button-error:hover {
  background: var(--md-sys-color-error-container, #ffdad6);
}
.md3-outlined-button-error:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
