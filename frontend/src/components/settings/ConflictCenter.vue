<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { appState, type ConflictEntry } from '../../state/appState'
import type { ConflictResolution, FieldDiff } from '../../services/conflictResolver'
import { toErrorMessage } from '../../services/errorMessages'
import { formatConflictCell } from '../../utils/conflictFormat'

// 冲突解决中心（推入式子页面，由 SettingsView 以 currentSubPage 切换进入）。
// 每条冲突：摘要行 + 展开后的 Base/Ours/Theirs 完整三方对比表；
// 每个差异字段必须显式选择 本机(Ours)/服务端(Theirs)/手填，全部决策后才允许确认并重推。

const emit = defineEmits<{ back: [] }>()

const entries = computed(() => appState.conflictEntries.value)
const selectedQueueId = ref<number | null>(null)
const submitting = ref(false)

const selectedEntry = computed(
  () => entries.value.find((e) => e.queueId === selectedQueueId.value) ?? null,
)

type DecisionKind = 'ours' | 'theirs' | 'manual'
interface FieldDecisionState {
  kind: DecisionKind
  manualValue: string
}

/** 页面内暂存的决策（按 queueId → field 组织，仅内存态；“暂存”只收起详情，不写任何数据）。 */
const decisions = reactive<Record<string, Record<string, FieldDecisionState>>>({})

const diffMaps = new WeakMap<ConflictEntry, Map<string, FieldDiff>>()
const fieldLists = new WeakMap<ConflictEntry, string[]>()

const OPERATION_TYPE_LABELS: Record<string, string> = {
  create_work_order: '新建工单',
  update_work_order: '修改工单',
  batch_price_work_orders: '批量定价',
  revert_operation: '撤回',
}

const FIELD_LABELS: Record<string, string> = {
  quantity: '数量',
  unit: '单位',
  unit_price_cents: '单价（元）',
  unitPriceCents: '单价（元）',
  work_order_date: '工单日期',
  customer_id: '客户 ID',
  customer_code: '客户编号',
  customer_name: '客户名称',
  service_category: '服务大类',
  service_item: '服务小类',
  is_completed: '是否完成',
  row_version: '行版本',
  deleted_at: '删除时间',
  archived_at: '归档时间',
}

const DIFF_STATE_LABELS: Record<FieldDiff['state'], string> = {
  'ours-only': '仅本机',
  'theirs-only': '仅服务端',
  both: '双方都改',
}

// ---------- 条目派生信息 ----------

function diffMapFor(entry: ConflictEntry): Map<string, FieldDiff> {
  let map = diffMaps.get(entry)
  if (!map) {
    map = new Map(entry.diffs.map((d) => [d.field, d]))
    diffMaps.set(entry, map)
  }
  return map
}

function diffFor(entry: ConflictEntry, field: string): FieldDiff | undefined {
  return diffMapFor(entry).get(field)
}

function fieldsFor(entry: ConflictEntry): string[] {
  let fields = fieldLists.get(entry)
  if (!fields) {
    const set = new Set([
      ...Object.keys(entry.base),
      ...Object.keys(entry.ours),
      ...Object.keys(entry.theirs),
    ])
    const map = diffMapFor(entry)
    // 冲突字段排前面，其余字段按名字稳定排序
    fields = [...set].sort((a, b) => {
      const diffA = map.has(a) ? 0 : 1
      const diffB = map.has(b) ? 0 : 1
      return diffA - diffB || a.localeCompare(b)
    })
    fieldLists.set(entry, fields)
  }
  return fields
}

function decidedCount(entry: ConflictEntry): number {
  return entry.diffs.filter((d) => getDecision(entry.queueId, d.field)).length
}

function entitySyncIdOf(entry: ConflictEntry): string | null {
  const raw = entry.conflictJson as { entity_sync_id?: unknown } | null
  return typeof raw?.entity_sync_id === 'string' ? raw.entity_sync_id : null
}

function workOrderFor(entry: ConflictEntry) {
  const id = entitySyncIdOf(entry)
  if (!id) return null
  return appState.workOrders.find((o) => o.syncId === id) ?? null
}

function operationLabel(entry: ConflictEntry): string {
  return OPERATION_TYPE_LABELS[entry.operationType] ?? entry.operationType
}

