<script setup lang="ts">
import { computed, ref } from 'vue'
import { appState, type AiDraftDecisionAction } from '../../state/appState'
import type { PreparedAiDraft } from '../../services/chatApprovalBatch'

const emit = defineEmits<{ back: [] }>()
const activeFilter = ref<'all' | AiDraftDecisionAction>('all')
const confirmOpen = ref(false)

const approval = computed(() => appState.pendingApproval.value)
const drafts = computed(() => approval.value?.drafts ?? [])
const counts = computed(() => {
  const result = { approve: 0, regenerate: 0, reject: 0 }
  for (const draft of drafts.value) {
    const action = approval.value?.decisions[draft.toolCallId]?.action ?? 'approve'
    result[action] += 1
  }
  return result
})
const filteredDrafts = computed(() => {
  if (activeFilter.value === 'all') return drafts.value
  return drafts.value.filter(
    (draft) => approval.value?.decisions[draft.toolCallId]?.action === activeFilter.value,
  )
})
const hasInvalidReason = computed(() => {
  const current = approval.value
  if (!current) return true
  return current.drafts.some((draft) => {
    const state = current.decisions[draft.toolCallId]
    if (!state) return true
    if (state.action === 'approve') return false
    if (!state.reasonCode) return true
    if (state.action === 'regenerate' && !state.note.trim()) return true
    return state.reasonCode === '其他' && !state.note.trim()
  })
})
const isResumeOnly = computed(
  () => approval.value?.localOperationId !== null && approval.value?.resumeError !== null,
)

const rejectReasons = ['重复工单', '暂不处理', '与指令不符', '其他']
const regenerateReasons = ['客户不对', '数值不对', '服务不对', '日期不对', '与指令不符', '其他']

function decisionFor(draft: PreparedAiDraft) {
  return approval.value?.decisions[draft.toolCallId]
}

function setAction(draft: PreparedAiDraft, action: AiDraftDecisionAction) {
  const current = decisionFor(draft)
  appState.setAiDraftDecision(
    draft.toolCallId,
    action,
    action === 'approve' ? '' : (current?.reasonCode ?? ''),
    action === 'approve' ? '' : (current?.note ?? ''),
  )
}

function setReason(draft: PreparedAiDraft, reasonCode: string) {
  const current = decisionFor(draft)
  if (!current) return
  appState.setAiDraftDecision(draft.toolCallId, current.action, reasonCode, current.note)
}

function setNote(draft: PreparedAiDraft, note: string) {
  const current = decisionFor(draft)
  if (!current) return
  appState.setAiDraftDecision(draft.toolCallId, current.action, current.reasonCode, note)
}

function requestSubmit() {
  if (!hasInvalidReason.value) confirmOpen.value = true
}

async function confirmSubmit() {
  confirmOpen.value = false
  await appState.submitAiApproval()
  if (!appState.pendingApproval.value || appState.pendingApproval.value.requestId !== approval.value?.requestId) {
    emit('back')
  }
}

async function retryResume() {
  await appState.retryAiApproval()
  if (!appState.pendingApproval.value) emit('back')
}

function field(draft: PreparedAiDraft, name: string): unknown {
  return draft.fields[name]
}

function before(draft: PreparedAiDraft, name: string): unknown {
  return draft.before?.[name]
}

function customerText(source: Record<string, unknown> | null): string {
  if (!source) return '—'
  return [source.customer_code, source.customer_name].filter(Boolean).join(' · ') || '—'
}

function serviceText(source: Record<string, unknown> | null): string {
  if (!source) return '—'
  return [source.service_category, source.service_item].filter(Boolean).join(' / ') || '—'
}

function quantityText(source: Record<string, unknown> | null): string {
  if (!source) return '—'
  const quantity = source.quantity ?? '—'
  return `${quantity} ${String(source.unit ?? '').trim()}`.trim()
}

function priceText(value: unknown): string {
  if (value === null || value === undefined) return '未定价'
  if (typeof value !== 'number') return String(value)
  return `¥${(value / 100).toFixed(2)}`
}

