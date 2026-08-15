import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { CbDatabase } from '../db/schema'
import type { Customer } from '../db/schema/business/customers'
import type { CustomerCodeMapping } from '../db/schema/business/customerCodeMappings'
import type { ServiceCategory } from '../db/schema/business/serviceCategories'
import { MutationService } from './mutation'
import {
  BusinessRuleError,
  accountPhoneFromDb,
  addCustomerCodeMapping,
  archiveCustomerWithMappings,
  buildCustomerWithMapping,
  createServiceCategory,
  createWorkOrder,
  updateCustomerCodeMapping,
  updateServiceCategory,
  validateServiceCategoryInput,
  validateWorkOrderInput,
  type WorkOrderFields,
} from './businessCommands'

// 被测缝：businessCommands 校验 + 命令构建 + 提交（docs/spec/business-p0p1.md §5.8.2）
// 验证：
// 1. 校验错误码与 docs/error-codes.md 一致（BusinessRuleError(errorCode)）。
// 2. buildCustomerWithMapping 负 customerId 唯一、两条 change 的 entityType 与顺序、wire patch。
// 3. createServiceCategory / updateServiceCategory 本地存数组、wire 存 JSON 字符串。
// 4. 命令 commit 后业务表 / operations / outbox 三者一致。
// 为什么测这里：页面与 AI 草案共用这条写入管线，校验码与命令形状错了会直接污染同步。

const PHONE = '13800000000'

function makeCustomer(syncId: string, customerId: number, archivedAt: string | null = null): Customer {
  return {
    syncId,
    accountPhone: PHONE,
    customerId,
    canonicalName: `厂家${customerId}`,
    archivedAt,
    rowVersion: 1,
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
  }
}

function makeMapping(
  syncId: string,
  customerId: number,
  customerCode = '001',
  validFrom = '2026-01-01',
  validTo: string | null = null,
): CustomerCodeMapping {
  return {
    syncId,
    accountPhone: PHONE,
    customerId,
    customerCode,
    customerName: `客户${customerCode}`,
    validFrom,
    validTo,
    rowVersion: 1,
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
  }
}

function makeCategory(syncId: string, categoryName = '洗水'): ServiceCategory {
  return {
    syncId,
    accountPhone: PHONE,
    categoryName,
    subcategoriesJson: [
      { name: '单洗', defaultUnit: '件', isActive: true },
      { name: '停用小类', defaultUnit: '件', isActive: false },
    ],
    isActive: true,
    rowVersion: 1,
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
  }
}

const validFields: WorkOrderFields = {
  workOrderDate: '2026-06-15',
  customerId: 42,
  customerCode: '001',
  customerName: '张三',
  serviceCategory: '洗水',
  serviceItem: '单洗',
  quantity: 5,
  unit: '件',
  unitPriceCents: null,
}

let db: CbDatabase

beforeEach(async () => {
  db = createBusinessDb(PHONE)
  await db.delete()
  await db.open()
})

async function seedBase(): Promise<void> {
  await db.customers.put(makeCustomer('sync-cust', 42))
  await db.customerCodeMappings.put(makeMapping('sync-map', 42, '001', '2026-01-01', null))
  await db.serviceCategories.put(makeCategory('sync-cat', '洗水'))
}

describe('accountPhoneFromDb', () => {
  it('从业务库名 db_<phone> 提取账户手机号', () => {
    expect(accountPhoneFromDb(db)).toBe(PHONE)
  })
})