function actorLabel(entry: ConflictEntry): string {
  if (entry.actorType === 'user') return '本人'
  if (entry.actorType === 'ai') return 'AI'
  return '系统'
}

function orderLabel(entry: ConflictEntry): string {
  const order = workOrderFor(entry)
  if (order) {
    const name = order.customerDisplayName || order.customerCode || '—'
    return `${name} · ${order.orderDate}`
  }
  return entitySyncIdOf(entry) ?? '未知记录'
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso || '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ---------- 多级导航：入口列表 ↔ 单条详情 ----------

function openEntry(entry: ConflictEntry) {
  selectedQueueId.value = entry.queueId
}

function backToEntryList() {
  selectedQueueId.value = null
}

function isRevertConflictReadonly(entry: ConflictEntry): boolean {
  return entry.operationType === 'revert_operation' && entry.diffs.length === 0
}

function stashEntry() {
  // 只回入口列表、不写任何数据；条目保持 conflict（SyncManager 不会自动重试）。
  selectedQueueId.value = null
}

// ---------- 决策控件 ----------

function decisionKey(queueId: number): string {
  return String(queueId)
}

function getDecision(queueId: number, field: string): FieldDecisionState | undefined {
  return decisions[decisionKey(queueId)]?.[field]
}

function decisionKind(queueId: number, field: string): DecisionKind | null {
  return getDecision(queueId, field)?.kind ?? null
}

function chooseDecision(entry: ConflictEntry, diff: FieldDiff, kind: DecisionKind) {
  const key = decisionKey(entry.queueId)
  if (!decisions[key]) decisions[key] = {}
  const prev = decisions[key][diff.field]
  decisions[key][diff.field] = {
    kind,
    manualValue:
      kind === 'manual'
        ? isBooleanDiff(diff)
          ? (prev?.manualValue || '是')
          : (prev?.manualValue ?? '')
        : '',
  }
}

function chooseManualFor(entry: ConflictEntry, field: string) {
  const key = decisionKey(entry.queueId)
  if (!decisions[key]) decisions[key] = {}
  const prev = decisions[key][field]
  decisions[key][field] = {
    kind: 'manual',
    manualValue: prev?.manualValue ?? '',
  }
}

// ---------- 字段操作 Bottom Sheet ----------

const fieldSheet = reactive({
  show: false,
  queueId: 0,
  field: '',
  isDiff: false,
})

function openFieldSheet(entry: ConflictEntry, field: string) {
  fieldSheet.queueId = entry.queueId
  fieldSheet.field = field
  fieldSheet.isDiff = diffFor(entry, field) !== undefined
  // 非冲突字段没有“保留本机/采用服务端”可选，打开即进入手填模式
  if (!fieldSheet.isDiff) chooseManualFor(entry, field)
  fieldSheet.show = true
}

function hasDecision(entry: ConflictEntry, field: string): boolean {
  return getDecision(entry.queueId, field) !== undefined
}

function handleLabel(entry: ConflictEntry, field: string): string {
  const d = getDecision(entry.queueId, field)
  if (!d) return '处理'
  if (d.kind === 'ours') return '已选：本机'
  if (d.kind === 'theirs') return '已选：服务端'
  const value = d.manualValue.trim()
  return value ? `已改：${value}` : '手填中'
}

function updateManualValue(queueId: number, field: string, value: string) {
  const key = decisionKey(queueId)
  if (!decisions[key]) decisions[key] = {}
  decisions[key][field] = { kind: 'manual', manualValue: value }
}

function onManualInput(queueId: number, field: string, event: Event) {
  updateManualValue(queueId, field, (event.target as HTMLInputElement).value)
}

function onManualSelect(queueId: number, field: string, event: Event) {
  updateManualValue(queueId, field, (event.target as HTMLSelectElement).value)
}

// ---------- 字段类型与显示规则 ----------

function isMoneyField(field: string): boolean {
  return field === 'unit_price_cents' || field === 'unitPriceCents'
}

function isNumericDiff(diff: FieldDiff): boolean {
  return [diff.baseValue, diff.oursValue, diff.theirsValue].some(
    (v) => typeof v === 'number',
  )
}

function isBooleanDiff(diff: FieldDiff): boolean {
  return [diff.baseValue, diff.oursValue, diff.theirsValue].some(
    (v) => typeof v === 'boolean',
  )
}

function isFieldBoolean(entry: ConflictEntry, field: string): boolean {
  return typeof entry.theirs[field] === 'boolean'
}

function isFieldNumeric(entry: ConflictEntry, field: string): boolean {
  return typeof entry.theirs[field] === 'number'
}

function manualPlaceholderFor(entry: ConflictEntry, field: string): string {
  if (isMoneyField(field)) return '请输入单价（元）'
  if (isFieldNumeric(entry, field)) return '请输入数值'
  return '请输入值'
}

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field
}

