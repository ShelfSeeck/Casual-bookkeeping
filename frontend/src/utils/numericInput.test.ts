import { describe, expect, it } from 'vitest'
import {
  isAllowedDecimalKey,
  isAllowedIntegerKey,
  isPositiveIntegerInput,
  isValidDecimalInput,
  sanitizeDecimalInput,
  sanitizeIntegerInput,
} from './numericInput'

function keyEvent(
  key: string,
  targetValue = '',
  extra: Partial<KeyboardEvent> = {},
): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: { value: targetValue },
    ...extra,
  } as KeyboardEvent
}

describe('isAllowedIntegerKey（数量 keydown 拦截）', () => {
  it('数字键放行，字母/符号键拦截', () => {
    expect(isAllowedIntegerKey(keyEvent('5'))).toBe(true)
    expect(isAllowedIntegerKey(keyEvent('a'))).toBe(false)
    expect(isAllowedIntegerKey(keyEvent('.'))).toBe(false)
  })

  it('编辑/导航控制键与组合键放行', () => {
    expect(isAllowedIntegerKey(keyEvent('Backspace'))).toBe(true)
    expect(isAllowedIntegerKey(keyEvent('ArrowLeft'))).toBe(true)
    const ctrlA = keyEvent('a', '', { ctrlKey: true })
    expect(isAllowedIntegerKey(ctrlA)).toBe(true)
  })
})

describe('isAllowedDecimalKey（单价 keydown 拦截）', () => {
  it('数字键放行，字母键拦截', () => {
    expect(isAllowedDecimalKey(keyEvent('7'))).toBe(true)
    expect(isAllowedDecimalKey(keyEvent('a'))).toBe(false)
  })

  it('小数点：当前没有小数点时放行，已有小数点时拦截', () => {
    expect(isAllowedDecimalKey(keyEvent('.'))).toBe(true)
    expect(isAllowedDecimalKey(keyEvent('.', '12.'))).toBe(false)
  })
})

describe('sanitizeIntegerInput（数量输入即时过滤）', () => {
  it('只保留数字字符，去掉字母和符号', () => {
    expect(sanitizeIntegerInput('12a3.4')).toBe('1234')
    expect(sanitizeIntegerInput('-12')).toBe('12')
    expect(sanitizeIntegerInput('abc')).toBe('')
  })

  it('空串合法，不清洗已有数字', () => {
    expect(sanitizeIntegerInput('')).toBe('')
    expect(sanitizeIntegerInput('0123')).toBe('0123')
  })
})

describe('sanitizeDecimalInput（单价输入即时过滤）', () => {
  it('只保留数字和一个小数点', () => {
    expect(sanitizeDecimalInput('12.3.4')).toBe('12.34')
    expect(sanitizeDecimalInput('1a2b')).toBe('12')
    expect(sanitizeDecimalInput('¥12.5')).toBe('12.5')
  })

  it('空串合法', () => {
    expect(sanitizeDecimalInput('')).toBe('')
  })
})

describe('合法性判断（提交前兜底）', () => {
  it('正整数：非空且大于 0', () => {
    expect(isPositiveIntegerInput('3')).toBe(true)
    expect(isPositiveIntegerInput('0')).toBe(false)
    expect(isPositiveIntegerInput('-1')).toBe(false)
    expect(isPositiveIntegerInput('')).toBe(false)
  })

  it('单价：空串或非负小数合法', () => {
    expect(isValidDecimalInput('')).toBe(true)
    expect(isValidDecimalInput('0')).toBe(true)
    expect(isValidDecimalInput('12.50')).toBe(true)
    expect(isValidDecimalInput('12.5.0')).toBe(false)
    expect(isValidDecimalInput('abc')).toBe(false)
  })
})
