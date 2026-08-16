// 前端错误码 → 中文文案映射（docs/error-codes.md §5）。
// 服务端 message 只作调试/日志兜底；前端展示一律先查本表。
// 覆盖 docs/error-codes.md §4.2（同步 rejected 业务校验）与 §4.3（聊天域）。

export const errorMessageMap: Record<string, string> = {
  // §4.2 通用
  entity_not_found: '目标记录不存在或已删除',
  operation_id_conflict: '操作 ID 已被不同内容占用',

  // §4.2 工单
  invalid_quantity: '数量必须是正整数',
  invalid_unit: '单位不能为空',
  invalid_unit_price: '单价不能为负',
  invalid_service_item: '小类必须是字符串或空值',
  service_item_mismatch: '小类不属于所选大类',
  service_option_disabled: '服务大类或小类已停用',
  customer_not_found: '客户不存在或已归档',
  customer_mapping_invalid: '该业务日期无有效客户编号映射',

  // §4.2 客户
  invalid_customer_name: '客户名称不能为空',

  // §4.2 编号映射
  mapping_period_overlap: '同编号的有效期不能重叠',
  invalid_mapping_period: '编号映射有效期不合法',

  // §4.2 服务选项
  category_name_duplicate: '服务大类名称已存在',
  invalid_subcategories: '小类格式不合法',
  subcategory_name_duplicate: '小类名称重复',

  // §4.2 撤回
  revert_target_not_found: '未找到可撤回的操作',
  revert_target_invalid: '该操作不能撤回（可能已被撤回）',

  // §4.3 聊天域
  session_busy: '当前会话正在处理中，请稍候',
  session_not_found: '会话不存在',
  turn_not_found: '回合不存在',
  invalid_approval: '确认请求缺少 approved 字段',
  approval_not_found: '确认请求不存在或已处理',
  tool_approval_required: '当前会话有未处理的工具确认，请先处理',
  model_config_missing: '服务端未配置模型',
  model_build_failed: 'AI 模型构建失败',
  model_authentication_error: '模型服务认证失败',
  model_quota_limit_error: '模型额度不足或频率受限',
  model_network_error: '模型服务网络异常',
  model_call_failed: '模型调用失败',

  // §4.4 前端本地校验
  invalid_batch_input: '请至少选择一条工单并填写一个修改项',
  record_gated: '该记录有未解决的冲突，请先到冲突解决中心处理',
}

/** message 字符串解析：先整串查表；形如 `code:detail` 时再按 code 查表；都未命中回退原串。 */
function resolveMessage(message: string): string {
  const direct = errorMessageMap[message]
  if (direct) return direct
  const colon = message.indexOf(':')
  if (colon > 0) {
    const code = message.slice(0, colon)
    if (errorMessageMap[code]) return errorMessageMap[code]
  }
  return message
}

/** 解析任意错误为可展示中文文案；未命中映射时回退 message / 原始字符串。 */
export function toErrorMessage(err: unknown): string {
  if (err === null || err === undefined) return '操作失败，请稍后重试'
  if (typeof err === 'string') return resolveMessage(err)

  const obj = err as {
    errorCode?: unknown
    error_code?: unknown
    message?: unknown
  }
  const code =
    typeof obj.errorCode === 'string'
      ? obj.errorCode
      : typeof obj.error_code === 'string'
        ? obj.error_code
        : undefined
  if (code && errorMessageMap[code]) return errorMessageMap[code]
  if (typeof obj.message === 'string' && obj.message) {
    return resolveMessage(obj.message)
  }
  return '操作失败，请稍后重试'
}