function diffStateLabel(state: FieldDiff['state']): string {
  return DIFF_STATE_LABELS[state]
}

function diffBadgeClass(entry: ConflictEntry, field: string): string {
  const diff = diffFor(entry, field)
  return diff ? `cb-diff-badge--${diff.state}` : ''
}

function diffBadgeLabel(entry: ConflictEntry, field: string): string {
  const diff = diffFor(entry, field)
  return diff ? diffStateLabel(diff.state) : ''
}

function formatCell(field: string, value: unknown): string {
  return formatConflictCell(field, value)
}

function cellClass(
  entry: ConflictEntry,
  field: string,
  column: 'base' | 'ours' | 'theirs',
): string {
  const diff = diffFor(entry, field)
  if (!diff) return ''
  if (column === 'ours' && (diff.state === 'ours-only' || diff.state === 'both')) {
    return 'cb-cell-highlight cb-cell-highlight--ours'
  }
  if (column === 'theirs' && (diff.state === 'theirs-only' || diff.state === 'both')) {
    return 'cb-cell-highlight cb-cell-highlight--theirs'
  }
  return ''
}

function manualPlaceholder(diff: FieldDiff): string {
  if (isMoneyField(diff.field)) return '请输入单价（元）'
  if (isNumericDiff(diff)) return '请输入数值'
  return '请输入值'
}

// ---------- 确认并重推 ----------

function isDecisionMade(queueId: number, diff: FieldDiff): boolean {
  const d = getDecision(queueId, diff.field)
  if (!d) return false
  if (d.kind !== 'manual') return true
  if (isBooleanDiff(diff)) return d.manualValue === '是' || d.manualValue === '否'
  const trimmed = d.manualValue.trim()
  if (!trimmed) return false
  if (isMoneyField(diff.field) || isNumericDiff(diff)) {
    return Number.isFinite(Number(trimmed))
  }
  return true
}

function allDecided(entry: ConflictEntry): boolean {
  return entry.diffs.every((d) => isDecisionMade(entry.queueId, d))
}

function buildResolution(entry: ConflictEntry): ConflictResolution {
  const resolution: ConflictResolution = {}
  for (const diff of entry.diffs) {
    const d = getDecision(entry.queueId, diff.field)
    if (!d) continue
    if (d.kind === 'ours') {
      resolution[diff.field] = { source: 'ours' }
    } else if (d.kind === 'theirs') {
      resolution[diff.field] = { source: 'theirs' }
    } else {
      const trimmed = d.manualValue.trim()
      if (isBooleanDiff(diff)) {
        resolution[diff.field] = { value: d.manualValue === '是' }
      } else if (isMoneyField(diff.field)) {
        const yuan = Number(trimmed)
        resolution[diff.field] = {
          value: Number.isFinite(yuan) ? Math.round(yuan * 100) : 0,
        }
      } else if (isNumericDiff(diff)) {
        const n = Number(trimmed)
        resolution[diff.field] = { value: Number.isFinite(n) ? n : 0 }
      } else {
        resolution[diff.field] = { value: trimmed }
      }
    }
  }
  // 非冲突字段也可改：手填值进入 resolution，由 buildMergedPatch 写进新 patch
  const diffFields = new Set(entry.diffs.map((d) => d.field))
  const key = decisionKey(entry.queueId)
  for (const [field, d] of Object.entries(decisions[key] ?? {})) {
    if (diffFields.has(field) || d.kind !== 'manual') continue
    const trimmed = d.manualValue.trim()
    if (!trimmed) continue
    if (isFieldBoolean(entry, field)) {
      resolution[field] = { value: trimmed === '是' }
    } else if (isMoneyField(field)) {
      const yuan = Number(trimmed)
      if (Number.isFinite(yuan)) {
        resolution[field] = { value: Math.round(yuan * 100) }
      }
    } else if (isFieldNumeric(entry, field)) {
      const n = Number(trimmed)
      if (Number.isFinite(n)) resolution[field] = { value: n }
    } else {
      resolution[field] = { value: trimmed }
    }
  }
  return resolution
}