describe('validateWorkOrderInput（即时校验错误码）', () => {
  beforeEach(async () => {
    await seedBase()
  })

  it('合法字段通过', async () => {
    await expect(validateWorkOrderInput(validFields, db)).resolves.toBeUndefined()
  })

  it('数量非正整数 → invalid_quantity', async () => {
    await expect(validateWorkOrderInput({ ...validFields, quantity: 0 }, db))
      .rejects.toThrow(BusinessRuleError)
    await expect(validateWorkOrderInput({ ...validFields, quantity: 0 }, db))
      .rejects.toMatchObject({ errorCode: 'invalid_quantity' })
    await expect(validateWorkOrderInput({ ...validFields, quantity: 1.5 }, db))
      .rejects.toMatchObject({ errorCode: 'invalid_quantity' })
  })

  it('单位为空 → invalid_unit', async () => {
    await expect(validateWorkOrderInput({ ...validFields, unit: '  ' }, db))
      .rejects.toMatchObject({ errorCode: 'invalid_unit' })
  })

  it('单价为负或非整数 → invalid_unit_price', async () => {
    await expect(validateWorkOrderInput({ ...validFields, unitPriceCents: -1 }, db))
      .rejects.toMatchObject({ errorCode: 'invalid_unit_price' })
    await expect(validateWorkOrderInput({ ...validFields, unitPriceCents: 0.5 }, db))
      .rejects.toMatchObject({ errorCode: 'invalid_unit_price' })
  })

  it('小类既不是字符串也不是空值 → invalid_service_item', async () => {
    await expect(
      validateWorkOrderInput({ ...validFields, serviceItem: 123 as unknown as null }, db),
    ).rejects.toMatchObject({ errorCode: 'invalid_service_item' })
  })

  it('客户不存在或已归档 → customer_not_found', async () => {
    await expect(validateWorkOrderInput({ ...validFields, customerId: 999 }, db))
      .rejects.toMatchObject({ errorCode: 'customer_not_found' })
    await db.customers.put(makeCustomer('sync-archived', 43, '2026-08-01T00:00:00Z'))
    await expect(validateWorkOrderInput({ ...validFields, customerId: 43 }, db))
      .rejects.toMatchObject({ errorCode: 'customer_not_found' })
  })

  it('业务日期无有效编号映射 → customer_mapping_invalid', async () => {
    await expect(validateWorkOrderInput({ ...validFields, workOrderDate: '2025-12-31' }, db))
      .rejects.toMatchObject({ errorCode: 'customer_mapping_invalid' })
  })

  it('大类不存在或停用 → service_option_disabled', async () => {
    await expect(validateWorkOrderInput({ ...validFields, serviceCategory: '不存在' }, db))
      .rejects.toMatchObject({ errorCode: 'service_option_disabled' })
    // 把"洗水"大类停用后，原合法大小类也变为不可用
    await db.serviceCategories.put({ ...makeCategory('sync-cat', '洗水'), isActive: false })
    await expect(validateWorkOrderInput(validFields, db))
      .rejects.toMatchObject({ errorCode: 'service_option_disabled' })
  })

  it('小类不属于所选大类 → service_item_mismatch；小类停用 → service_option_disabled', async () => {
    await expect(validateWorkOrderInput({ ...validFields, serviceItem: '不存在小类' }, db))
      .rejects.toMatchObject({ errorCode: 'service_item_mismatch' })
    await expect(validateWorkOrderInput({ ...validFields, serviceItem: '停用小类' }, db))
      .rejects.toMatchObject({ errorCode: 'service_option_disabled' })
  })

  it('小类为空（serviceItem: null）合法，不做大小类匹配', async () => {
    await expect(validateWorkOrderInput({ ...validFields, serviceItem: null }, db))
      .resolves.toBeUndefined()
  })
})

