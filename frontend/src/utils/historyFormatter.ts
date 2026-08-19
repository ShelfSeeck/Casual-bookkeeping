import type { CustomerUi } from '../types/ui'
import { formatChatTime } from './chatTime'

export interface HistoryDiffItem {
  fieldKey: string
  fieldLabel: string
  beforeValue?: unknown
  afterValue?: unknown
  beforeText: string
  afterText: string
}

export type HistoryIconType = 'create' | 'update' | 'price' | 'complete' | 'revert' | 'other'

export interface HistoryItemViewModel {
  operationId: string
  summary: string
  timestamp: string
  formattedTime: string
  device: string | null
  deviceLabel: string
  actorType: 'user' | 'ai' | 'system'
  actorLabel: string
  operationType: string
  iconType: HistoryIconType
  canRevert: boolean
  isReverted: boolean
  revertsOperationId?: string | null
  diffs: HistoryDiffItem[]
}

const FIELD_LABEL_MAP: Record<string, string> = {
  work_order_date: '工单日期',
  workOrderDate: '工单日期',
  order_date: '工单日期',
  orderDate: '工单日期',
  customer_id: '客户',
  customerId: '客户',
  customer_code: '客户编号',
  customerCode: '客户编号',
  customer_name: '客户名称',
  customerName: '客户名称',
  customerDisplayName: '客户简称',
  service_category: '服务大类',
  serviceCategory: '服务大类',
  category_name: '服务大类',
  categoryName: '服务大类',
  service_item: '服务小类',
  serviceItem: '服务小类',
  subcategory_name: '服务小类',
  subcategoryName: '服务小类',
  quantity: '数量',
  unit: '单位',
  unit_price_cents: '单价',
  unitPriceCents: '单价',
  price_cents: '单价',
  is_completed: '工单状态',
  isCompleted: '工单状态',
  deleted_at: '工单删除',
  deletedAt: '工单删除',
  archived_at: '工单归档',
  archivedAt: '工单归档',
}

const EXCLUDED_DIFF_FIELDS = new Set([
  'row_version',
  'rowVersion',
  'created_at',
  'createdAt',
  'updated_at',
  'updatedAt',
  'account_phone',
  'accountPhone',
  'sync_id',
  'syncId',
  'server_seq',
  'serverSeq',
  'device_id',
  'deviceId',
  'operation_id',
  'operationId',
])

export function getFieldLabel(fieldKey: string): string {
  return FIELD_LABEL_MAP[fieldKey] ?? fieldKey
}

export function formatFieldValue(
  fieldKey: string,
  value: unknown,
  context?: { unit?: string; customers?: CustomerUi[] },
): string {
  if (value === null || value === undefined || value === '') {
    if (fieldKey === 'unit_price_cents' || fieldKey === 'unitPriceCents' || fieldKey === 'price_cents') {
      return '未定价'
    }
    return '—'
  }

  // 单价
  if (fieldKey === 'unit_price_cents' || fieldKey === 'unitPriceCents' || fieldKey === 'price_cents') {
    const num = Number(value)
    if (Number.isNaN(num) || num <= 0) return '未定价'
    return `¥${(num / 100).toFixed(2)}`
  }

  // 状态
  if (fieldKey === 'is_completed' || fieldKey === 'isCompleted') {
    if (value === true || value === 1 || value === '1') return '已完成'
    return '未完成'
  }

  // 数量
  if (fieldKey === 'quantity') {
    const unitStr = context?.unit ? ` ${context.unit}` : ''
    return `${value}${unitStr}`
  }

  // 客户
  if ((fieldKey === 'customer_id' || fieldKey === 'customerId') && context?.customers) {
    const id = Number(value)
    const found = context.customers.find((c) => c.customerId === id)
    if (found) {
      return `${found.displayName || found.customerName} (${found.code || id})`
    }
  }

  // 布尔值
  if (typeof value === 'boolean') {
    return value ? '是' : '否'
  }

  return String(value)
}

export function formatRelativeHistoryTime(iso: string, now: Date = new Date()): string {
  return formatChatTime(iso, now)
}

function parseJsonSafe(val: unknown): Record<string, unknown> | null {
  if (!val) return null
  if (typeof val === 'object') return val as Record<string, unknown>
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val)
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch {
      return null
    }
  }
  return null
}

