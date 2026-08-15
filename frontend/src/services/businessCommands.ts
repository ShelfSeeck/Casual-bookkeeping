import type { CbDatabase } from '../db/schema'
import type { Customer } from '../db/schema/business/customers'
import type { CustomerCodeMapping } from '../db/schema/business/customerCodeMappings'
import type { ServiceCategory, Subcategory } from '../db/schema/business/serviceCategories'
import type { WorkOrder } from '../db/schema/business/workOrders'
import { CustomersRepository } from '../repositories/customers'
import { CustomerCodeMappingsRepository } from '../repositories/customerCodeMappings'
import { ServiceCategoriesRepository } from '../repositories/serviceCategories'
import { newId } from '../utils/id'
import { MutationService, type MutationChange, type MutationTx } from './mutation'

// businessCommands：业务命令层（docs/spec/business-p0p1.md §5.8.2）。
// 纯校验 + 命令构建 + 通过 MutationService.commit 提交。
// - 校验错误抛 BusinessRuleError(errorCode)，页面只展示错误码。
// - outbox.command.changes 内 patch 是 wire 形状（snake_case；subcategories_json 为 JSON 字符串）。
// - apply 写本地 Dexie 时使用 camelCase（subcategoriesJson 为数组）。
// 本地新记录：rowVersion=1、createdAt/updatedAt ISO 字符串、accountPhone 来自库名 db_<phone>。

export class BusinessRuleError extends Error {
  errorCode: string

  constructor(errorCode: string) {
    super(errorCode)
    this.name = 'BusinessRuleError'
    this.errorCode = errorCode
  }
}

/** 从业务库名 db_<phone> 提取账户手机号（本地新记录写 accountPhone 用）。 */
export function accountPhoneFromDb(db: CbDatabase): string {
  return db.name.replace('db_', '')
}

export type WorkOrderFields = {
  workOrderDate: string
  customerId: number
  customerCode: string
  customerName: string
  serviceCategory: string
  serviceItem: string | null
  quantity: number
  unit: string
  unitPriceCents: number | null
}

export interface CustomerWithMappingInput {
  canonicalName: string
  customerCode: string
  customerName: string
  validFrom: string
  validTo?: string | null
}

export interface CustomerCodeMappingFields {
  customerId: number
  customerCode: string
  customerName: string
  validFrom: string
  validTo?: string | null
}

export interface ServiceCategoryFields {
  categoryName: string
  subcategories: Subcategory[]
}

export interface ServiceCategoryPatch {
  categoryName?: string
  subcategories?: Subcategory[]
  isActive?: boolean
}

export interface BuiltCustomerWithMappingCommand {
  operationType: 'create_customer_with_mapping'
  customerSyncId: string
  customerId: number
  entitySyncIds: string[]
  changes: MutationChange[]
  apply: (tx: MutationTx) => unknown
}

// ---------- 校验（docs/spec/business-p0p1.md §5.8.2，错误码同 docs/error-codes.md） ----------

export async function validateWorkOrderInput(
  fields: WorkOrderFields,
  db: CbDatabase,
): Promise<void> {
  validateQuantity(fields.quantity)
  validateUnit(fields.unit)
  validateUnitPrice(fields.unitPriceCents)
  if (fields.serviceItem !== null && typeof fields.serviceItem !== 'string') {
    throw new BusinessRuleError('invalid_service_item')
  }

  const customer = await new CustomersRepository(db).getByCustomerId(fields.customerId)
  if (!customer || customer.archivedAt !== null) {
    throw new BusinessRuleError('customer_not_found')
  }

  if (fields.serviceCategory && fields.serviceItem) {
    await validateServiceOption(db, fields.serviceCategory, fields.serviceItem)
  }

  const mapping = await new CustomerCodeMappingsRepository(db).findValid(
    fields.customerCode,
    fields.workOrderDate,
  )
  if (!mapping) {
    throw new BusinessRuleError('customer_mapping_invalid')
  }
}

export async function validateCustomerInput(input: { canonicalName: string }): Promise<void> {
  if (!input.canonicalName || !input.canonicalName.trim()) {
    throw new BusinessRuleError('invalid_customer_name')
  }
}