function deleteDecisions(queueId: number) {
  delete decisions[decisionKey(queueId)]
}

async function confirmResolve(entry: ConflictEntry) {
  if (!allDecided(entry) || entry.diffs.length === 0 || submitting.value) return
  submitting.value = true
  try {
    await appState.resolveConflict(entry.queueId, buildResolution(entry))
    deleteDecisions(entry.queueId)
    selectedQueueId.value = null
    showSuccessToast('已生成合并操作并重新提交同步')
  } catch (e) {
    showFailToast(toErrorMessage(e))
  } finally {
    submitting.value = false
  }
}

async function discardEntry(entry: ConflictEntry) {
  if (!confirm('确定丢弃本机这次修改吗？服务端当前数据会保留。')) return
  try {
    await appState.discardConflict(entry.queueId)
    deleteDecisions(entry.queueId)
    selectedQueueId.value = null
    showSuccessToast('已丢弃本机修改')
  } catch (e) {
    showFailToast(toErrorMessage(e))
  }
}

// ---------- 去查账本核对 ----------

function goLedger(entry: ConflictEntry) {
  const order = workOrderFor(entry)
  appState.setTab('ledger')
  appState.ledgerFilters.datePreset = 'all'
  appState.ledgerFilters.customerId = order?.customerId ?? null
  appState.ledgerFilters.categoryName = null
  appState.ledgerFilters.searchKeyword = ''
  emit('back')
}

onMounted(async () => {
  try {
    await appState.reload()
  } catch {
    // 刷新失败时保留既有列表，页面仍可浏览
  }
})
</script>

