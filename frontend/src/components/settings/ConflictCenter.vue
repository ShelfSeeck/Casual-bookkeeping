<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { appState, type ConflictEntry } from '../../state/appState'
import type { ConflictResolution, FieldDiff } from '../../services/conflictResolver'
import { toErrorMessage } from '../../services/errorMessages'

// 冲突解决中心（推入式子页面，由 SettingsView 以 currentSubPage 切换进入）。
// 每条冲突：摘要行 + 展开后的 Base/Ours/Theirs 完整三方对比表；
// 每个差异字段必须显式选择 本机(Ours)/服务端(Theirs)/手填，全部决策后才允许确认并重推。

const emit = defineEmits<{ back: [] }>()

const entries = computed(() => appState.conflictEntries.value)
const expandedQueueId = ref<number | null>(null)
const submitting = ref(false)

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
    fields = [...set].sort((a, b) => a.localeCompare(b))
    fieldLists.set(entry, fields)
  }
  return fields
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

// ---------- 展开 / 暂存 ----------

function isExpanded(entry: ConflictEntry): boolean {
  return expandedQueueId.value === entry.queueId
}

function toggleExpanded(entry: ConflictEntry) {
  expandedQueueId.value = isExpanded(entry) ? null : entry.queueId
}

function stashEntry() {
  // 只收起详情、不写任何数据；条目保持 conflict（SyncManager 不会自动重试）。
  expandedQueueId.value = null
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
  if (value === null || value === undefined) return '—'
  if (isMoneyField(field)) {
    const n =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number.parseFloat(value)
          : Number.NaN
    if (Number.isFinite(n)) return (n / 100).toFixed(2)
    return String(value)
  }
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
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
  return resolution
}

function deleteDecisions(queueId: number) {
  delete decisions[decisionKey(queueId)]
}