function completedText(value: unknown): string {
  return value === 1 || value === true ? '已完成' : '未完成'
}

function createdTime(draft: PreparedAiDraft): string {
  const value = before(draft, 'created_at')
  if (typeof value !== 'string') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

interface ChangeRow { label: string; oldValue: string; newValue: string }
function changeRows(draft: PreparedAiDraft): ChangeRow[] {
  if (draft.kind !== 'update') return []
  const rows: ChangeRow[] = []
  const changed = new Set(Object.keys(draft.fields))
  if (['customer_id', 'customer_code', 'customer_name'].some((name) => changed.has(name))) {
    rows.push({ label: '客户', oldValue: customerText(draft.before), newValue: customerText({ ...draft.before, ...draft.fields }) })
  }
  if (changed.has('work_order_date')) {
    rows.push({ label: '日期', oldValue: String(before(draft, 'work_order_date') ?? '—'), newValue: String(field(draft, 'work_order_date') ?? '—') })
  }
  if (changed.has('service_category') || changed.has('service_item')) {
    rows.push({ label: '服务', oldValue: serviceText(draft.before), newValue: serviceText({ ...draft.before, ...draft.fields }) })
  }
  if (changed.has('quantity') || changed.has('unit')) {
    rows.push({ label: '数量', oldValue: quantityText(draft.before), newValue: quantityText({ ...draft.before, ...draft.fields }) })
  }
  if (changed.has('unit_price_cents')) {
    rows.push({ label: '单价', oldValue: priceText(before(draft, 'unit_price_cents')), newValue: priceText(field(draft, 'unit_price_cents')) })
  }
  if (changed.has('is_completed')) {
    rows.push({ label: '完成状态', oldValue: completedText(before(draft, 'is_completed')), newValue: completedText(field(draft, 'is_completed')) })
  }
  return rows
}
</script>

<template>
  <section class="cb-ai-review" aria-label="审核 AI 工单草案">
    <header class="cb-ai-review__topbar">
      <button type="button" class="cb-ai-review__icon-button cb-pressable" aria-label="返回 AI 对话" @click="emit('back')">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M19 12H5"></path><path d="m12 19-7-7 7-7"></path>
        </svg>
      </button>
      <div class="cb-ai-review__title-group">
        <h2>审核 AI 草案</h2>
        <span>{{ drafts.length }} 张工单</span>
      </div>
      <div class="cb-ai-review__top-spacer" aria-hidden="true"></div>
    </header>

    <main class="cb-ai-review__content">
      <section class="cb-ai-review__summary" aria-label="审核统计">
        <div class="cb-ai-review__summary-counts">
          <span><strong>{{ counts.approve }}</strong> 批准</span>
          <span><strong>{{ counts.regenerate }}</strong> 重新生成</span>
          <span><strong>{{ counts.reject }}</strong> 拒绝</span>
        </div>
        <p>批准项将作为一个批次提交；任意一张失败，批准项全部不写入。</p>
      </section>

      <div class="cb-ai-review__filters" role="group" aria-label="按处理状态筛选">
        <button
          v-for="filter in [
            { key: 'all', label: '全部', count: drafts.length },
            { key: 'approve', label: '批准', count: counts.approve },
            { key: 'regenerate', label: '重新生成', count: counts.regenerate },
            { key: 'reject', label: '拒绝', count: counts.reject },
          ]"
          :key="filter.key"
          type="button"
          class="cb-ai-review__filter-chip cb-pressable"
          :class="{ 'is-selected': activeFilter === filter.key }"
          :aria-pressed="activeFilter === filter.key"
          @click="activeFilter = filter.key as typeof activeFilter"
        >
          {{ filter.label }} {{ filter.count }}
        </button>
      </div>

      <div v-if="approval?.resumeError" class="cb-ai-review__resume-error" role="alert">
        <strong>工单已保存，AI 对话续接失败</strong>
        <span>{{ approval.resumeError }}</span>
      </div>

      <div class="cb-ai-review__list">
        <article
          v-for="(draft, index) in filteredDrafts"
          :key="draft.toolCallId"
          class="cb-ai-draft"
          :class="`cb-ai-draft--${decisionFor(draft)?.action ?? 'approve'}`"
        >
          <header class="cb-ai-draft__header">
            <div class="cb-ai-draft__heading">
              <span class="cb-ai-draft__index">{{ String(index + 1).padStart(2, '0') }}</span>
              <div>
                <h3>{{ draft.kind === 'create' ? '新建工单' : '修改工单' }}</h3>
                <span>{{ draft.kind === 'create' ? customerText(draft.fields) : customerText(draft.before) }}</span>
              </div>
            </div>
            <span class="cb-ai-draft__status">{{ decisionFor(draft)?.action === 'approve' ? '批准' : decisionFor(draft)?.action === 'regenerate' ? '重新生成' : '拒绝' }}</span>
          </header>

          <template v-if="draft.kind === 'create'">
            <dl class="cb-ai-draft__details">
              <div><dt>日期</dt><dd>{{ field(draft, 'work_order_date') }}</dd></div>
              <div><dt>客户</dt><dd>{{ customerText(draft.fields) }}</dd></div>
              <div><dt>服务</dt><dd>{{ serviceText(draft.fields) }}</dd></div>
              <div><dt>数量</dt><dd>{{ quantityText(draft.fields) }}</dd></div>
              <div><dt>单价</dt><dd>{{ priceText(field(draft, 'unit_price_cents')) }}</dd></div>
              <div><dt>完成状态</dt><dd>{{ completedText(field(draft, 'is_completed')) }}</dd></div>
            </dl>
          </template>
          <template v-else>
            <section class="cb-ai-draft__target">
              <span class="cb-ai-draft__section-label">修改对象</span>
              <strong>{{ before(draft, 'work_order_date') }} · {{ customerText(draft.before) }}</strong>
              <span>{{ serviceText(draft.before) }} · {{ quantityText(draft.before) }} · {{ priceText(before(draft, 'unit_price_cents')) }} · {{ completedText(before(draft, 'is_completed')) }}</span>
              <small>录入时间 {{ createdTime(draft) }}</small>
            </section>
            <section class="cb-ai-draft__changes">
              <span class="cb-ai-draft__section-label">本次修改</span>
              <div v-for="row in changeRows(draft)" :key="row.label" class="cb-ai-draft__change-row">
                <span>{{ row.label }}</span>
                <span>{{ row.oldValue }}</span>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path></svg>
                <strong>{{ row.newValue }}</strong>
              </div>
            </section>
          </template>

          <div class="cb-ai-draft__actions" role="group" :aria-label="`设置第 ${index + 1} 张工单的处理方式`">
            <button type="button" :aria-pressed="decisionFor(draft)?.action === 'approve'" :class="{ 'is-selected': decisionFor(draft)?.action === 'approve' }" @click="setAction(draft, 'approve')">批准</button>
            <button type="button" :aria-pressed="decisionFor(draft)?.action === 'regenerate'" :class="{ 'is-selected': decisionFor(draft)?.action === 'regenerate' }" @click="setAction(draft, 'regenerate')">重新生成</button>
            <button type="button" :aria-pressed="decisionFor(draft)?.action === 'reject'" :class="{ 'is-selected': decisionFor(draft)?.action === 'reject' }" @click="setAction(draft, 'reject')">拒绝</button>
          </div>

          <section v-if="decisionFor(draft)?.action !== 'approve'" class="cb-ai-draft__reason">
            <span class="cb-ai-draft__section-label">{{ decisionFor(draft)?.action === 'regenerate' ? '重新生成原因' : '拒绝原因' }}</span>
            <div class="cb-ai-draft__reason-chips">
              <button
                v-for="reason in decisionFor(draft)?.action === 'regenerate' ? regenerateReasons : rejectReasons"
                :key="reason"
                type="button"
                :class="{ 'is-selected': decisionFor(draft)?.reasonCode === reason }"
                :aria-pressed="decisionFor(draft)?.reasonCode === reason"
                @click="setReason(draft, reason)"
              >{{ reason }}</button>
            </div>
            <label class="cb-ai-draft__note">
              <span>补充说明{{ decisionFor(draft)?.action === 'regenerate' || decisionFor(draft)?.reasonCode === '其他' ? ' *' : '' }}</span>
              <textarea
                :value="decisionFor(draft)?.note"
                rows="3"
                maxlength="300"
                :placeholder="decisionFor(draft)?.action === 'regenerate' ? '说明应如何修改，例如：数量应为 12 件' : '可补充拒绝原因'"
                @input="setNote(draft, ($event.target as HTMLTextAreaElement).value)"
              ></textarea>
            </label>
            <p v-if="!decisionFor(draft)?.reasonCode || ((decisionFor(draft)?.action === 'regenerate' || decisionFor(draft)?.reasonCode === '其他') && !decisionFor(draft)?.note.trim())" class="cb-ai-draft__inline-error" role="alert">
              请完整填写处理原因
            </p>
          </section>
        </article>
      </div>
    </main>

    <footer class="cb-ai-review__footer">
      <div class="cb-ai-review__footer-counts">批准 {{ counts.approve }} · 重生成 {{ counts.regenerate }} · 拒绝 {{ counts.reject }}</div>
      <button
        v-if="!isResumeOnly"
        type="button"
        class="cb-ai-review__submit cb-pressable"
        :disabled="hasInvalidReason || appState.chatBusy.value"
        @click="requestSubmit"
      >提交审核结果</button>
      <button v-else type="button" class="cb-ai-review__submit cb-pressable" :disabled="appState.chatBusy.value" @click="retryResume">重试 AI 回复</button>
    </footer>

    <van-dialog
      v-model:show="confirmOpen"
      title="提交本次审核结果？"
      show-cancel-button
      cancel-button-text="返回核对"
      confirm-button-text="确认提交"
      class="cb-ai-review__dialog"
      @confirm="confirmSubmit"
    >
      <div class="cb-ai-review__dialog-body">
        <div><span>批准并写入</span><strong>{{ counts.approve }} 张</strong></div>
        <div><span>要求 AI 重新生成</span><strong>{{ counts.regenerate }} 张</strong></div>
        <div><span>直接拒绝</span><strong>{{ counts.reject }} 张</strong></div>
      </div>
    </van-dialog>
  </section>
