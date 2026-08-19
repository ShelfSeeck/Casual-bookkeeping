<script setup lang="ts">
import { computed, ref, nextTick, watch } from 'vue'
import { appState } from '../../state/appState'
import { formatChatTime } from '../../utils/chatTime'
import AiDraftReview from './AiDraftReview.vue'

const inputVal = ref('')
const msgContainer = ref<HTMLElement | null>(null)
const historyPanelOpen = ref(false)
const historyLoading = ref(false)
const openingSessionId = ref<string | null>(null)
const reviewOpen = ref(false)

const approvalCounts = computed(() => {
  const drafts = appState.pendingApproval.value?.drafts ?? []
  return {
    total: drafts.length,
    creates: drafts.filter((draft) => draft.kind === 'create').length,
    updates: drafts.filter((draft) => draft.kind === 'update').length,
  }
})

const quickPrompts = [
  '今日工单汇总',
  '今天一共录了多少单？',
  '有哪些工单还没定价？',
  '本周工单汇总',
]

function isHistoryLocked() {
  return appState.chatBusy.value || appState.pendingApproval.value !== null
}

function saveCurrentDraft() {
  appState.saveChatDraft(appState.currentChatSessionId, inputVal.value)
}

function restoreDraft(sessionId: string | null) {
  inputVal.value = appState.getChatDraft(sessionId)
}

function clearCurrentDraftAfterSend() {
  appState.saveChatDraft(appState.currentChatSessionId, '')
}

async function send(text: string) {
  if (!text.trim() || appState.chatBusy.value || appState.pendingApproval.value) return
  inputVal.value = ''
  await appState.sendAiMessage(text.trim())
  clearCurrentDraftAfterSend()
  scrollToBottom()
}


async function openHistoryPanel() {
  historyPanelOpen.value = true
  historyLoading.value = true
  try {
    await appState.loadChatSessions()
    const latest = appState.chatSessions[0]
    if (!appState.currentChatSessionId && !appState.isNewChat.value && latest && !isHistoryLocked()) {
      saveCurrentDraft()
      await appState.openChatSession(latest.sessionId)
      restoreDraft(latest.sessionId)
    }
  } finally {
    historyLoading.value = false
  }
}

async function selectSession(sessionId: string) {
  if (isHistoryLocked()) return
  saveCurrentDraft()
  openingSessionId.value = sessionId
  try {
    await appState.openChatSession(sessionId)
    if (appState.currentChatSessionId === sessionId) {
      restoreDraft(sessionId)
      historyPanelOpen.value = false
    }
  } finally {
    openingSessionId.value = null
  }
}

function handleNewChat() {
  if (isHistoryLocked()) return
  saveCurrentDraft()
  appState.startNewChat()
  inputVal.value = ''
  historyPanelOpen.value = false
}

function scrollToBottom() {
  nextTick(() => {
    if (msgContainer.value) {
      msgContainer.value.scrollTop = msgContainer.value.scrollHeight
    }
  })
}

watch(
  () => appState.chatMessages.map((m) => m.content).join(''),
  () => scrollToBottom(),
)
</script>

