import type { CbDatabase } from '../db/schema'
import type { WorkOrder } from '../db/schema/business/workOrders'
import { CustomerCodeMappingsRepository } from '../repositories/customerCodeMappings'
import { CustomersRepository } from '../repositories/customers'
import { ServiceCategoriesRepository } from '../repositories/serviceCategories'
import { newId } from '../utils/id'
import {
  applyWorkOrderPatch,
  toWireRecord,
  validateWorkOrderInput,
  type WorkOrderFields,
} from './businessCommands'
import type { MutationChange, MutationInput } from './mutation'

export const AI_DRAFT_BATCH_LIMIT = 20

const CREATE_FIELDS = new Set([
  'work_order_date',
  'customer_id',
  'service_category',
  'service_item',
  'quantity',
  'unit',
  'unit_price_cents',
  'is_completed',
  // 后端预校验后补齐的只读客户快照；前端会再次按 customer_id + 日期核对。
  'customer_code',
  'customer_name',
])
const UPDATE_FIELDS = CREATE_FIELDS

export interface AiDraftCall {
  toolCallId: string
  toolName: string
  draft: unknown
}

export interface PreparedAiDraft {
  toolCallId: string
  toolName: 'create_work_order' | 'update_work_order'
  kind: 'create' | 'update'
  entitySyncId: string
  baseVersion: number
  fields: Record<string, unknown>
  before: Record<string, unknown> | null
  change: MutationChange
}

export class AiDraftValidationError extends Error {
  code: string
  toolCallId?: string

  constructor(code: string, message: string, toolCallId?: string) {
    super(message)
    this.name = 'AiDraftValidationError'
    this.code = code
    this.toolCallId = toolCallId
  }
}

export async function prepareAiDraftBatch(
  db: CbDatabase,
  calls: AiDraftCall[],
): Promise<PreparedAiDraft[]> {
  if (calls.length === 0) {
    throw new AiDraftValidationError('ai_draft_empty', '草案不能为空')
  }
  if (calls.length > AI_DRAFT_BATCH_LIMIT) {
    throw new AiDraftValidationError(
      'ai_draft_batch_too_large',
      `单批最多 ${AI_DRAFT_BATCH_LIMIT} 张工单`,
    )
  }

  const ids = new Set<string>()
  const prepared: PreparedAiDraft[] = []
  for (const call of calls) {
    if (!call.toolCallId || ids.has(call.toolCallId)) {
      throw new AiDraftValidationError('ai_draft_call_invalid', '工具调用标识无效', call.toolCallId)
    }
    ids.add(call.toolCallId)
    prepared.push(await prepareCall(db, call))
  }
  return prepared
}

export function buildAiBatchOperation(
  turnId: string,
  drafts: PreparedAiDraft[],
): MutationInput {
  if (drafts.length === 0 || drafts.length > AI_DRAFT_BATCH_LIMIT) {
    throw new AiDraftValidationError('ai_draft_selection_invalid', '批准项数量不合法')
  }
  const changes: MutationChange[] = drafts.map(
    (draft) => JSON.parse(JSON.stringify(draft.change)) as MutationChange,
  )
  return {
    operationType: drafts.length === 1 ? drafts[0].toolName : 'ai_batch_work_orders',
    entitySyncIds: changes.map((change) => change.entitySyncId),
    changes,
    apply: async (tx) => {
      for (const change of changes) await applyWorkOrderPatch(tx, change)
    },
    actorType: 'ai',
    sourceTurnId: turnId,
  }
}

async function prepareCall(db: CbDatabase, call: AiDraftCall): Promise<PreparedAiDraft> {
  if (call.toolName !== 'create_work_order' && call.toolName !== 'update_work_order') {
    throw new AiDraftValidationError('ai_draft_tool_invalid', '不支持的草案工具', call.toolCallId)
  }
  const draft = unwrapDraft(call.draft, call.toolCallId)
  if (call.toolName === 'create_work_order') return prepareCreate(db, call, draft)
  return prepareUpdate(db, call, draft)
}