</template>

<style scoped>
.cb-ai-review { position: fixed; inset: 0; z-index: 200; display: flex; flex-direction: column; min-height: 0; background: var(--md-sys-color-surface); color: var(--md-sys-color-on-surface); }
.cb-ai-review__topbar { min-height: 64px; padding: env(safe-area-inset-top, 0) 16px 0; display: grid; grid-template-columns: 48px 1fr 48px; align-items: center; background: var(--md-sys-color-surface); border-bottom: 1px solid var(--md-sys-color-outline-variant); }
.cb-ai-review__icon-button { width: 48px; height: 48px; display: grid; place-items: center; border: 0; border-radius: var(--md-sys-shape-corner-full); color: var(--md-sys-color-on-surface); background: transparent; }
.cb-ai-review__title-group { min-width: 0; text-align: center; }
.cb-ai-review__title-group h2 { margin: 0; font-size: 20px; line-height: 1.25; font-weight: 800; }
.cb-ai-review__title-group span { font-size: 12px; color: var(--md-sys-color-on-surface-variant); }
.cb-ai-review__content { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 16px 16px 120px; }
.cb-ai-review__summary { padding: 16px; border-radius: var(--md-sys-shape-corner-large); background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.cb-ai-review__summary-counts { display: flex; flex-wrap: wrap; gap: 12px 20px; }
.cb-ai-review__summary-counts span { font-size: 14px; }
.cb-ai-review__summary-counts strong { font-size: 20px; font-variant-numeric: tabular-nums; }
.cb-ai-review__summary p { margin: 8px 0 0; font-size: 13px; line-height: 1.5; }
.cb-ai-review__filters { display: flex; gap: 8px; overflow-x: auto; padding: 16px 0 12px; scrollbar-width: none; }
.cb-ai-review__filter-chip, .cb-ai-draft__reason-chips button { min-height: 40px; padding: 0 14px; white-space: nowrap; border: 1px solid var(--md-sys-color-outline); border-radius: var(--md-sys-shape-corner-full); background: var(--md-sys-color-surface); color: var(--md-sys-color-on-surface-variant); font-weight: 700; }
.cb-ai-review__filter-chip.is-selected, .cb-ai-draft__reason-chips button.is-selected { border-color: var(--md-sys-color-secondary-container); background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.cb-ai-review__resume-error { margin-bottom: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; border-radius: var(--md-sys-shape-corner-medium); background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container); }
.cb-ai-review__list { display: flex; flex-direction: column; gap: 12px; }
.cb-ai-draft { overflow: hidden; border: 1px solid var(--md-sys-color-outline-variant); border-radius: var(--md-sys-shape-corner-large); background: var(--md-sys-color-surface-container-low); box-shadow: var(--md-sys-elevation-1); }
.cb-ai-draft--approve { border-color: color-mix(in srgb, var(--md-sys-color-primary) 36%, var(--md-sys-color-outline-variant)); }
.cb-ai-draft--regenerate { border-color: var(--md-sys-color-tertiary); }
.cb-ai-draft--reject { border-color: var(--md-sys-color-error); }
.cb-ai-draft__header { padding: 14px 16px; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--md-sys-color-outline-variant); }
.cb-ai-draft__heading { min-width: 0; display: flex; align-items: center; gap: 12px; }
.cb-ai-draft__index { min-width: 36px; height: 36px; display: grid; place-items: center; border-radius: var(--md-sys-shape-corner-medium); background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); font-weight: 800; font-variant-numeric: tabular-nums; }
.cb-ai-draft__heading h3 { margin: 0; font-size: 17px; }
.cb-ai-draft__heading div > span { display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--md-sys-color-on-surface-variant); }
.cb-ai-draft__status { padding: 5px 10px; border-radius: var(--md-sys-shape-corner-full); background: var(--md-sys-color-surface-container-high); font-size: 12px; font-weight: 800; white-space: nowrap; }
.cb-ai-draft--approve .cb-ai-draft__status { background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); }
.cb-ai-draft--regenerate .cb-ai-draft__status { background: var(--md-sys-color-tertiary-container); color: var(--md-sys-color-on-tertiary-container); }
.cb-ai-draft--reject .cb-ai-draft__status { background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container); }
.cb-ai-draft__details { margin: 0; padding: 14px 16px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
.cb-ai-draft__details div { min-width: 0; }
.cb-ai-draft__details dt, .cb-ai-draft__section-label { font-size: 12px; font-weight: 700; color: var(--md-sys-color-on-surface-variant); }
.cb-ai-draft__details dd { margin: 3px 0 0; overflow-wrap: anywhere; font-size: 15px; font-weight: 750; font-variant-numeric: tabular-nums; }
.cb-ai-draft__target, .cb-ai-draft__changes, .cb-ai-draft__reason { margin: 14px 16px 0; padding: 14px; display: flex; flex-direction: column; gap: 6px; border-radius: var(--md-sys-shape-corner-medium); background: var(--md-sys-color-surface); }
.cb-ai-draft__target strong { font-size: 16px; }
.cb-ai-draft__target > span:not(.cb-ai-draft__section-label), .cb-ai-draft__target small { color: var(--md-sys-color-on-surface-variant); line-height: 1.45; }
.cb-ai-draft__change-row { min-height: 44px; display: grid; grid-template-columns: minmax(56px, .7fr) minmax(0, 1fr) 18px minmax(0, 1fr); align-items: center; gap: 8px; border-top: 1px solid var(--md-sys-color-outline-variant); font-size: 14px; }
.cb-ai-draft__change-row:first-of-type { margin-top: 4px; }
.cb-ai-draft__change-row > span:nth-child(2) { color: var(--md-sys-color-on-surface-variant); text-decoration: line-through; }
.cb-ai-draft__change-row strong { color: var(--md-sys-color-primary); overflow-wrap: anywhere; }
.cb-ai-draft__actions { margin: 14px 16px; padding: 4px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; border-radius: var(--md-sys-shape-corner-full); background: var(--md-sys-color-surface-container-high); }
.cb-ai-draft__actions button { min-height: 48px; padding: 0 8px; border: 0; border-radius: var(--md-sys-shape-corner-full); background: transparent; color: var(--md-sys-color-on-surface-variant); font-size: 13px; font-weight: 800; }
.cb-ai-draft__actions button.is-selected { background: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary); box-shadow: var(--md-sys-elevation-1); }
.cb-ai-draft__actions button:nth-child(2).is-selected { background: var(--md-sys-color-tertiary); color: var(--md-sys-color-on-tertiary); }
.cb-ai-draft__actions button:nth-child(3).is-selected { background: var(--md-sys-color-error); color: var(--md-sys-color-on-error); }
.cb-ai-draft__reason { margin-bottom: 16px; background: var(--md-sys-color-surface-container); }
.cb-ai-draft__reason-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.cb-ai-draft__note { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 700; }
.cb-ai-draft__note textarea { box-sizing: border-box; width: 100%; min-height: 88px; resize: vertical; padding: 12px; border: 1px solid var(--md-sys-color-outline); border-radius: var(--md-sys-shape-corner-small); background: var(--md-sys-color-surface); color: var(--md-sys-color-on-surface); font: inherit; line-height: 1.5; }
.cb-ai-draft__note textarea:focus-visible { outline: 3px solid color-mix(in srgb, var(--md-sys-color-primary) 35%, transparent); outline-offset: 1px; border-color: var(--md-sys-color-primary); }
.cb-ai-draft__inline-error { margin: 0; color: var(--md-sys-color-error); font-size: 12px; font-weight: 700; }
.cb-ai-review__footer { position: absolute; inset-inline: 0; bottom: 0; z-index: 2; padding: 10px 16px calc(10px + env(safe-area-inset-bottom, 0px)); display: flex; align-items: center; gap: 12px; background: color-mix(in srgb, var(--md-sys-color-surface) 94%, transparent); border-top: 1px solid var(--md-sys-color-outline-variant); backdrop-filter: blur(16px); }
.cb-ai-review__footer-counts { min-width: 0; flex: 1; font-size: 12px; color: var(--md-sys-color-on-surface-variant); font-variant-numeric: tabular-nums; }
.cb-ai-review__submit { min-width: 152px; min-height: 48px; padding: 0 20px; border: 0; border-radius: var(--md-sys-shape-corner-full); background: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary); font-size: 14px; font-weight: 800; box-shadow: var(--md-sys-elevation-1); }
.cb-ai-review__submit:disabled { opacity: .38; box-shadow: none; }
.cb-ai-review__dialog-body { padding: 8px 24px 20px; display: flex; flex-direction: column; gap: 10px; }
.cb-ai-review__dialog-body div { display: flex; justify-content: space-between; gap: 16px; }
.cb-ai-review__dialog-body strong { font-variant-numeric: tabular-nums; }
.cb-ai-review__dialog-body p { margin: 4px 0 0; padding: 10px 12px; border-radius: var(--md-sys-shape-corner-small); background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); font-size: 13px; line-height: 1.5; }
@media (min-width: 720px) { .cb-ai-review__content { width: min(760px, 100%); margin: 0 auto; box-sizing: border-box; } .cb-ai-review__footer { padding-inline: max(16px, calc((100% - 728px) / 2)); } }
@media (max-width: 380px) { .cb-ai-draft__details { grid-template-columns: 1fr; } .cb-ai-review__footer { align-items: stretch; flex-direction: column; } .cb-ai-review__submit { width: 100%; } .cb-ai-review__footer-counts { text-align: center; } .cb-ai-review__content { padding-bottom: 150px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; } }
</style>
