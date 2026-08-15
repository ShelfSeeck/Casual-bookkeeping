<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { prototypeState } from '../../state/prototypeState'

const inputVal = ref('')
const msgContainer = ref<HTMLElement | null>(null)

const quickPrompts = [
  '今日记账汇总',
  '帮我记张老板3000件酵洗',
  '今天一共洗了多少件？',
  '李厂本周有哪些工单？',
]

function send(text: string) {
  if (!text.trim()) return
  prototypeState.sendAiMessage(text.trim())
  inputVal.value = ''
  scrollToBottom()
}

function handleConfirmDraft(draft: NonNullable<typeof prototypeState.chatMessages[0]['suggestedDraft']>) {
  // 确认写入工单
  prototypeState.createWorkOrder({
    customerId: 1, // 张老板
    categoryName: draft.data.category,
    subcategoryName: draft.data.subcategory,
    quantity: draft.data.quantity,
    unit: draft.data.unit,
    unitPriceCents: draft.data.price ? Math.round(draft.data.price * 100) : null,
  })

  prototypeState.chatMessages.push({
    id: `m_confirm_${Date.now()}`,
    sender: 'assistant',
    content: `✅ 已成功写入本地工单：${draft.data.customerName} ${draft.data.quantity}${draft.data.unit} (${draft.data.subcategory})，已落盘并进入离线同步队列！`,
    timestamp: `${new Date().getHours()}:${String(new Date().getMinutes()).padStart(2, '0')}`,
  })
  scrollToBottom()
}

function handleClearHistory() {
  prototypeState.chatMessages.splice(1) // 保留第一条欢迎词
}

function scrollToBottom() {
  nextTick(() => {
    if (msgContainer.value) {
      msgContainer.value.scrollTop = msgContainer.value.scrollHeight
    }
  })
}
</script>

<template>
  <div class="cb-chat-view">
    <!-- M3 Top App Bar -->
    <header class="cb-chat-header">
      <div class="cb-chat-title-group">
        <div class="cb-header-left">
          <div class="cb-ai-badge-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            </svg>
          </div>
          <div>
            <h1 class="cb-chat-title cb-text-balance">AI 记账助手</h1>
            <span class="cb-chat-sub">本地优先 · 智能记账与查账</span>
          </div>
        </div>

        <div class="cb-header-right">
          <span class="cb-chat-status" aria-live="polite">
            <span class="cb-status-live-dot"></span>
            已就绪
          </span>
          <button
            type="button"
            class="cb-clear-btn cb-pressable"
            title="清空对话"
            aria-label="清空对话历史"
            @click="handleClearHistory"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </div>
    </header>

    <!-- M3 Suggestion Chips Toolbar -->
    <div class="cb-prompts-bar" role="toolbar" aria-label="常用快捷指令">
      <div class="cb-prompts-label-row">
        <span class="cb-prompts-label">✨ 推荐快捷指令</span>
      </div>
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

    <!-- 消息对话流 -->
    <main
      ref="msgContainer"
      class="cb-chat-messages"
      role="log"
      aria-live="polite"
      aria-label="对话消息流"
    >
      <div
        v-for="msg in prototypeState.chatMessages"
        :key="msg.id"
        class="cb-message-row"
        :class="`cb-message-row--${msg.sender}`"
      >
        <!-- AI 头像 -->
        <div v-if="msg.sender === 'assistant'" class="cb-avatar cb-avatar--ai" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3l1.912 5.885h6.188l-5.006 3.638 1.912 5.885-5.006-3.638-5.006 3.638 1.912-5.885-5.006-3.638h6.188z"/>
          </svg>
        </div>

        <div class="cb-message-bubble">
          <div class="cb-message-content">{{ msg.content }}</div>

          <!-- M3 结构化草案确认卡 (Elevated Card) -->
          <div v-if="msg.suggestedDraft" class="cb-draft-card" role="region" aria-label="工单草案核对卡">
            <div class="cb-draft-header">
              <span class="cb-draft-tag">📋 工单草案待确认</span>
              <span class="cb-draft-notice">请核对后确认落盘</span>
            </div>

            <div class="cb-draft-body cb-tabular-nums">
              <div class="cb-draft-item">
                <span class="cb-draft-label">客户</span>
                <span class="cb-draft-val cb-draft-val--cust">{{ msg.suggestedDraft.data.customerName }}</span>
              </div>
              <div class="cb-draft-item">
                <span class="cb-draft-label">服务项目</span>
                <span class="cb-draft-val">{{ msg.suggestedDraft.data.category }} · {{ msg.suggestedDraft.data.subcategory }}</span>
              </div>
              <div class="cb-draft-item">
                <span class="cb-draft-label">数量</span>
                <span class="cb-draft-val-strong">{{ msg.suggestedDraft.data.quantity.toLocaleString() }} {{ msg.suggestedDraft.data.unit }}</span>
              </div>
              <div class="cb-draft-item">
                <span class="cb-draft-label">单价</span>
                <span class="cb-draft-val">
                  {{ msg.suggestedDraft.data.price ? `¥${msg.suggestedDraft.data.price.toFixed(2)} / ${msg.suggestedDraft.data.unit}` : '待定价' }}
                </span>
              </div>
            </div>

            <div class="cb-draft-actions">
              <button
                type="button"
                class="cb-draft-confirm-btn cb-pressable"
                aria-label="确认写入本地账本"
                @click="handleConfirmDraft(msg.suggestedDraft!)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                <span>确认写入本地工单</span>
              </button>
            </div>
          </div>

          <span class="cb-message-time">{{ msg.timestamp }}</span>
        </div>
      </div>
    </main>

    <!-- M3 底部输入 Dock -->
    <footer class="cb-chat-input-bar">
      <input
        v-model="inputVal"
        type="text"
        placeholder="输入记账或查询指令，例如：记李厂500件酵洗…"
        class="cb-chat-input"
        autocomplete="off"
        spellcheck="false"
        aria-label="输入记账或查询指令"
        @keyup.enter="send(inputVal)"
      />
      <button
        type="button"
        class="cb-chat-send-btn cb-pressable"
        aria-label="发送消息"
        :disabled="!inputVal.trim()"
        @click="send(inputVal)"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
        <span>发送</span>
      </button>
    </footer>
  </div>