<template>
  <div class="cb-chat-view">
    <AiDraftReview
      v-if="reviewOpen && appState.pendingApproval.value"
      @back="reviewOpen = false"
    />
    <!-- M3 Top App Bar -->
    <header class="cb-chat-header">
      <div class="cb-chat-title-group">
        <div class="cb-header-left">
          <div>
            <h1 class="cb-chat-title cb-text-balance">AI 记账助手</h1>
            <span class="cb-chat-sub">仅联网可用</span>
          </div>
        </div>

        <div class="cb-header-right">
          <span class="cb-chat-status" aria-live="polite">
            <span class="cb-status-live-dot"></span>
            已就绪
          </span>
          <button
            type="button"
            class="cb-history-btn cb-pressable"
            title="历史会话"
            aria-label="打开历史会话"
            @click="openHistoryPanel"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <polyline points="12 7 12 12 15 14"></polyline>
            </svg>
          </button>
        </div>
      </div>
    </header>

    <!-- 消息对话流 -->
    <main
      ref="msgContainer"
      class="cb-chat-messages"
      role="log"
      aria-live="polite"
      aria-label="对话消息流"
    >
      <div
        v-for="msg in appState.chatMessages"
        :key="msg.id"
        class="cb-message-row"
        :class="`cb-message-row--${msg.sender}`"
      >
        <!-- AI 头像 -->
        <div v-if="msg.sender === 'assistant'" class="cb-avatar cb-avatar--ai" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 8V4H8"></path>
            <rect x="4" y="8" width="16" height="12" rx="2"></rect>
            <path d="M2 14h2"></path>
            <path d="M20 14h2"></path>
            <path d="M15 13v2"></path>
            <path d="M9 13v2"></path>
          </svg>
        </div>

        <div class="cb-message-bubble">
          <div class="cb-message-content">{{ msg.content }}</div>

          <!-- 已处理工单草案历史结果卡片（纯前端沉淀） -->
          <div v-if="msg.draftResult" class="cb-processed-drafts" aria-label="已处理工单草案记录">
            <div class="cb-processed-drafts__header">
              <div class="cb-processed-drafts__title">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <path d="M14 2v6h6"></path><path d="m9 15 2 2 4-4"></path>
                </svg>
                <span>已处理工单 ({{ msg.draftResult.total }} 张)</span>
              </div>
              <div class="cb-processed-drafts__tags">
                <span v-if="msg.draftResult.approvedCount > 0" class="cb-tag cb-tag--approved">
                  入库 {{ msg.draftResult.approvedCount }}
                </span>
                <span v-if="msg.draftResult.regeneratedCount > 0" class="cb-tag cb-tag--regenerated">
                  重生成 {{ msg.draftResult.regeneratedCount }}
                </span>
                <span v-if="msg.draftResult.rejectedCount > 0" class="cb-tag cb-tag--rejected">
                  拒绝 {{ msg.draftResult.rejectedCount }}
                </span>
              </div>
            </div>

            <div class="cb-processed-drafts__list">
              <div
                v-for="(item, itemIdx) in msg.draftResult.items"
                :key="itemIdx"
                class="cb-processed-item"
                :class="`cb-processed-item--${item.decision}`"
              >
                <div class="cb-processed-item__main">
                  <div class="cb-processed-item__headline">
                    <span class="cb-processed-item__kind">{{ item.kind === 'create' ? '新建' : '修改' }}</span>
                    <strong class="cb-processed-item__customer">{{ item.customerText }}</strong>
                    <span class="cb-processed-item__service">{{ item.serviceText }}</span>
                  </div>
                  <div class="cb-processed-item__meta">
                    <span class="cb-processed-item__qty">{{ item.quantityText }}</span>
                    <span class="cb-processed-item__price" :class="{ 'cb-text-muted': !item.priceText || item.priceText === '未定价' }">
                      {{ item.priceText && item.priceText !== '未定价' ? item.priceText : '待定价' }}
                    </span>
                    <span v-if="item.statusText" class="cb-processed-item__status">{{ item.statusText }}</span>
                  </div>
                  <div v-if="item.reason" class="cb-processed-item__reason">
                    反馈：{{ item.reason }}
                  </div>
                </div>
                <div class="cb-processed-item__badge" :class="`cb-processed-item__badge--${item.decision}`">
                  {{ item.decisionText }}
                </div>
              </div>
            </div>
          </div>

          <span class="cb-message-time">{{ msg.timestamp }}</span>
        </div>
      </div>

      <!-- AI 批量草案入口：完整审核在独立全屏页完成 -->
      <article
        v-if="appState.pendingApproval.value"
        class="cb-approval-entry"
        aria-label="AI 工单草案等待审核"
      >
        <div class="cb-approval-entry__icon" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <path d="M14 2v6h6"></path><path d="M8 13h8"></path><path d="M8 17h5"></path>
          </svg>
        </div>
        <div class="cb-approval-entry__body">
          <span class="cb-approval-entry__eyebrow">AI 工单草案</span>
          <h2>{{ appState.pendingApproval.value.resumeError ? '工单已保存，AI 回复待重试' : `已生成 ${approvalCounts.total} 张工单` }}</h2>
          <p v-if="!appState.pendingApproval.value.resumeError">
            新建 {{ approvalCounts.creates }} 张 · 修改 {{ approvalCounts.updates }} 张
          </p>
          <p v-else>本地写入不会重复执行，可以安全重试对话续接。</p>
        </div>
        <button type="button" class="cb-approval-entry__button cb-pressable" @click="reviewOpen = true">
          {{ appState.pendingApproval.value.resumeError ? '查看并重试' : '查看并处理' }}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
        </button>
      </article>
    </main>

    <!-- M3 Suggestion Chips Toolbar：放在消息区下方，靠近输入框 -->
    <div class="cb-prompts-bar" role="toolbar" aria-label="常用快捷指令">
      <div class="cb-prompts-scroll">
        <button
          v-for="p in quickPrompts"
          :key="p"
          type="button"
          class="cb-prompt-chip cb-pressable"
          :aria-label="`执行快捷指令：${p}`"
          @click="send(p)"
        >
          <span>{{ p }}</span>
        </button>
      </div>
    </div>

    <!-- M3 底部输入 Dock -->
    <footer class="cb-chat-input-bar">
      <input
        v-model="inputVal"
        type="text"
        placeholder="输入记账或查询指令，例如：今天一共录了多少单？"
        class="cb-chat-input"
        autocomplete="off"
        spellcheck="false"
        aria-label="输入记账或查询指令"
        :disabled="appState.chatBusy.value || appState.pendingApproval.value !== null"
        @keyup.enter="send(inputVal)"
      />
      <button
        type="button"
        class="cb-chat-send-btn cb-pressable"
        aria-label="发送消息"
        :disabled="appState.chatBusy.value || appState.pendingApproval.value !== null || !inputVal.trim()"
        @click="send(inputVal)"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
        <span>发送</span>
      </button>
    </footer>

    <!-- 历史会话底部弹出面板 -->
    <van-popup
      v-model:show="historyPanelOpen"
      position="bottom"
      round
      class="cb-history-popup"
    >
      <div class="cb-history-panel">
        <div class="cb-history-header">
          <span class="cb-history-title">历史会话</span>
          <button
            type="button"
            class="cb-new-chat-btn cb-pressable"
            :disabled="isHistoryLocked()"
            @click="handleNewChat"
          >
            新建对话
          </button>
        </div>

        <div v-if="isHistoryLocked()" class="cb-history-busy-hint">
          AI 回复中/有待确认草案，先处理完再切换
        </div>

        <div v-if="historyLoading" class="cb-history-loading">加载中…</div>
        <div v-else-if="appState.chatSessions.length === 0" class="cb-history-empty">
          <span>暂无历史会话</span>
          <button
            type="button"
            class="cb-empty-new-btn cb-pressable"
            :disabled="isHistoryLocked()"
            @click="handleNewChat"
          >
            开始新对话
          </button>
        </div>
        <div v-else class="cb-history-list">
          <button
            v-for="s in appState.chatSessions"
            :key="s.sessionId"
            type="button"
            class="cb-history-item cb-pressable"
            :class="{ 'cb-history-item--active': s.sessionId === appState.currentChatSessionId }"
            :disabled="isHistoryLocked() || openingSessionId !== null"
            @click="selectSession(s.sessionId)"
          >
            <span class="cb-history-item-main">
              <span class="cb-history-item-title">{{ s.title }}</span>
              <span class="cb-history-item-meta">{{ formatChatTime(s.updatedAt) }} · {{ s.turnCount }} 条对话</span>
            </span>
            <svg
              v-if="s.sessionId === appState.currentChatSessionId"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.cb-chat-view {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  padding-bottom: calc(var(--cb-tabbar-height) + env(safe-area-inset-bottom, 0px));
  box-sizing: border-box;
  background: var(--md-sys-color-surface-dim);
}