describe('buildCustomerWithMapping', () => {
  it('生成负 customerId（-parseInt(syncId.slice(5), 16)）且两次调用唯一', async () => {
    const input = {
      canonicalName: '新客户厂',
      customerCode: '007',
      customerName: '新客户',
      validFrom: '2026-01-01',
    }
    const cmd1 = await buildCustomerWithMapping(db, input)
    const cmd2 = await buildCustomerWithMapping(db, input)

    expect(cmd1.customerSyncId).toMatch(/^sync-[0-9a-f]{12}$/)
    expect(cmd1.customerId).toBeLessThan(0)
    expect(cmd1.customerId).toBe(-Number.parseInt(cmd1.customerSyncId.slice(5), 16))
    expect(cmd2.customerId).toBeLessThan(0)
    expect(cmd1.customerId).not.toBe(cmd2.customerId)
    expect(cmd1.customerSyncId).not.toBe(cmd2.customerSyncId)
  })

  it('两条 change 顺序固定：customer 在前、customer_code_mapping 在后，均带 entityType', async () => {
    const cmd = await buildCustomerWithMapping(db, {
      canonicalName: '新客户厂',
      customerCode: '007',
      customerName: '新客户',
      validFrom: '2026-01-01',
    })
    expect(cmd.operationType).toBe('create_customer_with_mapping')
    expect(cmd.changes).toHaveLength(2)
    expect(cmd.changes[0].entityType).toBe('customer')
    expect(cmd.changes[0].entitySyncId).toBe(cmd.customerSyncId)
    expect(cmd.changes[1].entityType).toBe('customer_code_mapping')
    expect(cmd.entitySyncIds).toEqual([
      cmd.customerSyncId,
      cmd.changes[1].entitySyncId,
    ])
    // customer change 必须携带负 customer_id（后端显式插入负主键）
    expect(cmd.changes[0].patch).toMatchObject({
      customer_id: cmd.customerId,
      canonical_name: '新客户厂',
    })
    // wire patch 使用 snake_case
    expect(cmd.changes[1].patch).toMatchObject({
      customer_id: cmd.customerId,
      customer_code: '007',
      customer_name: '新客户',
      valid_from: '2026-01-01',
    })
  })

  it('同编号区间重叠 → mapping_period_overlap（即时检查）', async () => {
    await db.customerCodeMappings.put(makeMapping('sync-map-existing', 1, '007', '2026-01-01', '2026-06-30'))
    await expect(
      buildCustomerWithMapping(db, {
        canonicalName: '新客户厂',
        customerCode: '007',
        customerName: '新客户',
        validFrom: '2026-06-01',
      }),
    ).rejects.toMatchObject({ errorCode: 'mapping_period_overlap' })
  })

  it('valid_to < valid_from → invalid_mapping_period', async () => {
    await expect(
      buildCustomerWithMapping(db, {
        canonicalName: '新客户厂',
        customerCode: '007',
        customerName: '新客户',
        validFrom: '2026-06-01',
        validTo: '2026-01-01',
      }),
    ).rejects.toMatchObject({ errorCode: 'invalid_mapping_period' })
  })

  it('客户名称为空 → invalid_customer_name', async () => {
    await expect(
      buildCustomerWithMapping(db, {
        canonicalName: '  ',
        customerCode: '007',
        customerName: '新客户',
        validFrom: '2026-01-01',
      }),
    ).rejects.toMatchObject({ errorCode: 'invalid_customer_name' })
  })

  it('commit 后业务表 / operations / outbox 三者一致', async () => {
    const cmd = await buildCustomerWithMapping(db, {
      canonicalName: '新客户厂',
      customerCode: '007',
      customerName: '新客户',
      validFrom: '2026-01-01',
    })
    await new MutationService(db).commit({
      operationType: cmd.operationType,
      entitySyncIds: cmd.entitySyncIds,
      changes: cmd.changes,
      apply: cmd.apply,
      actorType: 'user',
    })

    const customer = await db.customers.get(cmd.customerSyncId)
    expect(customer?.customerId).toBe(cmd.customerId)
    expect(customer?.canonicalName).toBe('新客户厂')
    expect(customer?.rowVersion).toBe(1)

    const mappings = await db.customerCodeMappings.toArray()
    expect(mappings).toHaveLength(1)
    expect(mappings[0].customerId).toBe(cmd.customerId)
    expect(mappings[0].validFrom).toBe('2026-01-01')

    const ops = await db.operations.toArray()
    expect(ops).toHaveLength(1)
    expect(ops[0].operationType).toBe('create_customer_with_mapping')
    expect(ops[0].syncStatus).toBe('pending')

    const outbox = await db.outbox.toArray()
    expect(outbox).toHaveLength(1)
    expect(outbox[0].operationId).toBe(ops[0].operationId)
    const changes = (outbox[0].command as { changes: { entityType?: string }[] }).changes
    expect(changes.map((c) => c.entityType)).toEqual(['customer', 'customer_code_mapping'])
  })
})

describe('createWorkOrder', () => {
  beforeEach(async () => {
    await seedBase()
  })

  it('commit 后业务表 / operations / outbox 一致，outbox 保存 snake_case wire patch', async () => {
    await createWorkOrder(db, validFields)

    const order = (await db.workOrders.toArray())[0]
    expect(order).toBeDefined()
    expect(order.accountPhone).toBe(PHONE)
    expect(order.rowVersion).toBe(1)
    expect(order.workOrderDate).toBe('2026-06-15')
    expect(order.serviceItem).toBe('单洗')
    expect(order.deletedAt).toBeNull()
    expect(order.createdAt).toBeTruthy()
    expect(order.updatedAt).toBeTruthy()

    const ops = await db.operations.toArray()
    expect(ops).toHaveLength(1)
    expect(ops[0].operationType).toBe('create_work_order')
    expect(ops[0].syncStatus).toBe('pending')

    const outbox = await db.outbox.toArray()
    expect(outbox).toHaveLength(1)
    expect(outbox[0].operationId).toBe(ops[0].operationId)
    const cmd = outbox[0].command as {
      changes: { entityType?: string; baseVersion: number; patch?: Record<string, unknown> }[]
    }
    expect(cmd.changes).toHaveLength(1)
    expect(cmd.changes[0].entityType).toBe('work_order')
    expect(cmd.changes[0].baseVersion).toBe(0)
    expect(cmd.changes[0].patch).toMatchObject({
      work_order_date: '2026-06-15',
      customer_id: 42,
      customer_code: '001',
      customer_name: '张三',
      service_category: '洗水',
      service_item: '单洗',
      quantity: 5,
      unit: '件',
      unit_price_cents: null,
    })
    // wire patch 不允许 camelCase 键
    expect(Object.keys(cmd.changes[0].patch!)).not.toContain('workOrderDate')
  })

  it('校验失败不写任何数据', async () => {
    await expect(createWorkOrder(db, { ...validFields, quantity: 0 }))
      .rejects.toMatchObject({ errorCode: 'invalid_quantity' })
    expect(await db.workOrders.count()).toBe(0)
    expect(await db.operations.count()).toBe(0)
    expect(await db.outbox.count()).toBe(0)
  })
})