export interface ValidateMappingInputOptions {
  /** update 时排除自身 syncId，避免与自己比较区间。 */
  excludeSyncId?: string
  /** 新建客户一步建齐时客户尚未落库，跳过客户存在性检查。 */
  skipCustomerCheck?: boolean
}

export async function validateMappingInput(
  db: CbDatabase,
  input: CustomerCodeMappingFields,
  options: ValidateMappingInputOptions = {},
): Promise<void> {
  const validTo = input.validTo ?? null
  if (validTo !== null && validTo < input.validFrom) {
    throw new BusinessRuleError('invalid_mapping_period')
  }
  if (!options.skipCustomerCheck) {
    const customer = await new CustomersRepository(db).getByCustomerId(input.customerId)
    if (!customer || customer.archivedAt !== null) {
      throw new BusinessRuleError('customer_not_found')
    }
  }

  // 同编号重叠区间（含端点，§5.3）：existing.valid_from <= new.valid_to
  // 且 (existing.valid_to IS NULL 或 existing.valid_to >= new.valid_from)。
  const existing = await new CustomerCodeMappingsRepository(db).list({
    customerCode: input.customerCode,
  })
  const overlap = existing.some(
    (m) =>
      m.syncId !== options.excludeSyncId &&
      (validTo === null || m.validFrom <= validTo) &&
      (m.validTo === null || m.validTo >= input.validFrom),
  )
  if (overlap) {
    throw new BusinessRuleError('mapping_period_overlap')
  }
}

export interface ValidateServiceCategoryInput {
  categoryName: string
  subcategories?: Subcategory[]
  excludeSyncId?: string
}

export async function validateServiceCategoryInput(
  db: CbDatabase,
  input: ValidateServiceCategoryInput,
): Promise<void> {
  const existing = await new ServiceCategoriesRepository(db).findByCategoryName(
    input.categoryName,
  )
  if (existing && existing.syncId !== input.excludeSyncId) {
    throw new BusinessRuleError('category_name_duplicate')
  }
  if (input.subcategories !== undefined) {
    validateSubcategories(input.subcategories)
  }
}

// ---------- 工单命令 ----------

export function buildCreateWorkOrderChange(fields: WorkOrderFields): MutationChange {
  return {
    entitySyncId: newId('sync'),
    entityType: 'work_order',
    baseVersion: 0,
    baseSnapshot: {},
    patch: workOrderWirePatch(fields, { isCompleted: false }),
  }
}

export async function createWorkOrder(db: CbDatabase, fields: WorkOrderFields): Promise<void> {
  await validateWorkOrderInput(fields, db)
  const change = buildCreateWorkOrderChange(fields)
  await new MutationService(db).commit({
    operationType: 'create_work_order',
    entitySyncIds: [change.entitySyncId],
    changes: [change],
    apply: (tx) => applyWorkOrderPatch(tx, change),
    actorType: 'user',
  })
}

export async function updateWorkOrder(
  db: CbDatabase,
  syncId: string,
  patch: Partial<WorkOrderFields> & { isCompleted?: boolean },
): Promise<void> {
  const existing = await db.workOrders.get(syncId)
  if (!existing) throw new BusinessRuleError('entity_not_found')
  await validateWorkOrderPatch(db, existing, patch)

  const change: MutationChange = {
    entitySyncId: syncId,
    entityType: 'work_order',
    baseVersion: existing.rowVersion,
    baseSnapshot: toWireRecord(existing as unknown as Record<string, unknown>),
    patch: toWirePatch(patch as Record<string, unknown>),
  }
  await new MutationService(db).commit({
    operationType: 'update_work_order',
    entitySyncIds: [syncId],
    changes: [change],
    apply: (tx) => applyWorkOrderPatch(tx, change),
    actorType: 'user',
  })
}

/**
 * 纯辅助函数：按 change 把工单 patch 落到本地 Dexie（供 T6 AI 草案复用）。
 * create：直接 put 新记录（rowVersion=1，时间/accountPhone 自动补全）。
 * update：读现记录 → 合并 patch → 更新 updatedAt。
 * change.patch 是 wire 形状（snake_case），本地写入时转换为 camelCase。
 */