<template>
  <div class="cb-conflict-center cb-page-container">
    <header class="md3-top-app-bar">
      <button
        type="button"
        class="md3-icon-button cb-pressable"
        :aria-label="selectedEntry ? '返回冲突列表' : '返回设置页'"
        @click="selectedEntry ? backToEntryList() : emit('back')"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5M12 19l-7-7 7-7"/>
        </svg>
      </button>
      <h1 class="md3-top-app-bar-title">{{ selectedEntry ? '冲突详情' : '冲突解决中心' }}</h1>
      <div style="width: 48px;"></div>
    </header>

    <main class="cb-subpage-body">
      <div v-if="entries.length === 0" class="cb-empty-state">
        <span class="cb-empty-icon">🧭</span>
        <span class="cb-empty-text">暂无冲突，所有本地修改都已与云端对齐</span>
      </div>

      <!-- 一级：冲突入口列表，只显示入口 -->
      <div v-else-if="!selectedEntry" class="cb-conflict-list">
        <section
          v-for="entry in entries"
          :key="entry.queueId"
          class="cb-conflict-entry"
        >
          <button
            type="button"
            class="cb-conflict-summary cb-pressable"
            @click="openEntry(entry)"
          >
            <div class="cb-conflict-summary-top">
              <div class="cb-conflict-badges">
                <span class="cb-op-badge cb-tabular-nums">{{ operationLabel(entry) }}</span>
                <span class="cb-source-badge">{{ actorLabel(entry) }}</span>
              </div>
              <span class="cb-conflict-time cb-tabular-nums">{{ formatLocalTime(entry.createdAt) }}</span>
            </div>
            <div class="cb-conflict-summary-bottom">
              <span class="cb-conflict-order">{{ orderLabel(entry) }}</span>
              <svg
                class="cb-conflict-chevron"
                width="26"
                height="26"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M9 6l6 6-6 6"/>
              </svg>
            </div>
          </button>
        </section>
      </div>

      <!-- 二级：单条冲突详情 -->
      <div v-else class="cb-conflict-detail-page">
        <div class="cb-conflict-detail-head">
          <div class="cb-conflict-badges">
            <span class="cb-op-badge cb-tabular-nums">{{ operationLabel(selectedEntry) }}</span>
            <span class="cb-source-badge">{{ actorLabel(selectedEntry) }}</span>
          </div>
          <div class="cb-conflict-detail-sub">
            <span class="cb-conflict-order">{{ orderLabel(selectedEntry) }}</span>
            <span class="cb-conflict-time cb-tabular-nums">{{ formatLocalTime(selectedEntry.createdAt) }}</span>
          </div>
        </div>

        <!-- 逐字段线性展示：冲突字段排前；左滑露出“处理”，点击从底部弹出操作面板 -->
        <p class="cb-fields-hint">向左滑动字段卡片，点“处理”决定该字段怎么合并</p>
        <div class="cb-fields-section">
          <div
            v-for="field in fieldsFor(selectedEntry)"
            :key="field"
            class="cb-field-row"
          >
            <div
              class="cb-field-card"
              :class="{ 'cb-field-card--diff': diffFor(selectedEntry, field) }"
            >
              <div class="cb-field-card-head">
                <span class="cb-field-card-title">{{ fieldLabel(field) }}</span>
                <span
                  v-if="diffFor(selectedEntry, field)"
                  class="cb-diff-badge"
                  :class="diffBadgeClass(selectedEntry, field)"
                >
                  {{ diffBadgeLabel(selectedEntry, field) }}
                </span>
                <span v-else class="cb-same-badge">无冲突</span>
                <span
                  v-if="hasDecision(selectedEntry, field)"
                  class="cb-handled-tag"
                >
                  {{ handleLabel(selectedEntry, field) }}
                </span>
              </div>

              <table class="cb-field-mini-table">
                <thead>
                  <tr>
                    <th>修改前</th>
                    <th>本机</th>
                    <th>服务端</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{{ formatCell(field, selectedEntry.base[field]) }}</td>
                    <td :class="cellClass(selectedEntry, field, 'ours')">{{ formatCell(field, selectedEntry.ours[field]) }}</td>
                    <td :class="cellClass(selectedEntry, field, 'theirs')">{{ formatCell(field, selectedEntry.theirs[field]) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <button
              type="button"
              class="cb-field-edit cb-pressable"
              :aria-label="`处理 ${fieldLabel(field)}`"
              @click="openFieldSheet(selectedEntry, field)"
            >
              处理
            </button>
          </div>
        </div>

        <div v-if="selectedEntry.diffs.length === 0" class="cb-no-diff-tip">
          <template v-if="isRevertConflictReadonly(selectedEntry)">
            该冲突是撤回冲突，当前版本无三方合并路径，请先解决该记录的其他冲突或重新提交撤回
          </template>
          <template v-else>该冲突没有需要决策的差异字段。</template>
        </div>

        <!-- 操作区 -->
        <div class="cb-conflict-actions">
          <p
            v-if="selectedEntry.diffs.length > 0 && !allDecided(selectedEntry)"
            class="cb-pending-tip"
          >
            还有 {{ selectedEntry.diffs.length - decidedCount(selectedEntry) }} 个冲突字段未选择
          </p>
          <div class="cb-conflict-actions-row">
            <button
              type="button"
              class="md3-outlined-button-small cb-pressable"
              @click="goLedger(selectedEntry)"
            >
              去查账本核对
            </button>
            <button
              type="button"
              class="md3-outlined-button-small cb-pressable"
              @click="stashEntry"
            >
              暂存，稍后处理
            </button>
          </div>
          <button
            type="button"
            class="md3-outlined-button-small cb-discard-btn cb-pressable"
            @click="discardEntry(selectedEntry)"
          >
            丢弃本机修改
          </button>
          <button
            type="button"
            class="md3-filled-button-small cb-confirm-btn cb-pressable"
            :disabled="!allDecided(selectedEntry) || selectedEntry.diffs.length === 0 || submitting"
            @click="confirmResolve(selectedEntry)"
          >
            {{ submitting ? '提交中…' : '确认并重推' }}
          </button>
        </div>
      </div>
    </main>

    <!-- 字段处理 Bottom Sheet -->
    <van-popup
      v-if="selectedEntry"
      v-model:show="fieldSheet.show"
      position="bottom"
      round
      :duration="0.35"
    >
      <div class="cb-field-sheet">
        <div class="cb-field-sheet-head">
          <span class="cb-field-sheet-title">{{ fieldLabel(fieldSheet.field) }}</span>
          <span v-if="fieldSheet.isDiff" class="cb-field-sheet-values">
            {{ formatCell(fieldSheet.field, selectedEntry.base[fieldSheet.field]) }}
            → {{ formatCell(fieldSheet.field, selectedEntry.ours[fieldSheet.field]) }}
            / 服务端 {{ formatCell(fieldSheet.field, selectedEntry.theirs[fieldSheet.field]) }}
          </span>
          <span v-else class="cb-field-sheet-values">
            当前值：{{ formatCell(fieldSheet.field, selectedEntry.theirs[fieldSheet.field]) }}
          </span>
        </div>

        <template v-if="fieldSheet.isDiff">
          <button
            type="button"
            class="cb-sheet-action cb-pressable"
            @click="chooseDecision(selectedEntry, diffFor(selectedEntry, fieldSheet.field)!, 'ours'); fieldSheet.show = false"
          >
            保留本机 · {{ formatCell(fieldSheet.field, selectedEntry.ours[fieldSheet.field]) }}
          </button>
          <button
            type="button"
            class="cb-sheet-action cb-pressable"
            @click="chooseDecision(selectedEntry, diffFor(selectedEntry, fieldSheet.field)!, 'theirs'); fieldSheet.show = false"
          >
            采用服务端 · {{ formatCell(fieldSheet.field, selectedEntry.theirs[fieldSheet.field]) }}
          </button>
          <button
            type="button"
            class="cb-sheet-action cb-sheet-action--manual cb-pressable"
            @click="chooseDecision(selectedEntry, diffFor(selectedEntry, fieldSheet.field)!, 'manual')"
          >
            手动填写
          </button>
        </template>

        <div
          v-if="!fieldSheet.isDiff || decisionKind(fieldSheet.queueId, fieldSheet.field) === 'manual'"
          class="cb-sheet-manual"
        >
          <select
            v-if="!fieldSheet.isDiff && isFieldBoolean(selectedEntry, fieldSheet.field)"
            class="cb-manual-input cb-manual-select"
            :value="getDecision(fieldSheet.queueId, fieldSheet.field)?.manualValue || '是'"
            :aria-label="`手填 ${fieldLabel(fieldSheet.field)}`"
            @change="onManualSelect(fieldSheet.queueId, fieldSheet.field, $event)"
          >
            <option value="是">是</option>
            <option value="否">否</option>
          </select>
          <select
            v-else-if="fieldSheet.isDiff && isBooleanDiff(diffFor(selectedEntry, fieldSheet.field)!)"
            class="cb-manual-input cb-manual-select"
            :value="getDecision(fieldSheet.queueId, fieldSheet.field)?.manualValue || '是'"
            :aria-label="`手填 ${fieldLabel(fieldSheet.field)}`"
            @change="onManualSelect(fieldSheet.queueId, fieldSheet.field, $event)"
          >
            <option value="是">是</option>
            <option value="否">否</option>
          </select>
          <div v-else class="cb-manual-input-wrap">
            <input
              class="cb-manual-input"
              type="text"
              :inputmode="
                fieldSheet.isDiff
                  ? (isNumericDiff(diffFor(selectedEntry, fieldSheet.field)!) ? 'decimal' : undefined)
                  : (isFieldNumeric(selectedEntry, fieldSheet.field) ? 'decimal' : undefined)
              "
              :placeholder="
                fieldSheet.isDiff
                  ? manualPlaceholder(diffFor(selectedEntry, fieldSheet.field)!)
                  : manualPlaceholderFor(selectedEntry, fieldSheet.field)
              "
              :value="getDecision(fieldSheet.queueId, fieldSheet.field)?.manualValue ?? ''"
              :aria-label="`手填 ${fieldLabel(fieldSheet.field)}`"
              @input="onManualInput(fieldSheet.queueId, fieldSheet.field, $event)"
            />
            <span v-if="isMoneyField(fieldSheet.field)" class="cb-manual-unit">元</span>
          </div>
          <button
            type="button"
            class="cb-sheet-confirm cb-pressable"
            @click="fieldSheet.show = false"
          >
            确定
          </button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.cb-conflict-center {
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
   复用 SettingsView 的 MD3 局部样式（scoped 组件间不共享，按需重建）
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

.cb-subpage-body {
  padding: 12px 12px 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.md3-card {
  border-radius: var(--md-sys-shape-corner-large);
  padding: 16px;
  box-sizing: border-box;
}

.md3-card--outlined {
  background: var(--md-sys-color-surface);
  border: 1px solid var(--md-sys-color-outline-variant);
}

.md3-divider {
  height: 1px;
  background: var(--md-sys-color-outline-variant);
  margin: 10px 0;
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

/* ==========================================================================
   冲突列表与摘要行
   ========================================================================== */
.cb-conflict-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cb-conflict-entry {
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-large);
  overflow: hidden;
}

.cb-conflict-entry .cb-conflict-summary {
  padding: 16px 14px;
  min-height: 88px;
  justify-content: center;
}

.cb-conflict-detail-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cb-conflict-detail-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cb-conflict-detail-sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.cb-conflict-summary {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: transparent;
  border: none;
  text-align: left;
  padding: 0;
  color: var(--md-sys-color-on-surface);
}

.cb-conflict-summary-top,
.cb-conflict-summary-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.cb-conflict-badges {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.cb-op-badge {
  background: var(--md-sys-color-on-surface);
  color: var(--md-sys-color-surface);
  font-family: var(--cb-font-numeric);
  font-size: 14px;
  font-weight: 800;
  padding: 5px 12px;
  border-radius: var(--md-sys-shape-corner-extra-small);
  flex-shrink: 0;
}

.cb-source-badge {
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface-variant);
  font-size: 14px;
  font-weight: 700;
  padding: 4px 12px;
  border-radius: var(--md-sys-shape-corner-full);
  flex-shrink: 0;
}

.cb-conflict-time {
  font-size: 14px;
  color: var(--md-sys-color-outline);
  flex-shrink: 0;
}

.cb-conflict-order {
  font-size: 18px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cb-conflict-chevron {
  color: var(--md-sys-color-outline);
  flex-shrink: 0;
  transition: transform var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-conflict-chevron.is-expanded {
  transform: rotate(180deg);
}

/* ==========================================================================
   逐字段卡片：字段名作标题，卡片内三列小横表（修改前/本机/服务端）
   ========================================================================== */
.cb-fields-hint {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--md-sys-color-outline);
}

.cb-fields-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 字段卡片可左滑，露出右侧“处理”按钮（无 scroll-snap，避免露头后回弹） */
.cb-fields-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cb-field-row {
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  scrollbar-width: none;
  border-radius: var(--md-sys-shape-corner-medium);
}

.cb-field-row::-webkit-scrollbar {
  display: none;
}

.cb-field-card {
  flex: 0 0 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
}

.cb-field-edit {
  flex: 0 0 72px;
  margin-left: 8px;
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--cb-status-warning-text);
  color: #ffffff;
  font-size: 14px;
  font-weight: 800;
  cursor: pointer;
}

.cb-handled-tag {
  margin-left: auto;
  font-size: 12px;
  font-weight: 800;
  color: var(--cb-status-warning-text);
  flex-shrink: 0;
}

/* 字段操作 Bottom Sheet */
.cb-field-sheet {
  padding: 20px 16px calc(20px + env(safe-area-inset-bottom, 0px));
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: cb-field-sheet-in 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
}

@keyframes cb-field-sheet-in {
  from {
    opacity: 0;
    transform: translateY(24px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.cb-field-sheet-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cb-field-sheet-title {
  font-size: 18px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

.cb-field-sheet-values {
  font-size: 13px;
  color: var(--md-sys-color-outline);
  font-variant-numeric: tabular-nums;
}

.cb-sheet-action {
  min-height: 48px;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-low);
  color: var(--md-sys-color-on-surface);
  font-size: 15px;
  font-weight: 800;
  cursor: pointer;
}

.cb-sheet-action--manual {
  background: transparent;
  color: var(--md-sys-color-primary);
  border-color: var(--md-sys-color-primary);
}

.cb-sheet-manual {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cb-sheet-confirm {
  min-height: 48px;
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  font-size: 15px;
  font-weight: 800;
  cursor: pointer;
}

/* 冲突字段卡片：主题色实心 */
.cb-field-card--diff {
  background: var(--md-sys-color-primary);
  border-color: var(--md-sys-color-primary);
}

.cb-field-card--diff .cb-field-card-title {
  color: var(--md-sys-color-on-primary);
}

.cb-field-card--diff .cb-field-mini-table th {
  color: var(--md-sys-color-on-primary);
  opacity: 0.8;
}

.cb-field-card--diff .cb-field-mini-table td {
  color: var(--md-sys-color-on-primary);
}

.cb-field-card--diff .cb-cell-highlight--ours {
  background: color-mix(in srgb, var(--md-sys-color-on-primary) 24%, transparent);
  color: var(--md-sys-color-on-primary);
}

.cb-field-card--diff .cb-cell-highlight--theirs {
  background: var(--md-sys-color-tertiary-container);
  color: var(--md-sys-color-on-tertiary-container);
}

.cb-field-card--diff .cb-diff-badge {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--md-sys-color-on-primary) 40%, transparent);
}

.cb-field-card--diff .md3-filter-chip {
  background: var(--md-sys-color-primary);
  border-color: var(--md-sys-color-on-primary);
  color: var(--md-sys-color-on-primary);
}

.cb-field-card--diff .md3-filter-chip--selected {
  background: var(--md-sys-color-on-primary);
  border-color: var(--md-sys-color-on-primary);
  color: var(--md-sys-color-primary);
}

.cb-field-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.cb-field-card-title {
  font-size: 14px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

.cb-same-badge {
  font-size: 10px;
  font-weight: 700;
  color: var(--md-sys-color-outline);
  background: var(--md-sys-color-surface-container);
  padding: 2px 8px;
  border-radius: var(--md-sys-shape-corner-full);
  flex-shrink: 0;
}

.cb-field-mini-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 4px 0;
  table-layout: fixed;
  font-size: 13px;
}

.cb-field-mini-table th {
  font-size: 11px;
  font-weight: 800;
  color: var(--md-sys-color-outline);
  text-align: left;
  padding: 2px 4px;
  letter-spacing: 0.2px;
}

.cb-field-mini-table td {
  padding: 6px 8px;
  color: var(--md-sys-color-on-surface);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
  border-radius: var(--md-sys-shape-corner-extra-small);
  vertical-align: top;
}

.cb-diff-badge {
  display: inline-block;
  margin-left: 6px;
  font-size: 10px;
  font-weight: 800;
  padding: 2px 6px;
  border-radius: var(--md-sys-shape-corner-full);
  white-space: nowrap;
}

.cb-diff-badge--ours-only {
  background: var(--cb-status-info-bg);
  color: var(--cb-status-info-text);
}

.cb-diff-badge--theirs-only {
  background: var(--cb-status-purple-bg);
  color: var(--cb-status-purple-text);
}

.cb-diff-badge--both {
  background: var(--cb-status-warning-bg);
  color: var(--cb-status-warning-text);
}

.cb-cell-highlight {
  font-weight: 800;
}

.cb-cell-highlight--ours {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}

.cb-cell-highlight--theirs {
  background: var(--md-sys-color-tertiary-container);
  color: var(--md-sys-color-on-tertiary-container);
}

/* ==========================================================================
   冲突字段处理按钮（跟随字段卡片）
   ========================================================================== */
.cb-field-actions {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cb-decision-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.cb-manual-row {
  margin-top: 2px;
}

.cb-manual-input-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cb-manual-input {
  flex: 1;
  height: 40px;
  padding: 0 12px;
  border: 1.5px solid var(--md-sys-color-outline);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface);
  font-size: 16px;
  outline: none;
  box-sizing: border-box;
}
.cb-manual-input:focus {
  border-color: var(--md-sys-color-primary);
  box-shadow: 0 0 0 1px var(--md-sys-color-primary);
}

.cb-manual-select {
  width: 100%;
  flex: none;
}

.cb-manual-unit {
  font-size: 13px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface-variant);
  flex-shrink: 0;
}

.cb-no-diff-tip {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--md-sys-color-outline);
  background: var(--md-sys-color-surface-container-low);
  border-radius: var(--md-sys-shape-corner-small);
}

.cb-pending-tip {
  margin: 0;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 700;
  color: var(--cb-status-warning-text);
  background: var(--cb-status-warning-bg);
  border-radius: var(--md-sys-shape-corner-small);
}

/* ==========================================================================
   操作区
   ========================================================================== */
.cb-conflict-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.cb-conflict-actions-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.cb-conflict-actions-row .md3-outlined-button-small {
  width: 100%;
}

.cb-discard-btn {
  width: 100%;
  color: var(--md-sys-color-error);
  border-color: var(--md-sys-color-error);
}

.cb-confirm-btn {
  width: 100%;
  height: 44px;
}

.cb-confirm-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  box-shadow: none;
}
</style>