/* ==========================================================================
   1. M3 Top App Bar
   ========================================================================== */
.cb-chat-header {
  padding: calc(14px + env(safe-area-inset-top, 0px)) 16px 12px;
  background: var(--md-sys-color-surface);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.cb-chat-title-group {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.cb-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.cb-chat-title {
  margin: 0;
  font-family: var(--cb-font-numeric);
  font-size: 36px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  letter-spacing: -0.3px;
  line-height: 1.2;
}

.cb-chat-sub {
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
}

.cb-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cb-chat-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: var(--cb-status-success-bg);
  color: var(--cb-status-success-text);
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 12px;
  font-weight: 700;
}

.cb-status-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--cb-status-success-text);
}

.cb-history-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--md-sys-color-surface-container);
  border: none;
  border-radius: var(--md-sys-shape-corner-small);
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-history-btn:hover {
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-primary);
}

/* ==========================================================================
   2. M3 Suggestion Chips Toolbar（消息区下方，贴近输入框）
   ========================================================================== */
.cb-prompts-bar {
  background: var(--md-sys-color-surface);
  padding: 8px 16px 10px;
  border-top: 1px solid var(--md-sys-color-outline-variant);
  display: flex;
}

.cb-prompts-scroll {
  display: flex;
  flex: 1;
  min-width: 0;
  gap: 8px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 2px 0;
}
.cb-prompts-scroll::-webkit-scrollbar {
  display: none;
}