describe('addCustomerCodeMapping / updateCustomerCodeMapping', () => {
  beforeEach(async () => {
    await db.customers.put(makeCustomer('sync-cust', 42))
  })

  it('add 提交后本地映射 rowVersion=1 且 outbox patch 为 snake_case', async () => {
    await addCustomerCodeMapping(db, {
      customerId: 42,
      customerCode: '008',
      customerName: '王五',
      validFrom: '2026-01-01',
      validTo: null,
    })
    const mapping = (await db.customerCodeMappings.toArray())[0]
    expect(mapping.customerId).toBe(42)
    expect(mapping.rowVersion).toBe(1)
    const cmd = (await db.outbox.toArray())[0].command as {
      changes: { entityType?: string; patch?: Record<string, unknown> }[]
    }
    expect(cmd.changes[0].entityType).toBe('customer_code_mapping')
    expect(cmd.changes[0].patch).toMatchObject({
      customer_id: 42,
      customer_code: '008',
      customer_name: '王五',
      valid_from: '2026-01-01',
    })
  })

  it('update 提交后本地更新，且重叠区间校验拒绝', async () => {
    await addCustomerCodeMapping(db, {
      customerId: 42,
      customerCode: '008',
      customerName: '王五',
      validFrom: '2026-01-01',
      validTo: '2026-06-30',
    })
    const existing = (await db.customerCodeMappings.toArray())[0]

    await updateCustomerCodeMapping(db, existing.syncId, { validTo: '2026-12-31' })
    expect((await db.customerCodeMappings.get(existing.syncId))?.validTo).toBe('2026-12-31')

    // 先把该映射收回到 2026-06-30，再新增一条 2026-07-01 起的衔接映射（合法）
    await updateCustomerCodeMapping(db, existing.syncId, { validTo: '2026-06-30' })
    await addCustomerCodeMapping(db, {
      customerId: 42,
      customerCode: '008',
      customerName: '李四',
      validFrom: '2026-07-01',
      validTo: null,
    })
    const second = (await db.customerCodeMappings.toArray()).find((m) => m.syncId !== existing.syncId)!
    // 把第二条改成 2026-06-01 起 → 与第一条（到 2026-06-30）重叠
    await expect(updateCustomerCodeMapping(db, second.syncId, { validFrom: '2026-06-01' }))
      .rejects.toMatchObject({ errorCode: 'mapping_period_overlap' })
  })
})