</template>

<style scoped>
.cb-chat-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  padding-bottom: var(--cb-tabbar-height);
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

.cb-ai-badge-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: var(--md-sys-elevation-1);
}

.cb-chat-title {
  margin: 0;
  font-size: 19px;
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

.cb-clear-btn {
  width: 36px;
  height: 36px;
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
.cb-clear-btn:hover {
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-error);
}

/* ==========================================================================
   2. M3 Suggestion Chips Toolbar
   ========================================================================== */
.cb-prompts-bar {
  background: var(--md-sys-color-surface);
  padding: 8px 16px 10px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cb-prompts-label-row {
  display: flex;
  align-items: center;
}

.cb-prompts-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--md-sys-color-outline);
}

.cb-prompts-scroll {
  display: flex;
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
   4. Draft Verification Card (M3 Elevated Card)
   ========================================================================== */
.cb-draft-card {
  margin-top: 12px;
  background: var(--md-sys-color-surface-container-low);
  border: none;
  box-shadow: var(--md-sys-elevation-1);
  border-radius: var(--md-sys-shape-corner-medium);
  padding: 14px 16px;
}

.cb-draft-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.cb-draft-tag {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  font-size: 12px;
  font-weight: 800;
  padding: 3px 8px;
  border-radius: var(--md-sys-shape-corner-extra-small);
}

.cb-draft-notice {
  font-size: 11px;
  color: var(--md-sys-color-outline);
}

.cb-draft-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
  margin-bottom: 14px;
  background: var(--md-sys-color-surface);
  padding: 10px 12px;
  border-radius: var(--md-sys-shape-corner-small);
}

.cb-draft-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cb-draft-label {
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
  font-weight: 500;
}

.cb-draft-val {
  font-family: var(--cb-font-numeric);
  font-size: 14px;
  font-weight: 700;
  color: var(--md-sys-color-on-surface);
}

.cb-draft-val--cust {
  font-family: inherit;
  color: var(--md-sys-color-primary);
  font-weight: 800;
}

.cb-draft-val-strong {
  font-family: var(--cb-font-numeric);
  font-size: 17px;
  font-weight: 800;
  color: var(--md-sys-color-on-surface);
}

.cb-draft-actions {
  display: flex;
}

.cb-draft-confirm-btn {
  width: 100%;
  height: 44px;
  background: #059669;
  color: #ffffff;
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  font-size: 14px;
  font-weight: 800;
  box-shadow: var(--md-sys-elevation-1);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}
.cb-draft-confirm-btn:hover {
  background: #047857;
  box-shadow: var(--md-sys-elevation-2);
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
  font-size: 15px;
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
</style>