async function confirmResolve(entry: ConflictEntry) {
  if (!allDecided(entry) || submitting.value) return
  submitting.value = true
  try {
    await appState.resolveConflict(entry.queueId, buildResolution(entry))
    deleteDecisions(entry.queueId)
    expandedQueueId.value = null
    showSuccessToast('已生成合并操作并重新提交同步')
  } catch (e) {
    showFailToast(toErrorMessage(e))
  } finally {
    submitting.value = false
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
        aria-label="返回设置页"
        @click="emit('back')"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5M12 19l-7-7 7-7"/>
        </svg>
      </button>
      <h1 class="md3-top-app-bar-title">冲突解决中心</h1>
      <div style="width: 48px;"></div>
    </header>

    <main class="cb-subpage-body">
      <div v-if="entries.length === 0" class="cb-empty-state">
        <span class="cb-empty-icon">🧭</span>
        <span class="cb-empty-text">暂无冲突，所有本地修改都已与云端对齐</span>
      </div>

      <div v-else class="cb-conflict-list">
        <div
          v-for="entry in entries"
          :key="entry.queueId"
          class="md3-card md3-card--outlined cb-conflict-card"
        >
          <!-- 摘要行 -->
          <button
            type="button"
            class="cb-conflict-summary cb-pressable"
            :aria-expanded="isExpanded(entry)"
            @click="toggleExpanded(entry)"
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
                :class="{ 'is-expanded': isExpanded(entry) }"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M6 9l6 6 6-6"/>
              </svg>
            </div>
          </button>

          <!-- 展开详情 -->
          <div v-if="isExpanded(entry)" class="cb-conflict-detail">
            <div class="md3-divider" aria-hidden="true"></div>

            <div class="md3-card-title">三方对比（Base / Ours / Theirs）</div>
            <div class="cb-compare-scroll">
              <table class="cb-compare-table">
                <thead>
                  <tr>
                    <th class="cb-col-field">字段</th>
                    <th>Base</th>
                    <th>Ours</th>
                    <th>Theirs</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="field in fieldsFor(entry)"
                    :key="field"
                    :class="{ 'cb-diff-row': diffFor(entry, field) }"
                  >
                    <td class="cb-col-field">
                      <span class="cb-field-name">{{ fieldLabel(field) }}</span>
                      <span
                        v-if="diffFor(entry, field)"
                        class="cb-diff-badge"
                        :class="diffBadgeClass(entry, field)"
                      >
                        {{ diffBadgeLabel(entry, field) }}
                      </span>
                    </td>
                    <td>{{ formatCell(field, entry.base[field]) }}</td>
                    <td :class="cellClass(entry, field, 'ours')">{{ formatCell(field, entry.ours[field]) }}</td>
                    <td :class="cellClass(entry, field, 'theirs')">{{ formatCell(field, entry.theirs[field]) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 逐字段决策 -->
            <div v-if="entry.diffs.length > 0" class="cb-decision-section">
              <div class="md3-card-title">逐字段决策</div>
              <div
                v-for="diff in entry.diffs"
                :key="diff.field"
                class="cb-decision-row"
              >
                <div class="cb-decision-field">
                  <span class="cb-decision-field-name">{{ fieldLabel(diff.field) }}</span>
                  <span class="cb-diff-badge" :class="`cb-diff-badge--${diff.state}`">
                    {{ diffStateLabel(diff.state) }}
                  </span>
                </div>

                <div class="cb-decision-chips" role="group" :aria-label="`选择 ${fieldLabel(diff.field)} 的取值来源`">
                  <button
                    type="button"
                    class="md3-filter-chip cb-pressable"
                    :class="{ 'md3-filter-chip--selected': decisionKind(entry.queueId, diff.field) === 'ours' }"
                    :aria-pressed="decisionKind(entry.queueId, diff.field) === 'ours'"
                    @click="chooseDecision(entry, diff, 'ours')"
                  >
                    本机(Ours)
                  </button>
                  <button
                    type="button"
                    class="md3-filter-chip cb-pressable"
                    :class="{ 'md3-filter-chip--selected': decisionKind(entry.queueId, diff.field) === 'theirs' }"
                    :aria-pressed="decisionKind(entry.queueId, diff.field) === 'theirs'"
                    @click="chooseDecision(entry, diff, 'theirs')"
                  >
                    服务端(Theirs)
                  </button>
                  <button
                    type="button"
                    class="md3-filter-chip cb-pressable"
                    :class="{ 'md3-filter-chip--selected': decisionKind(entry.queueId, diff.field) === 'manual' }"
                    :aria-pressed="decisionKind(entry.queueId, diff.field) === 'manual'"
                    @click="chooseDecision(entry, diff, 'manual')"
                  >
                    手填
                  </button>
                </div>

                <div v-if="decisionKind(entry.queueId, diff.field) === 'manual'" class="cb-manual-row">
                  <select
                    v-if="isBooleanDiff(diff)"
                    class="cb-manual-input cb-manual-select"
                    :value="getDecision(entry.queueId, diff.field)?.manualValue || '是'"
                    :aria-label="`手填 ${fieldLabel(diff.field)}`"
                    @change="onManualSelect(entry.queueId, diff.field, $event)"
                  >
                    <option value="是">是</option>
                    <option value="否">否</option>
                  </select>
                  <div v-else class="cb-manual-input-wrap">
                    <input
                      class="cb-manual-input"
                      type="text"
                      :inputmode="isNumericDiff(diff) ? 'decimal' : undefined"
                      :placeholder="manualPlaceholder(diff)"
                      :value="getDecision(entry.queueId, diff.field)?.manualValue ?? ''"
                      :aria-label="`手填 ${fieldLabel(diff.field)}`"
                      @input="onManualInput(entry.queueId, diff.field, $event)"
                    />
                    <span v-if="isMoneyField(diff.field)" class="cb-manual-unit">元</span>
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="cb-no-diff-tip">该冲突没有需要决策的差异字段。</div>

            <!-- 操作区 -->
            <div class="cb-conflict-actions">
              <div class="cb-conflict-actions-row">
                <button
                  type="button"
                  class="md3-outlined-button-small cb-pressable"
                  @click="goLedger(entry)"
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
                class="md3-filled-button-small cb-confirm-btn cb-pressable"
                :disabled="!allDecided(entry) || submitting"
                @click="confirmResolve(entry)"
              >
                {{ submitting ? '提交中…' : '确认并重推' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.cb-conflict-center {
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
  padding: 16px;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
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

.cb-conflict-card {
  padding: 12px 14px;
}

.cb-conflict-summary {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  font-size: 12px;
  font-weight: 800;
  padding: 3px 8px;
  border-radius: var(--md-sys-shape-corner-extra-small);
  flex-shrink: 0;
}

.cb-source-badge {
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface-variant);
  font-size: 12px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: var(--md-sys-shape-corner-full);
  flex-shrink: 0;
}

.cb-conflict-time {
  font-size: 12px;
  color: var(--md-sys-color-outline);
  flex-shrink: 0;
}

.cb-conflict-order {
  font-size: 14px;
  font-weight: 700;
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
   三方对比表
   ========================================================================== */
.cb-compare-scroll {
  overflow-x: auto;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
}

.cb-compare-table {
  width: 100%;
  min-width: 520px;
  border-collapse: collapse;
  font-size: 12px;
}

.cb-compare-table th,
.cb-compare-table td {
  padding: 10px 8px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  text-align: left;
  vertical-align: top;
  color: var(--md-sys-color-on-surface);
}

.cb-compare-table thead th {
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface-variant);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.3px;
}

.cb-compare-table tbody tr:last-child td {
  border-bottom: none;
}

.cb-col-field {
  width: 34%;
  min-width: 120px;
}

.cb-field-name {
  display: inline-block;
  font-weight: 700;
  margin-bottom: 4px;
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

.cb-diff-row {
  background: var(--md-sys-color-surface-container-low);
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
   逐字段决策
   ========================================================================== */
.cb-decision-section {
  margin-top: 16px;
}

.cb-decision-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  margin-bottom: 8px;
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
}

.cb-decision-field {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.cb-decision-field-name {
  font-size: 13px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
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
  font-size: 14px;
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

/* ==========================================================================
   操作区
   ========================================================================== */
.cb-conflict-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
}

.cb-conflict-actions-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.cb-conflict-actions-row .md3-outlined-button-small {
  width: 100%;
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