.cb-prompt-chip {
  min-height: 38px;
  padding: 0 14px;
  background: var(--md-sys-color-surface-container);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: 13px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
  white-space: nowrap;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  box-shadow: var(--md-sys-elevation-1);
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-prompt-chip:hover {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  box-shadow: var(--md-sys-elevation-2);
}

/* ==========================================================================
   3. Message Stream
   ========================================================================== */
.cb-chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.cb-message-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.cb-message-row--user {
  justify-content: flex-end;
}

.cb-message-row--assistant {
  justify-content: flex-start;
}

.cb-avatar--ai {
  width: 34px;
  height: 34px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: var(--md-sys-elevation-1);
  margin-top: 2px;
}

.cb-message-bubble {
  max-width: 86%;
  padding: 14px 18px;
  border-radius: var(--md-sys-shape-corner-large);
  font-size: 15px;
  line-height: 1.55;
  position: relative;
  word-break: break-word;
}

.cb-message-row--user .cb-message-bubble {
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  border-bottom-right-radius: 4px;
  box-shadow: var(--md-sys-elevation-1);
}

.cb-message-row--assistant .cb-message-bubble {
  background: var(--md-sys-color-surface);
  box-shadow: var(--md-sys-elevation-1);
  color: var(--md-sys-color-on-surface);
  border-bottom-left-radius: 4px;
}

.cb-message-content {
  white-space: pre-wrap;
}

.cb-message-time {
  display: block;
  font-size: 11px;
  margin-top: 6px;
  opacity: 0.7;
  text-align: right;
}

/* ==========================================================================
   3.5. Processed Drafts Result Card (Message Flow)
   ========================================================================== */
.cb-processed-drafts {
  margin-top: 10px;
  padding: 12px;
  background: var(--md-sys-color-surface-container-low);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cb-processed-drafts__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--md-sys-color-outline-variant);
}

.cb-processed-drafts__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--md-sys-color-primary);
}

.cb-processed-drafts__tags {
  display: flex;
  gap: 4px;
}

.cb-tag {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.2;
}
.cb-tag--approved {
  background: rgba(34, 197, 94, 0.15);
  color: #16a34a;
}
.cb-tag--regenerated {
  background: rgba(245, 158, 11, 0.15);
  color: #d97706;
}
.cb-tag--rejected {
  background: rgba(100, 116, 139, 0.15);
  color: #64748b;
}

.cb-processed-drafts__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cb-processed-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: var(--md-sys-color-surface);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
}

