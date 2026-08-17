import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { CbDatabase } from '../db/schema'
import type { Customer } from '../db/schema/business/customers'
import type { CustomerCodeMapping } from '../db/schema/business/customerCodeMappings'
import type { ServiceCategory } from '../db/schema/business/serviceCategories'
import type { WorkOrder } from '../db/schema/business/workOrders'
import { buildAiOperationFromDraft } from './chatApproval'
import { MutationService } from './mutation'

// 被测缝：单条 AI 草案兼容入口。必须复用批量草案的严格校验，不能恢复旧的任意 fields 通道。

const PHONE = '13800000000'
let db: CbDatabase

beforeEach(async () => {
  db = createBusinessDb(PHONE)
  await db.delete()
  await db.open()
  const customer: Customer = {
    syncId: 'sync-customer-1', accountPhone: PHONE, customerId: 1,
    canonicalName: '甲厂', rowVersion: 1,
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', archivedAt: null,
  }
  const mapping: CustomerCodeMapping = {
    syncId: 'sync-mapping-1', accountPhone: PHONE, customerId: 1,
    customerCode: '018', customerName: '王师', validFrom: '2026-08-01', validTo: null,
    rowVersion: 1, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
  }
  const category: ServiceCategory = {
    syncId: 'sync-category-1', accountPhone: PHONE, categoryName: '水洗',
    subcategoriesJson: [{ name: '床单', defaultUnit: '件', isActive: true }],
    isActive: true, rowVersion: 1,
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
  }
  await db.customers.put(customer)
  await db.customerCodeMappings.put(mapping)
  await db.serviceCategories.put(category)
})

describe('buildAiOperationFromDraft', () => {
  it('合法新建草案派生客户快照并通过 MutationService 原子落盘', async () => {
    const input = await buildAiOperationFromDraft(db, 'turn-1', 'create_work_order', {
      fields: {
        work_order_date: '2026-08-17', customer_id: 1,
        service_category: '水洗', service_item: '床单', quantity: 10, unit: '件',
      },
    })
    expect(input).not.toBeNull()
    expect(input?.actorType).toBe('ai')
    expect(input?.sourceTurnId).toBe('turn-1')
    expect(input?.changes?.[0].patch).toMatchObject({
      customer_code: '018', customer_name: '王师', unit_price_cents: null, is_completed: 0,
    })

    await new MutationService(db).commit(input!)
    expect(await db.workOrders.count()).toBe(1)
    expect(await db.outbox.count()).toBe(1)
  })

  it('元字段、未知字段和模型提供的同步 ID 均返回 null', async () => {
    for (const draft of [
      { fields: { deleted_at: '2026-08-17T00:00:00Z' } },
      { fields: { created_at: '2000-01-01T00:00:00Z' } },
      { fields: { work_order_id: 9 } },
      { entity_sync_id: 'sync-model-id', fields: {} },
    ]) {
      expect(await buildAiOperationFromDraft(db, 'turn-1', 'create_work_order', draft)).toBeNull()
    }
    expect(await db.outbox.count()).toBe(0)
  })

  it('修改目标使用本地快照，版本不一致或没有实际变化时返回 null', async () => {
    const row: WorkOrder = {
      syncId: 'sync-order-1', accountPhone: PHONE, workOrderDate: '2026-08-16',
      customerId: 1, customerCode: '018', customerName: '王师',
      serviceCategory: '水洗', serviceItem: '床单', quantity: 8, unit: '件',
      unitPriceCents: null, isCompleted: false, rowVersion: 3,
      createdAt: '2026-08-16T14:32:00Z', updatedAt: '2026-08-16T14:32:00Z', deletedAt: null,
    }
    await db.workOrders.put(row)

    expect(await buildAiOperationFromDraft(db, 'turn-1', 'update_work_order', {
      entity_sync_id: row.syncId, base_version: 2, fields: { quantity: 12 },
    })).toBeNull()
    expect(await buildAiOperationFromDraft(db, 'turn-1', 'update_work_order', {
      entity_sync_id: row.syncId, base_version: 3, fields: { quantity: 8 },
    })).toBeNull()
  })
})