export async function applyWorkOrderPatch(
  tx: MutationTx,
  change: MutationChange,
): Promise<void> {
  const localPatch = wirePatchToLocal(change.patch ?? {}) as Partial<WorkOrder>
  const now = new Date().toISOString()

  if (change.baseVersion === 0) {
    const db = tx.workOrders.db as CbDatabase
    const record: WorkOrder = {
      syncId: change.entitySyncId,
      accountPhone: accountPhoneFromDb(db),
      workOrderDate: localPatch.workOrderDate ?? '',
      customerId: localPatch.customerId ?? 0,
      customerCode: localPatch.customerCode ?? '',
      customerName: localPatch.customerName ?? '',
      serviceCategory: localPatch.serviceCategory ?? '',
      serviceItem: localPatch.serviceItem ?? null,
      quantity: localPatch.quantity ?? 0,
      unit: localPatch.unit ?? '',
      unitPriceCents: localPatch.unitPriceCents ?? null,
      isCompleted: localPatch.isCompleted ?? false,
      rowVersion: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    await tx.workOrders.put(record)
    return
  }

  const existing = await tx.workOrders.get(change.entitySyncId)
  if (!existing) throw new BusinessRuleError('entity_not_found')
  await tx.workOrders.put({ ...existing, ...localPatch, updatedAt: now })
}

// ---------- 客户 + 编号映射一步建齐（跨实体原子操作） ----------

export async function buildCustomerWithMapping(
  db: CbDatabase,
  input: CustomerWithMappingInput,
): Promise<BuiltCustomerWithMappingCommand> {
  await validateCustomerInput(input)
  await validateMappingInput(
    db,
    {
      customerId: 0,
      customerCode: input.customerCode,
      customerName: input.customerName,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
    },
    { skipCustomerCheck: true },
  )

  const customerSyncId = newId('sync')
  const mappingSyncId = newId('sync')
  // 离线新建客户：负 customerId = -Number.parseInt(syncId.slice(5), 16)（docs/spec/business-p0p1.md §5.5）
  const customerId = -Number.parseInt(customerSyncId.slice(5), 16)
  const phone = accountPhoneFromDb(db)
  const now = new Date().toISOString()

  const customerRecord: Customer = {
    syncId: customerSyncId,
    accountPhone: phone,
    customerId,
    canonicalName: input.canonicalName.trim(),
    archivedAt: null,
    rowVersion: 1,
    createdAt: now,
    updatedAt: now,
  }
  const mappingRecord: CustomerCodeMapping = {
    syncId: mappingSyncId,
    accountPhone: phone,
    customerId,
    customerCode: input.customerCode,
    customerName: input.customerName,
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
    rowVersion: 1,
    createdAt: now,
    updatedAt: now,
  }

  const changes: MutationChange[] = [
    {
      entitySyncId: customerSyncId,
      entityType: 'customer',
      baseVersion: 0,
      baseSnapshot: {},
      patch: {
        customer_id: customerId,
        canonical_name: customerRecord.canonicalName,
      },
    },
    {
      entitySyncId: mappingSyncId,
      entityType: 'customer_code_mapping',
      baseVersion: 0,
      baseSnapshot: {},
      patch: {
        customer_id: customerId,
        customer_code: input.customerCode,
        customer_name: input.customerName,
        valid_from: input.validFrom,
        valid_to: input.validTo ?? null,
      },
    },
  ]

  return {
    operationType: 'create_customer_with_mapping',
    customerSyncId,
    customerId,
    entitySyncIds: [customerSyncId, mappingSyncId],
    changes,
    apply: async (tx) => {
      // 顺序固定：客户在前，映射在后（docs/spec/business-p0p1.md §5.6）
      await tx.customers.put(customerRecord)
      await tx.customerCodeMappings.put(mappingRecord)
    },
  }
}

/** 归档客户并收尾其所有开放映射（valid_to = 归档日），跨实体原子操作。 */
export async function archiveCustomerWithMappings(
  db: CbDatabase,
  customerSyncId: string,
): Promise<void> {
  const customer = await db.customers.get(customerSyncId)
  if (!customer || customer.archivedAt !== null) {
    throw new BusinessRuleError('customer_not_found')
  }

  const mappings = await new CustomerCodeMappingsRepository(db).list({
    customerId: customer.customerId,
  })
  const openMappings = mappings.filter((m) => m.validTo === null)
  const today = new Date().toISOString().slice(0, 10)
  const now = new Date().toISOString()

  const changes: MutationChange[] = [
    {
      entitySyncId: customerSyncId,
      entityType: 'customer',
      baseVersion: customer.rowVersion,
      baseSnapshot: toWireRecord(customer as unknown as Record<string, unknown>),
      patch: { archived_at: today },
    },
    ...openMappings.map(
      (m): MutationChange => ({
        entitySyncId: m.syncId,
        entityType: 'customer_code_mapping',
        baseVersion: m.rowVersion,
        baseSnapshot: toWireRecord(m as unknown as Record<string, unknown>),
        patch: { valid_to: today },
      }),
    ),
  ]

  await new MutationService(db).commit({
    operationType: 'archive_customer_with_mappings',
    entitySyncIds: changes.map((c) => c.entitySyncId),
    changes,
    apply: async (tx) => {
      await tx.customers.put({ ...customer, archivedAt: today, updatedAt: now })
      for (const m of openMappings) {
        await tx.customerCodeMappings.put({ ...m, validTo: today, updatedAt: now })
      }
    },
    actorType: 'user',
  })
}

// ---------- 编号映射维护 ----------

export async function addCustomerCodeMapping(
  db: CbDatabase,
  fields: CustomerCodeMappingFields,
): Promise<void> {
  await validateMappingInput(db, { ...fields, validTo: fields.validTo ?? null })

  const syncId = newId('sync')
  const phone = accountPhoneFromDb(db)
  const now = new Date().toISOString()
  const record: CustomerCodeMapping = {
    syncId,
    accountPhone: phone,
    customerId: fields.customerId,
    customerCode: fields.customerCode,
    customerName: fields.customerName,
    validFrom: fields.validFrom,
    validTo: fields.validTo ?? null,
    rowVersion: 1,
    createdAt: now,
    updatedAt: now,
  }
  const change: MutationChange = {
    entitySyncId: syncId,
    entityType: 'customer_code_mapping',
    baseVersion: 0,
    baseSnapshot: {},
    patch: {
      customer_id: fields.customerId,
      customer_code: fields.customerCode,
      customer_name: fields.customerName,
      valid_from: fields.validFrom,
      valid_to: fields.validTo ?? null,
    },
  }

  await new MutationService(db).commit({
    operationType: 'create_customer_code_mapping',
    entitySyncIds: [syncId],
    changes: [change],
    apply: (tx) => tx.customerCodeMappings.put(record),
    actorType: 'user',
  })
}

export async function updateCustomerCodeMapping(
  db: CbDatabase,
  syncId: string,
  patch: Partial<CustomerCodeMappingFields>,
): Promise<void> {
  const existing = await db.customerCodeMappings.get(syncId)
  if (!existing) throw new BusinessRuleError('entity_not_found')

  const merged: CustomerCodeMappingFields = {
    customerId: patch.customerId ?? existing.customerId,
    customerCode: patch.customerCode ?? existing.customerCode,
    customerName: patch.customerName ?? existing.customerName,
    validFrom: patch.validFrom ?? existing.validFrom,
    validTo: patch.validTo !== undefined ? patch.validTo : existing.validTo,
  }
  await validateMappingInput(db, merged, {
    excludeSyncId: syncId,
    skipCustomerCheck: patch.customerId === undefined,
  })

  const wirePatch: Record<string, unknown> = {}
  if (patch.customerId !== undefined) wirePatch.customer_id = patch.customerId
  if (patch.customerCode !== undefined) wirePatch.customer_code = patch.customerCode
  if (patch.customerName !== undefined) wirePatch.customer_name = patch.customerName
  if (patch.validFrom !== undefined) wirePatch.valid_from = patch.validFrom
  if (patch.validTo !== undefined) wirePatch.valid_to = patch.validTo

  const change: MutationChange = {
    entitySyncId: syncId,
    entityType: 'customer_code_mapping',
    baseVersion: existing.rowVersion,
    baseSnapshot: toWireRecord(existing as unknown as Record<string, unknown>),
    patch: wirePatch,
  }

  await new MutationService(db).commit({
    operationType: 'update_customer_code_mapping',
    entitySyncIds: [syncId],
    changes: [change],
    apply: async (tx) => {
      const local = await tx.customerCodeMappings.get(syncId)
      if (!local) throw new BusinessRuleError('entity_not_found')
      await tx.customerCodeMappings.put({
        ...local,
        ...patch,
        updatedAt: new Date().toISOString(),
      })
    },
    actorType: 'user',
  })
}

// ---------- 服务选项维护 ----------

export async function createServiceCategory(
  db: CbDatabase,
  fields: ServiceCategoryFields,
): Promise<void> {
  await validateServiceCategoryInput(db, fields)

  const syncId = newId('sync')
  const phone = accountPhoneFromDb(db)
  const now = new Date().toISOString()
  const record: ServiceCategory = {
    syncId,
    accountPhone: phone,
    categoryName: fields.categoryName,
    // 本地 Dexie 存数组；wire patch 里是 JSON 字符串（后端 TEXT 契约）
    subcategoriesJson: fields.subcategories,
    isActive: true,
    rowVersion: 1,
    createdAt: now,
    updatedAt: now,
  }
  const change: MutationChange = {
    entitySyncId: syncId,
    entityType: 'service_category',
    baseVersion: 0,
    baseSnapshot: {},
    patch: {
      category_name: fields.categoryName,
      subcategories_json: JSON.stringify(fields.subcategories),
      is_active: true,
    },
  }

  await new MutationService(db).commit({
    operationType: 'create_service_category',
    entitySyncIds: [syncId],
    changes: [change],
    apply: (tx) => tx.serviceCategories.put(record),
    actorType: 'user',
  })
}

export async function updateServiceCategory(
  db: CbDatabase,
  syncId: string,
  patch: ServiceCategoryPatch,
): Promise<void> {
  const existing = await db.serviceCategories.get(syncId)
  if (!existing) throw new BusinessRuleError('entity_not_found')

  await validateServiceCategoryInput(db, {
    categoryName: patch.categoryName ?? existing.categoryName,
    subcategories: patch.subcategories,
    excludeSyncId: syncId,
  })

  const wirePatch: Record<string, unknown> = {}
  if (patch.categoryName !== undefined) wirePatch.category_name = patch.categoryName
  if (patch.subcategories !== undefined) wirePatch.subcategories_json = JSON.stringify(patch.subcategories)
  if (patch.isActive !== undefined) wirePatch.is_active = patch.isActive

  const change: MutationChange = {
    entitySyncId: syncId,
    entityType: 'service_category',
    baseVersion: existing.rowVersion,
    baseSnapshot: toWireRecord(existing as unknown as Record<string, unknown>),
    patch: wirePatch,
  }

  await new MutationService(db).commit({
    operationType: 'update_service_category',
    entitySyncIds: [syncId],
    changes: [change],
    apply: async (tx) => {
      const local = await tx.serviceCategories.get(syncId)
      if (!local) throw new BusinessRuleError('entity_not_found')
      const localPatch: Partial<ServiceCategory> = {}
      if (patch.categoryName !== undefined) localPatch.categoryName = patch.categoryName
      if (patch.subcategories !== undefined) localPatch.subcategoriesJson = patch.subcategories
      if (patch.isActive !== undefined) localPatch.isActive = patch.isActive
      await tx.serviceCategories.put({
        ...local,
        ...localPatch,
        updatedAt: new Date().toISOString(),
      })
    },
    actorType: 'user',
  })
}

// ---------- 私有辅助 ----------

function validateQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new BusinessRuleError('invalid_quantity')
  }
}