describe('archiveCustomerWithMappings', () => {
  it('归档客户并把该客户所有开放映射 valid_to 置为归档日，闭合映射不动', async () => {
    await db.customers.put(makeCustomer('sync-cust', 42))
    await db.customerCodeMappings.put(makeMapping('sync-map-open1', 42, '001', '2026-01-01', null))
    await db.customerCodeMappings.put(makeMapping('sync-map-open2', 42, '002', '2026-01-01', null))
    await db.customerCodeMappings.put(makeMapping('sync-map-closed', 42, '003', '2025-01-01', '2025-12-31'))

    await archiveCustomerWithMappings(db, 'sync-cust')

    const customer = await db.customers.get('sync-cust')
    expect(customer?.archivedAt).toBeTruthy()
    const today = new Date().toISOString().slice(0, 10)
    expect(customer?.archivedAt).toBe(today)

    expect((await db.customerCodeMappings.get('sync-map-open1'))?.validTo).toBe(today)
    expect((await db.customerCodeMappings.get('sync-map-open2'))?.validTo).toBe(today)
    expect((await db.customerCodeMappings.get('sync-map-closed'))?.validTo).toBe('2025-12-31')

    const outbox = (await db.outbox.toArray())[0]
    expect(outbox.operationType).toBe('archive_customer_with_mappings')
    const changes = (outbox.command as {
      changes: { entityType?: string; entitySyncId: string; patch?: Record<string, unknown> }[]
    }).changes
    // 只有两条开放映射需要收尾；闭合映射不产生 change
    expect(changes.map((c) => c.entityType)).toEqual([
      'customer',
      'customer_code_mapping',
      'customer_code_mapping',
    ])
    expect(changes[0].patch).toMatchObject({ archived_at: today })
    expect(changes[1].patch).toMatchObject({ valid_to: today })
  })

  it('客户不存在或已归档 → customer_not_found', async () => {
    await expect(archiveCustomerWithMappings(db, 'sync-nope')).rejects
      .toMatchObject({ errorCode: 'customer_not_found' })
  })
})

describe('createServiceCategory / updateServiceCategory（subcategoriesJson 序列化）', () => {
  it('createServiceCategory 本地存数组，outbox patch 存 JSON 字符串', async () => {
    await createServiceCategory(db, {
      categoryName: '洗水',
      subcategories: [
        { name: '单洗', defaultUnit: '件', isActive: true },
        { name: '烘件染', defaultUnit: '件', isActive: false },
      ],
    })

    const local = (await db.serviceCategories.toArray())[0]
    expect(Array.isArray(local.subcategoriesJson)).toBe(true)
    expect(local.subcategoriesJson).toHaveLength(2)
    expect(local.isActive).toBe(true)
    expect(local.rowVersion).toBe(1)

    const cmd = (await db.outbox.toArray())[0].command as {
      changes: { entityType?: string; patch?: Record<string, unknown> }[]
    }
    expect(cmd.changes[0].entityType).toBe('service_category')
    expect(cmd.changes[0].patch?.subcategories_json).toBe(
      JSON.stringify([
        { name: '单洗', defaultUnit: '件', isActive: true },
        { name: '烘件染', defaultUnit: '件', isActive: false },
      ]),
    )
  })

  it('updateServiceCategory 本地更新为数组，outbox patch 的 subcategories_json 为字符串', async () => {
    await db.serviceCategories.put(makeCategory('sync-cat', '洗水'))
    await updateServiceCategory(db, 'sync-cat', {
      subcategories: [
        { name: '单洗', defaultUnit: '件', isActive: true },
        { name: '洗烘一体', defaultUnit: '件', isActive: true },
      ],
    })

    const local = await db.serviceCategories.get('sync-cat')
    expect(Array.isArray(local?.subcategoriesJson)).toBe(true)
    expect(local?.subcategoriesJson.map((s) => s.name)).toEqual(['单洗', '洗烘一体'])

    const cmd = (await db.outbox.toArray())[0].command as {
      changes: { entityType?: string; baseVersion: number; patch?: Record<string, unknown> }[]
    }
    expect(cmd.changes[0].entityType).toBe('service_category')
    expect(cmd.changes[0].baseVersion).toBe(1)
    expect(cmd.changes[0].patch?.subcategories_json).toBe(
      JSON.stringify([
        { name: '单洗', defaultUnit: '件', isActive: true },
        { name: '洗烘一体', defaultUnit: '件', isActive: true },
      ]),
    )
  })

  it('validateServiceCategoryInput：大类重名 / 小类结构 / 小类重名', async () => {
    await db.serviceCategories.put(makeCategory('sync-cat', '洗水'))
    await expect(validateServiceCategoryInput(db, { categoryName: '洗水' }))
      .rejects.toMatchObject({ errorCode: 'category_name_duplicate' })
    await expect(
      validateServiceCategoryInput(db, {
        categoryName: '新大类',
        subcategories: [{ defaultUnit: '件' } as never],
      }),
    ).rejects.toMatchObject({ errorCode: 'invalid_subcategories' })
    await expect(
      validateServiceCategoryInput(db, {
        categoryName: '新大类',
        subcategories: [
          { name: '单洗', defaultUnit: '件', isActive: true },
          { name: '单洗', defaultUnit: '件', isActive: false },
        ],
      }),
    ).rejects.toMatchObject({ errorCode: 'subcategory_name_duplicate' })
  })
})