async function prepareCreate(
  db: CbDatabase,
  call: AiDraftCall,
  draft: Record<string, unknown>,
): Promise<PreparedAiDraft> {
  assertOnlyKeys(draft, new Set(['fields']), call.toolCallId)
  const raw = requireFields(draft.fields, call.toolCallId)
  assertOnlyKeys(raw, CREATE_FIELDS, call.toolCallId)

  const workOrderDate = requireDate(raw.work_order_date, call.toolCallId)
  const customerId = requireCustomerId(raw.customer_id, call.toolCallId)
  const mapping = await resolveCustomerMapping(db, customerId, workOrderDate, call.toolCallId)
  assertCustomerSnapshot(raw, mapping, call.toolCallId)
  const serviceCategory = requireText(raw.service_category, 'service_category', call.toolCallId)
  const serviceItem = optionalText(raw.service_item, 'service_item', call.toolCallId)
  const quantity = requirePositiveInt(raw.quantity, 'quantity', call.toolCallId)
  const unit = requireText(raw.unit, 'unit', call.toolCallId)
  const unitPriceCents = optionalNonNegativeInt(raw.unit_price_cents, 'unit_price_cents', call.toolCallId)
  const isCompleted = optionalCompletion(raw.is_completed, call.toolCallId) ?? 0

  const businessFields: WorkOrderFields = {
    workOrderDate,
    customerId,
    customerCode: mapping.customerCode,
    customerName: mapping.customerName,
    serviceCategory,
    serviceItem,
    quantity,
    unit,
    unitPriceCents,
  }
  try {
    await validateWorkOrderInput(businessFields, db)
  } catch (error) {
    throw normalizeBusinessError(error, call.toolCallId)
  }

  const fields: Record<string, unknown> = {
    work_order_date: workOrderDate,
    customer_id: customerId,
    customer_code: mapping.customerCode,
    customer_name: mapping.customerName,
    service_category: serviceCategory,
    service_item: serviceItem,
    quantity,
    unit,
    unit_price_cents: unitPriceCents,
    is_completed: isCompleted,
  }
  const entitySyncId = newId('sync')
  const change: MutationChange = {
    entitySyncId,
    entityType: 'work_order',
    baseVersion: 0,
    baseSnapshot: {},
    patch: fields,
  }
  return {
    toolCallId: call.toolCallId,
    toolName: 'create_work_order',
    kind: 'create',
    entitySyncId,
    baseVersion: 0,
    fields,
    before: null,
    change,
  }
}

async function prepareUpdate(
  db: CbDatabase,
  call: AiDraftCall,
  draft: Record<string, unknown>,
): Promise<PreparedAiDraft> {
  assertOnlyKeys(draft, new Set(['entity_sync_id', 'base_version', 'fields']), call.toolCallId)
  const entitySyncId = requireText(draft.entity_sync_id, 'entity_sync_id', call.toolCallId)
  const baseVersion = requirePositiveInt(draft.base_version, 'base_version', call.toolCallId)
  const existing = await db.workOrders.get(entitySyncId)
  if (!existing || existing.deletedAt !== null) {
    throw new AiDraftValidationError('entity_not_found', '要修改的工单不存在', call.toolCallId)
  }
  if (existing.rowVersion !== baseVersion) {
    throw new AiDraftValidationError(
      'draft_base_version_conflict',
      '工单版本已经变化',
      call.toolCallId,
    )
  }

  const raw = requireFields(draft.fields, call.toolCallId)
  assertOnlyKeys(raw, UPDATE_FIELDS, call.toolCallId)
  if (Object.keys(raw).length === 0) {
    throw new AiDraftValidationError('ai_draft_no_changes', '草案没有修改字段', call.toolCallId)
  }

  const fields: Record<string, unknown> = {}
  if ('work_order_date' in raw) fields.work_order_date = requireDate(raw.work_order_date, call.toolCallId)
  if ('customer_id' in raw) fields.customer_id = requireCustomerId(raw.customer_id, call.toolCallId)
  if ('service_category' in raw) fields.service_category = requireText(raw.service_category, 'service_category', call.toolCallId)
  if ('service_item' in raw) fields.service_item = optionalText(raw.service_item, 'service_item', call.toolCallId)
  if ('quantity' in raw) fields.quantity = requirePositiveInt(raw.quantity, 'quantity', call.toolCallId)
  if ('unit' in raw) fields.unit = requireText(raw.unit, 'unit', call.toolCallId)
  if ('unit_price_cents' in raw) fields.unit_price_cents = optionalNonNegativeInt(raw.unit_price_cents, 'unit_price_cents', call.toolCallId)
  if ('is_completed' in raw) fields.is_completed = optionalCompletion(raw.is_completed, call.toolCallId)

  const mergedCustomerId = (fields.customer_id ?? existing.customerId) as number
  const mergedDate = (fields.work_order_date ?? existing.workOrderDate) as string
  if ('customer_id' in fields || 'work_order_date' in fields) {
    const mapping = await resolveCustomerMapping(db, mergedCustomerId, mergedDate, call.toolCallId)
    assertCustomerSnapshot(raw, mapping, call.toolCallId)
    fields.customer_code = mapping.customerCode
    fields.customer_name = mapping.customerName
  }
  if ('service_category' in fields || 'service_item' in fields) {
    await validateServiceOption(
      db,
      (fields.service_category ?? existing.serviceCategory) as string,
      (fields.service_item ?? existing.serviceItem) as string | null,
      call.toolCallId,
    )
  }

  const before = workOrderBusinessSnapshot(existing)
  const effective = Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => before[key] !== value),
  )
  if (Object.keys(effective).length === 0) {
    throw new AiDraftValidationError('ai_draft_no_changes', '草案没有实际变化', call.toolCallId)
  }
  const change: MutationChange = {
    entitySyncId,
    entityType: 'work_order',
    baseVersion,
    baseSnapshot: toWireRecord(existing as unknown as Record<string, unknown>),
    patch: effective,
  }
  return {
    toolCallId: call.toolCallId,
    toolName: 'update_work_order',
    kind: 'update',
    entitySyncId,
    baseVersion,
    fields: effective,
    before,
    change,
  }
}