function validateUnit(unit: string): void {
  if (typeof unit !== 'string' || !unit.trim()) {
    throw new BusinessRuleError('invalid_unit')
  }
}

function validateUnitPrice(unitPriceCents: number | null): void {
  if (unitPriceCents !== null && (!Number.isInteger(unitPriceCents) || unitPriceCents < 0)) {
    throw new BusinessRuleError('invalid_unit_price')
  }
}

async function validateServiceOption(
  db: CbDatabase,
  categoryName: string,
  itemName: string,
): Promise<void> {
  const category = await new ServiceCategoriesRepository(db).findByCategoryName(categoryName)
  if (!category || !category.isActive) {
    throw new BusinessRuleError('service_option_disabled')
  }
  const subcategory = category.subcategoriesJson.find((s) => s.name === itemName)
  if (!subcategory) {
    throw new BusinessRuleError('service_item_mismatch')
  }
  if (!subcategory.isActive) {
    throw new BusinessRuleError('service_option_disabled')
  }
}

function validateSubcategories(subcategories: Subcategory[]): void {
  if (!Array.isArray(subcategories)) {
    throw new BusinessRuleError('invalid_subcategories')
  }
  const names: string[] = []
  for (const item of subcategories) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      typeof item.defaultUnit !== 'string' ||
      !item.defaultUnit.trim() ||
      typeof item.isActive !== 'boolean'
    ) {
      throw new BusinessRuleError('invalid_subcategories')
    }
    names.push(item.name)
  }
  if (new Set(names).size !== names.length) {
    throw new BusinessRuleError('subcategory_name_duplicate')
  }
}