export function extractHistoryDiffs(
  change: Record<string, unknown>,
  customers?: CustomerUi[],
): HistoryDiffItem[] {
  const diffs: HistoryDiffItem[] = []

  // 模式 1: Pull 形状 (before_json / after_json / changed_fields_json)
  const beforeObj = parseJsonSafe(change.before_json ?? change.beforeJson)
  const afterObj = parseJsonSafe(change.after_json ?? change.afterJson)
  const changedFieldsRaw = change.changed_fields_json ?? change.changedFieldsJson

  if (beforeObj && afterObj) {
    let keysToCompare: string[] = []
    if (changedFieldsRaw) {
      const parsed = parseJsonSafe(changedFieldsRaw)
      if (Array.isArray(parsed)) {
        keysToCompare = parsed.filter((x): x is string => typeof x === 'string')
      } else if (parsed && typeof parsed === 'object') {
        keysToCompare = Object.keys(parsed)
      }
    }
    if (keysToCompare.length === 0) {
      keysToCompare = Array.from(new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]))
    }

    const unit = String(afterObj.unit ?? beforeObj.unit ?? '')

    for (const key of keysToCompare) {
      if (EXCLUDED_DIFF_FIELDS.has(key)) continue
      const bVal = beforeObj[key]
      const aVal = afterObj[key]
      if (bVal !== aVal) {
        diffs.push({
          fieldKey: key,
          fieldLabel: getFieldLabel(key),
          beforeValue: bVal,
          afterValue: aVal,
          beforeText: formatFieldValue(key, bVal, { unit, customers }),
          afterText: formatFieldValue(key, aVal, { unit, customers }),
        })
      }
    }
    return diffs
  }

  // 模式 2: 本地 outbox 形状 (baseSnapshot + patch)
  const baseObj = parseJsonSafe(change.baseSnapshot)
  const patchObj = parseJsonSafe(change.patch)

  if (patchObj) {
    const unit = String(patchObj.unit ?? baseObj?.unit ?? '')
    for (const key of Object.keys(patchObj)) {
      if (EXCLUDED_DIFF_FIELDS.has(key)) continue
      const bVal = baseObj ? baseObj[key] : undefined
      const aVal = patchObj[key]
      diffs.push({
        fieldKey: key,
        fieldLabel: getFieldLabel(key),
        beforeValue: bVal,
        afterValue: aVal,
        beforeText: formatFieldValue(key, bVal, { unit, customers }),
        afterText: formatFieldValue(key, aVal, { unit, customers }),
      })
    }
    return diffs
  }

  return diffs
}

export function buildHistoryItemViewModel(params: {
  operationId: string
  operationType: string
  actorType: 'user' | 'ai' | 'system'
  deviceId: string | null
  createdAt: string
  changesJson?: string | null
  currentDeviceId?: string | null
  canRevert: boolean
  isReverted: boolean
  revertsOperationId?: string | null
  customers?: CustomerUi[]
  outboxChanges?: Array<Record<string, unknown>>
}): HistoryItemViewModel {
  const {
    operationId,
    operationType,
    actorType,
    deviceId,
    createdAt,
    changesJson,
    currentDeviceId,
    canRevert,
    isReverted,
    revertsOperationId,
    customers,
    outboxChanges,
  } = params

  const diffs: HistoryDiffItem[] = []

  // 从 changesJson 提取
  if (changesJson) {
    try {
      const parsed = JSON.parse(changesJson) as { changes?: Array<Record<string, unknown>> }
      if (Array.isArray(parsed.changes)) {
        for (const c of parsed.changes) {
          diffs.push(...extractHistoryDiffs(c, customers))
        }
      }
    } catch {
      // ignore
    }
  }

  // 如果 changesJson 没解析出且提供了 outboxChanges（如本地暂未 Pull 的操作）
  if (diffs.length === 0 && Array.isArray(outboxChanges)) {
    for (const c of outboxChanges) {
      diffs.push(...extractHistoryDiffs(c, customers))
    }
  }

  // 判定动作类型与图标
  let iconType: HistoryIconType = 'update'
  let summary = '修改工单'

  if (operationType === 'revert_operation' || revertsOperationId) {
    iconType = 'revert'
    summary = '撤回历史操作'
  } else if (operationType === 'create_work_order') {
    iconType = 'create'
    summary = '新建工单'
  } else if (operationType === 'batch_price_work_orders') {
    iconType = 'price'
    summary = '批量定价'
  } else if (diffs.length === 1 && (diffs[0].fieldKey === 'is_completed' || diffs[0].fieldKey === 'isCompleted')) {
    iconType = 'complete'
    summary = diffs[0].afterText === '已完成' ? '标记为已完成' : '标记为未完成'
  } else if (diffs.length === 1 && (diffs[0].fieldKey === 'unit_price_cents' || diffs[0].fieldKey === 'unitPriceCents')) {
    iconType = 'price'
    summary = diffs[0].beforeText === '未定价' ? '录入单价' : '修改单价'
  } else if (diffs.length > 0) {
    const labels = Array.from(new Set(diffs.map((d) => d.fieldLabel))).slice(0, 3)
    summary = `修改了 ${labels.join('、')}`
  }

  // 格式化操作者
  let actorLabel = '本人'
  if (actorType === 'ai') actorLabel = 'AI 助手'
  else if (actorType === 'system') actorLabel = '系统'

  // 设备标签
  let deviceLabel = '本机'
  if (deviceId && currentDeviceId && deviceId !== currentDeviceId) {
    deviceLabel = '其他设备'
  }

  return {
    operationId,
    summary,
    timestamp: createdAt,
    formattedTime: formatRelativeHistoryTime(createdAt),
    device: deviceId,
    deviceLabel,
    actorType,
    actorLabel,
    operationType,
    iconType,
    canRevert,
    isReverted,
    revertsOperationId,
    diffs,
  }
}