function unwrapDraft(value: unknown, toolCallId: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AiDraftValidationError('ai_draft_invalid', '草案格式无效', toolCallId)
  if (isRecord(value.draft) && Object.keys(value).length === 1) return value.draft
  return value
}

function requireFields(value: unknown, toolCallId: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AiDraftValidationError('ai_draft_invalid', 'fields 必须是对象', toolCallId)
  return value
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, toolCallId: string): void {
  const forbidden = Object.keys(value).find((key) => !allowed.has(key))
  if (forbidden) {
    throw new AiDraftValidationError(
      'ai_draft_field_forbidden',
      `草案包含不允许的字段：${forbidden}`,
      toolCallId,
    )
  }
}

async function resolveCustomerMapping(
  db: CbDatabase,
  customerId: number,
  date: string,
  toolCallId: string,
): Promise<{ customerCode: string; customerName: string }> {
  const customer = await new CustomersRepository(db).getByCustomerId(customerId)
  if (!customer || customer.archivedAt !== null) {
    throw new AiDraftValidationError('customer_not_found', '客户不存在或已归档', toolCallId)
  }
  const mappings = await new CustomerCodeMappingsRepository(db).list({ customerId, onDate: date })
  if (mappings.length === 0) {
    throw new AiDraftValidationError('customer_mapping_invalid', '该日期没有有效客户编号', toolCallId)
  }
  if (mappings.length > 1) {
    throw new AiDraftValidationError('customer_mapping_ambiguous', '该日期存在多个有效客户编号', toolCallId)
  }
  return { customerCode: mappings[0].customerCode, customerName: mappings[0].customerName }
}

function assertCustomerSnapshot(
  raw: Record<string, unknown>,
  mapping: { customerCode: string; customerName: string },
  toolCallId: string,
): void {
  if (
    ('customer_code' in raw && raw.customer_code !== mapping.customerCode) ||
    ('customer_name' in raw && raw.customer_name !== mapping.customerName)
  ) {
    throw new AiDraftValidationError(
      'ai_draft_customer_snapshot_mismatch',
      '客户编号或名称与日期映射不一致',
      toolCallId,
    )
  }
}

async function validateServiceOption(
  db: CbDatabase,
  categoryName: string,
  itemName: string | null,
  toolCallId: string,
): Promise<void> {
  const category = await new ServiceCategoriesRepository(db).findByCategoryName(categoryName)
  if (!category || !category.isActive) {
    throw new AiDraftValidationError('service_option_disabled', '服务大类不存在或已停用', toolCallId)
  }
  if (itemName === null) return
  const item = category.subcategoriesJson.find((entry) => entry.name === itemName)
  if (!item) throw new AiDraftValidationError('service_item_mismatch', '服务小类不属于所选大类', toolCallId)
  if (!item.isActive) throw new AiDraftValidationError('service_option_disabled', '服务小类已停用', toolCallId)
}

function workOrderBusinessSnapshot(order: WorkOrder): Record<string, unknown> {
  return {
    work_order_date: order.workOrderDate,
    customer_id: order.customerId,
    customer_code: order.customerCode,
    customer_name: order.customerName,
    service_category: order.serviceCategory,
    service_item: order.serviceItem,
    quantity: order.quantity,
    unit: order.unit,
    unit_price_cents: order.unitPriceCents,
    is_completed: order.isCompleted ? 1 : 0,
    created_at: order.createdAt,
  }
}

function requireDate(value: unknown, toolCallId: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new AiDraftValidationError('invalid_work_order_date', '工单日期无效', toolCallId)
  }
  return value
}

function requireCustomerId(value: unknown, toolCallId: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value === 0) {
    throw new AiDraftValidationError('customer_not_found', '客户 ID 无效', toolCallId)
  }
  return value
}

function requirePositiveInt(value: unknown, field: string, toolCallId: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AiDraftValidationError(`invalid_${field}`, `${field} 必须是正整数`, toolCallId)
  }
  return value
}

function optionalNonNegativeInt(value: unknown, field: string, toolCallId: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AiDraftValidationError(`invalid_${field}`, `${field} 必须是非负整数或空`, toolCallId)
  }
  return value
}

function optionalCompletion(value: unknown, toolCallId: string): 0 | 1 | undefined {
  if (value === undefined) return undefined
  if (value === 0 || value === 1) return value
  throw new AiDraftValidationError('invalid_is_completed', '完成状态必须是 0 或 1', toolCallId)
}

function requireText(value: unknown, field: string, toolCallId: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AiDraftValidationError(`invalid_${field}`, `${field} 不能为空`, toolCallId)
  }
  return value.trim()
}

function optionalText(value: unknown, field: string, toolCallId: string): string | null {
  if (value === undefined || value === null) return null
  return requireText(value, field, toolCallId)
}

function normalizeBusinessError(error: unknown, toolCallId: string): AiDraftValidationError {
  const candidate = error as { errorCode?: unknown; message?: unknown }
  const code = typeof candidate.errorCode === 'string' ? candidate.errorCode : 'ai_draft_invalid'
  const message = typeof candidate.message === 'string' ? candidate.message : '草案业务校验失败'
  return new AiDraftValidationError(code, message, toolCallId)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