async function validateWorkOrderPatch(
  db: CbDatabase,
  existing: WorkOrder,
  patch: Partial<WorkOrderFields> & { isCompleted?: boolean },
): Promise<void> {
  const merged: WorkOrderFields = {
    workOrderDate: patch.workOrderDate ?? existing.workOrderDate,
    customerId: patch.customerId ?? existing.customerId,
    customerCode: patch.customerCode ?? existing.customerCode,
    customerName: patch.customerName ?? existing.customerName,
    serviceCategory: patch.serviceCategory ?? existing.serviceCategory,
    serviceItem: patch.serviceItem !== undefined ? patch.serviceItem : existing.serviceItem,
    quantity: patch.quantity ?? existing.quantity,
    unit: patch.unit ?? existing.unit,
    unitPriceCents:
      patch.unitPriceCents !== undefined ? patch.unitPriceCents : existing.unitPriceCents,
  }

  if (patch.quantity !== undefined) validateQuantity(patch.quantity)
  if (patch.unit !== undefined) validateUnit(patch.unit)
  if (patch.unitPriceCents !== undefined) validateUnitPrice(patch.unitPriceCents)
  if (
    patch.serviceItem !== undefined &&
    patch.serviceItem !== null &&
    typeof patch.serviceItem !== 'string'
  ) {
    throw new BusinessRuleError('invalid_service_item')
  }

  if (patch.customerId !== undefined) {
    const customer = await new CustomersRepository(db).getByCustomerId(patch.customerId)
    if (!customer || customer.archivedAt !== null) {
      throw new BusinessRuleError('customer_not_found')
    }
  }

  if (patch.serviceCategory !== undefined || patch.serviceItem !== undefined) {
    if (merged.serviceCategory && merged.serviceItem) {
      await validateServiceOption(db, merged.serviceCategory, merged.serviceItem)
    }
  }

  if (patch.workOrderDate !== undefined || patch.customerCode !== undefined) {
    const mapping = await new CustomerCodeMappingsRepository(db).findValid(
      merged.customerCode,
      merged.workOrderDate,
    )
    if (!mapping) {
      throw new BusinessRuleError('customer_mapping_invalid')
    }
  }
}

