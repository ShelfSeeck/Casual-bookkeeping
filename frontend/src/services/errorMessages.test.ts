import { describe, expect, it } from 'vitest'
import { errorMessageMap, toErrorMessage } from './errorMessages'

// 被测缝：errorMessages 错误码中文文案映射（docs/error-codes.md §5）
// 验证：覆盖 §4.2 同步 rejected 与 §4.3 聊天域全部错误码；
// 未命中映射时回退到服务端 message / 原始字符串。
// 为什么测这里：前端所有错误提示都从这里出，映射缺失会直接显示机器码。

describe('errorMessageMap', () => {
  it('覆盖 docs/error-codes.md §4.2 全部业务错误码', () => {
    const codes = [
      'entity_not_found',
      'operation_id_conflict',
      'invalid_quantity',
      'invalid_unit',
      'invalid_unit_price',
      'invalid_service_item',
      'service_item_mismatch',
      'service_option_disabled',
      'customer_not_found',
      'customer_mapping_invalid',
      'invalid_customer_name',
      'mapping_period_overlap',
      'invalid_mapping_period',
      'category_name_duplicate',
      'invalid_subcategories',
      'subcategory_name_duplicate',
    ]
    for (const code of codes) {
      expect(errorMessageMap[code], `${code} 应有中文文案`).toBeTruthy()
    }
  })

  it('覆盖 docs/error-codes.md §4.3 全部聊天域错误码', () => {
    const codes = [
      'session_busy',
      'session_not_found',
      'turn_not_found',
      'invalid_approval',
      'approval_not_found',
      'tool_approval_required',
      'model_config_missing',
      'model_build_failed',
      'model_authentication_error',
      'model_quota_limit_error',
      'model_network_error',
      'model_call_failed',
    ]
    for (const code of codes) {
      expect(errorMessageMap[code], `${code} 应有中文文案`).toBeTruthy()
    }
  })

  it('关键错误码使用 docs/error-codes.md 的示例文案', () => {
    expect(errorMessageMap.invalid_quantity).toBe('数量必须是正整数')
  })
})

describe('toErrorMessage', () => {
  it('已映射错误码返回中文文案（Error 消息为错误码）', () => {
    expect(toErrorMessage(new Error('invalid_quantity'))).toBe('数量必须是正整数')
  })

  it('已映射对象错误码优先于 message', () => {
    expect(toErrorMessage({ error_code: 'model_call_failed', message: 'x' })).toBe('模型调用失败')
    expect(toErrorMessage({ errorCode: 'customer_not_found', message: 'x' })).toBe('客户不存在或已归档')
  })

  it('未映射字符串原样返回（服务端 message 兜底）', () => {
    expect(toErrorMessage('服务器开小差了')).toBe('服务器开小差了')
  })

  it('未映射 Error 返回其 message', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('null/undefined 返回通用兜底文案', () => {
    expect(toErrorMessage(null)).toBe('操作失败，请稍后重试')
    expect(toErrorMessage(undefined)).toBe('操作失败，请稍后重试')
  })
})