.cb-processed-item__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.cb-processed-item__headline {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.cb-processed-item__kind {
  padding: 1px 4px;
  background: var(--md-sys-color-surface-container-high);
  border-radius: 3px;
  font-size: 10px;
  color: var(--md-sys-color-on-surface-variant);
}

.cb-processed-item__customer {
  color: var(--md-sys-color-on-surface);
  font-weight: 700;
}

.cb-processed-item__service {
  color: var(--md-sys-color-on-surface-variant);
  font-size: 12px;
}

.cb-processed-item__meta {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
}

.cb-processed-item__qty {
  font-weight: 600;
}

.cb-processed-item__price {
  color: var(--md-sys-color-primary);
  font-weight: 700;
}

.cb-processed-item__reason {
  font-size: 11px;
  color: #d97706;
  background: rgba(245, 158, 11, 0.08);
  padding: 2px 6px;
  border-radius: 3px;
  margin-top: 2px;
}

.cb-processed-item__badge {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.cb-processed-item__badge--approve {
  background: rgba(34, 197, 94, 0.15);
  color: #16a34a;
}
.cb-processed-item__badge--regenerate {
  background: rgba(245, 158, 11, 0.15);
  color: #d97706;
}
.cb-processed-item__badge--reject {
  background: rgba(100, 116, 139, 0.15);
  color: #64748b;
}

/* ==========================================================================
   4. AI draft review entry
   ========================================================================== */
.cb-approval-entry {
  margin: 4px 16px 16px;
  padding: 16px;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  gap: 12px;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
  color: var(--md-sys-color-on-surface);
  box-shadow: var(--md-sys-elevation-1);
}
.cb-approval-entry__icon {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}
.cb-approval-entry__body { min-width: 0; }
.cb-approval-entry__eyebrow { font-size: 12px; font-weight: 800; color: var(--md-sys-color-primary); }
.cb-approval-entry__body h2 { margin: 3px 0 0; font-size: 17px; line-height: 1.35; }
.cb-approval-entry__body p { margin: 5px 0 0; font-size: 13px; line-height: 1.45; color: var(--md-sys-color-on-surface-variant); }
.cb-approval-entry__button {
  grid-column: 1 / -1;
  min-height: 48px;
  padding: 0 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  font-size: 14px;
  font-weight: 800;
  box-shadow: var(--md-sys-elevation-1);
}

/* ==========================================================================
   5. M3 Bottom Input Dock
   ========================================================================== */
.cb-chat-input-bar {
  background: var(--md-sys-color-surface);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  padding: 12px 16px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.cb-chat-input {
  flex: 1;
  height: 48px;
  background: var(--md-sys-color-surface-container-low);
  border: 1.5px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  padding: 0 16px;
  font-size: 16px;
  color: var(--md-sys-color-on-surface);
  outline: none;
  transition: border-color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard),
              box-shadow var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-chat-input:focus {
  border-color: var(--md-sys-color-primary);
  box-shadow: 0 0 0 3px var(--md-sys-color-primary-container);
}

.cb-chat-send-btn {
  height: 48px;
  min-width: 80px;
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  padding: 0 16px;
  font-size: 15px;
  font-weight: 800;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-shadow: var(--md-sys-elevation-2);
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-chat-send-btn:hover:not(:disabled) {
  background: var(--cb-accent-hover);
  box-shadow: var(--md-sys-elevation-3);
}

.cb-chat-send-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  box-shadow: none;
}

/* ==========================================================================
   6. History Session Bottom Sheet
   ========================================================================== */
.cb-history-popup {
  --van-popup-round-radius: var(--md-sys-shape-corner-extra-large);
  height: 50%;
  background: var(--md-sys-color-surface);
  border-radius: var(--md-sys-shape-corner-extra-large) var(--md-sys-shape-corner-extra-large) 0 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.cb-history-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px 16px 0;
  box-sizing: border-box;
}

.cb-history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.cb-history-title {
  font-size: 16px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
  letter-spacing: -0.2px;
}

.cb-new-chat-btn,
.cb-empty-new-btn {
  height: 36px;
  padding: 0 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  border: none;
  border-radius: var(--md-sys-shape-corner-full);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: var(--md-sys-elevation-1);
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-new-chat-btn:disabled,
.cb-empty-new-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  box-shadow: none;
}

.cb-history-busy-hint {
  padding: 8px 12px;
  margin-bottom: 8px;
  background: var(--md-sys-color-surface-container);
  color: var(--md-sys-color-on-surface-variant);
  border-radius: var(--md-sys-shape-corner-small);
  font-size: 12px;
  line-height: 1.4;
}

.cb-history-loading {
  padding: 24px 0;
  text-align: center;
  font-size: 14px;
  color: var(--md-sys-color-on-surface-variant);
}

.cb-history-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
  color: var(--md-sys-color-on-surface-variant);
  font-size: 14px;
}

.cb-history-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
}

.cb-history-item {
  width: 100%;
  min-height: 56px;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: var(--md-sys-color-surface-container-low);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  color: var(--md-sys-color-on-surface);
  text-align: left;
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-history-item:hover:not(:disabled) {
  background: var(--md-sys-color-surface-container-high);
}

.cb-history-item--active,
.cb-history-item--active:hover {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
}

.cb-history-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.cb-history-item-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cb-history-item-title {
  font-size: 14px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cb-history-item-meta {
  font-size: 12px;
  opacity: 0.8;
}
</style>