function workOrderWirePatch(
  fields: WorkOrderFields,
  extra: { isCompleted?: boolean } = {},
): Record<string, unknown> {
  return toWirePatch({
    workOrderDate: fields.workOrderDate,
    customerId: fields.customerId,
    customerCode: fields.customerCode,
    customerName: fields.customerName,
    serviceCategory: fields.serviceCategory,
    serviceItem: fields.serviceItem,
    quantity: fields.quantity,
    unit: fields.unit,
    unitPriceCents: fields.unitPriceCents,
    ...extra,
  } as Record<string, unknown>)
}

// camelCase ↔ snake_case（AGENTS.md：字段名由后端 snake_case 一对一转换）。
function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

/** 本地 camelCase patch/record → wire snake_case；subcategoriesJson 序列化为 JSON 字符串。 */
function toWireRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === 'subcategoriesJson' || key === 'subcategories') {
      out['subcategories_json'] = JSON.stringify(value)
    } else {
      out[camelToSnake(key)] = value
    }
  }
  return out
}

/** wire patch（snake_case）→ 本地 camelCase patch；subcategories_json 反序列化为数组。 */
function wirePatchToLocal(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'subcategories_json') {
      out['subcategoriesJson'] = typeof value === 'string' ? JSON.parse(value) : value
    } else {
      out[snakeToCamel(key)] = value
    }
  }
  return out
}

function toWirePatch(patch: Record<string, unknown>): Record<string, unknown> {
  return toWireRecord(patch)
}
