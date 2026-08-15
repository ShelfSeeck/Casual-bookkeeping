<script setup lang="ts">
const props = defineProps<{
  modelValue: string
  title?: string
  unit?: string
  allowDecimal?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', val: string): void
  (e: 'confirm', val: string): void
  (e: 'close'): void
}>()

function handleKey(key: string) {
  let cur = props.modelValue || ''

  if (key === 'backspace') {
    emit('update:modelValue', cur.slice(0, -1))
    return
  }
  if (key === 'clear') {
    emit('update:modelValue', '')
    return
  }
  if (key === '.') {
    if (!props.allowDecimal) return
    if (cur.includes('.')) return
    if (cur === '') cur = '0'
    emit('update:modelValue', cur + '.')
    return
  }

  // 数字输入限制
  if (cur === '0' && key !== '.') {
    cur = ''
  }
  if (props.allowDecimal && cur.includes('.')) {
    const parts = cur.split('.')
    if (parts[1] && parts[1].length >= 2) {
      return // 最多两位小数
    }
  }

  emit('update:modelValue', cur + key)
}

function handleConfirm() {
  emit('confirm', props.modelValue)
}
</script>

<template>
  <div class="cb-keypad-sheet" role="dialog" aria-modal="true" :aria-label="title || '数字键盘'">
    <div class="cb-keypad-header">
      <div class="cb-keypad-title">{{ title || '输入数值' }}</div>
      <button
        class="cb-keypad-close cb-pressable"
        aria-label="关闭数字键盘"
        @click="emit('close')"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <!-- 数值回显大字框 -->
    <div class="cb-keypad-display" aria-live="polite">
      <span class="cb-display-value cb-tabular-nums">
        {{ modelValue || '0' }}
      </span>
      <span v-if="unit" class="cb-display-unit">{{ unit }}</span>
    </div>

    <!-- 4x4 大按键网格 -->
    <div class="cb-keypad-grid" role="group" aria-label="数字键区">
      <button class="cb-key-btn cb-pressable" aria-label="1" @click="handleKey('1')">1</button>
      <button class="cb-key-btn cb-pressable" aria-label="2" @click="handleKey('2')">2</button>
      <button class="cb-key-btn cb-pressable" aria-label="3" @click="handleKey('3')">3</button>
      <button class="cb-key-btn cb-key-op cb-pressable" aria-label="退格删除" @click="handleKey('backspace')">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"></path>
          <line x1="18" y1="9" x2="12" y2="15"></line>
          <line x1="12" y1="9" x2="18" y2="15"></line>
        </svg>
      </button>

      <button class="cb-key-btn cb-pressable" aria-label="4" @click="handleKey('4')">4</button>
      <button class="cb-key-btn cb-pressable" aria-label="5" @click="handleKey('5')">5</button>
      <button class="cb-key-btn cb-pressable" aria-label="6" @click="handleKey('6')">6</button>
      <button class="cb-key-btn cb-key-op cb-pressable" aria-label="清空输入" @click="handleKey('clear')">C</button>

      <button class="cb-key-btn cb-pressable" aria-label="7" @click="handleKey('7')">7</button>
      <button class="cb-key-btn cb-pressable" aria-label="8" @click="handleKey('8')">8</button>
      <button class="cb-key-btn cb-pressable" aria-label="9" @click="handleKey('9')">9</button>
      <button
        class="cb-key-btn cb-key-confirm cb-pressable"
        style="grid-row: span 2;"
        aria-label="确认输入"
        @click="handleConfirm"
      >
        确定
      </button>

      <button
        class="cb-key-btn cb-pressable"
        :class="{ 'cb-key-disabled': !allowDecimal }"
        :aria-disabled="!allowDecimal"
        aria-label="小数点"
        @click="handleKey('.')"
      >
        .
      </button>
      <button class="cb-key-btn cb-pressable" style="grid-column: span 2;" aria-label="0" @click="handleKey('0')">0</button>
    </div>
  </div>
</template>

<style scoped>
.cb-keypad-sheet {
  background: var(--cb-surface);
  border-top: 1px solid var(--cb-border);
  padding: 16px 16px calc(16px + env(safe-area-inset-bottom, 0));
  border-radius: var(--cb-radius-lg) var(--cb-radius-lg) 0 0;
  box-shadow: var(--cb-shadow-sheet);
}

.cb-keypad-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.cb-keypad-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--cb-text-main);
}

.cb-keypad-close {
  background: none;
  border: none;
  color: var(--cb-text-muted);
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.cb-keypad-display {
  background: var(--cb-surface-subtle);
  border: 1.5px solid var(--cb-border);
  border-radius: var(--cb-radius-md);
  padding: 12px 16px;
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 6px;
  margin-bottom: 16px;
}

.cb-display-value {
  font-size: 32px;
  font-weight: 700;
  color: var(--cb-text-main);
  letter-spacing: -0.5px;
}

.cb-display-unit {
  font-size: 16px;
  font-weight: 600;
  color: var(--cb-text-sub);
}

.cb-keypad-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.cb-key-btn {
  height: 54px;
  background: var(--cb-surface);
  border: 1px solid var(--cb-border);
  border-radius: var(--cb-radius-md);
  font-size: 22px;
  font-weight: 600;
  color: var(--cb-text-main);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  cursor: pointer;
}

.cb-key-op {
  background: var(--cb-surface-subtle);
  color: var(--cb-text-sub);
  font-size: 18px;
}

.cb-key-confirm {
  background: var(--cb-accent);
  color: var(--cb-text-inverse);
  border: none;
  font-size: 17px;
  font-weight: 600;
  height: auto;
  box-shadow: 0 2px 6px rgba(37, 99, 235, 0.3);
}

.cb-key-disabled {
  opacity: 0.3;
  pointer-events: none;
}
</style>
