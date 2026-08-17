import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { CbDatabase } from '../db/schema'
import type { Customer } from '../db/schema/business/customers'
import type { CustomerCodeMapping } from '../db/schema/business/customerCodeMappings'
import type { ServiceCategory } from '../db/schema/business/serviceCategories'
import type { WorkOrder } from '../db/schema/business/workOrders'
import { MutationService } from './mutation'
import {
  buildAiBatchOperation,
  prepareAiDraftBatch,
  type AiDraftCall,
} from './chatApprovalBatch'

// 被测缝：AI 批量草案审核服务。
// 1. prepareAiDraftBatch：严格字段白名单、本地即时业务校验、客户编号快照解析、修改前后差异。
// 2. buildAiBatchOperation：把用户批准的 1~20 条草案组成一条原子 MutationInput。

const PHONE = '13800000000'
let db: CbDatabase

function customer(customerId = 1): Customer {
  return {
    syncId: `sync-customer-${customerId}`,
    accountPhone: PHONE,
    customerId,
    canonicalName: '甲厂正式名称',
    rowVersion: 1,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    archivedAt: null,
  }
}

function mapping(customerId = 1): CustomerCodeMapping {
  return {
    syncId: `sync-mapping-${customerId}`,
    accountPhone: PHONE,
    customerId,
    customerCode: '018',
    customerName: '王师',
    validFrom: '2026-08-01',
    validTo: null,
    rowVersion: 1,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
  }
}

function category(): ServiceCategory {
  return {
    syncId: 'sync-category-1',
    accountPhone: PHONE,
    categoryName: '水洗',
    subcategoriesJson: [{ name: '床单', defaultUnit: '件', isActive: true }],
    isActive: true,
    rowVersion: 1,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
  }
}

function order(syncId = 'sync-order-1'): WorkOrder {
  return {
    syncId,
    accountPhone: PHONE,
    workOrderDate: '2026-08-16',
    customerId: 1,
    customerCode: '018',
    customerName: '王师',
    serviceCategory: '水洗',
    serviceItem: '床单',
    quantity: 8,
    unit: '件',
    unitPriceCents: null,
    isCompleted: false,
    rowVersion: 3,
    createdAt: '2026-08-16T14:32:00Z',
    updatedAt: '2026-08-16T14:32:00Z',
    deletedAt: null,
  }
}

function createCall(id: string, overrides: Record<string, unknown> = {}): AiDraftCall {
  return {
    toolCallId: id,
    toolName: 'create_work_order',
    draft: {
      fields: {
        work_order_date: '2026-08-17',
        customer_id: 1,
        service_category: '水洗',
        service_item: '床单',
        quantity: 10,
        unit: '件',
        ...overrides,
      },
    },
  }
}

beforeEach(async () => {
  db = createBusinessDb(PHONE)
  await db.delete()
  await db.open()
  await db.customers.put(customer())
  await db.customerCodeMappings.put(mapping())
  await db.serviceCategories.put(category())
})

describe('prepareAiDraftBatch', () => {
  it('新建草案根据 customer_id + 工单日期解析编号和名称，并补默认未定价/未完成', async () => {
    const result = await prepareAiDraftBatch(db, [createCall('call-1')])

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      toolCallId: 'call-1',
      kind: 'create',
      fields: {
        work_order_date: '2026-08-17',
        customer_id: 1,
        customer_code: '018',
        customer_name: '王师',
        unit_price_cents: null,
        is_completed: 0,
      },
    })
    expect(result[0].entitySyncId).toMatch(/^sync-[0-9a-f]{12}$/)
  })

  it('接受后端派生且与本地映射一致的客户快照，拒绝不一致快照', async () => {
    const prepared = await prepareAiDraftBatch(db, [createCall('call-normalized', {
      customer_code: '018',
      customer_name: '王师',
    })])
    expect(prepared[0].fields).toMatchObject({ customer_code: '018', customer_name: '王师' })

    await expect(prepareAiDraftBatch(db, [createCall('call-mismatch', {
      customer_code: '999',
      customer_name: '错误名称',
    })])).rejects.toMatchObject({ code: 'ai_draft_customer_snapshot_mismatch' })
  })

  it('未知字段或元字段直接拒绝，不生成可提交草案', async () => {
    for (const field of ['deleted_at', 'created_at', 'row_version', 'work_order_id']) {
      await expect(
        prepareAiDraftBatch(db, [createCall(`call-${field}`, { [field]: 'tampered' })]),
      ).rejects.toMatchObject({
        code: 'ai_draft_field_forbidden',
        toolCallId: `call-${field}`,
      })
    }
    expect(await db.outbox.count()).toBe(0)
  })

  it('修改草案生成修改前摘要和真正变化的字段，忽略未变化字段', async () => {
    await db.workOrders.put(order())
    const result = await prepareAiDraftBatch(db, [{
      toolCallId: 'call-update',
      toolName: 'update_work_order',
      draft: {
        entity_sync_id: 'sync-order-1',
        base_version: 3,
        fields: { quantity: 12, unit: '件', is_completed: 1 },
      },
    }])

    expect(result[0]).toMatchObject({
      kind: 'update',
      before: { quantity: 8, unit: '件', is_completed: 0 },
      fields: { quantity: 12, is_completed: 1 },
    })
    expect(result[0].fields).not.toHaveProperty('unit')
  })

  it('修改没有任何实际变化时拒绝', async () => {
    await db.workOrders.put(order())
    await expect(prepareAiDraftBatch(db, [{
      toolCallId: 'call-noop',
      toolName: 'update_work_order',
      draft: {
        entity_sync_id: 'sync-order-1',
        base_version: 3,
        fields: { quantity: 8 },
      },
    }])).rejects.toMatchObject({ code: 'ai_draft_no_changes' })
  })

  it('一次最多接受 20 张草案', async () => {
    const calls = Array.from({ length: 21 }, (_, index) => createCall(`call-${index}`))
    await expect(prepareAiDraftBatch(db, calls)).rejects.toMatchObject({
      code: 'ai_draft_batch_too_large',
    })
  })
})

describe('buildAiBatchOperation', () => {
  it('批准项组成一条原子 AI 操作并一次写入 outbox', async () => {
    await db.workOrders.put(order())
    const prepared = await prepareAiDraftBatch(db, [
      createCall('call-create'),
      {
        toolCallId: 'call-update',
        toolName: 'update_work_order',
        draft: {
          entity_sync_id: 'sync-order-1',
          base_version: 3,
          fields: { quantity: 12 },
        },
      },
    ])

    const input = buildAiBatchOperation('turn-000000000001', prepared)
    expect(input.operationType).toBe('ai_batch_work_orders')
    expect(input.actorType).toBe('ai')
    expect(input.sourceTurnId).toBe('turn-000000000001')
    expect(input.changes).toHaveLength(2)

    await new MutationService(db).commit(input)

    expect(await db.outbox.count()).toBe(1)
    const outbox = await db.outbox.toCollection().first()
    expect((outbox?.command as { changes: unknown[] }).changes).toHaveLength(2)
    expect((await db.workOrders.get('sync-order-1'))?.quantity).toBe(12)
    const created = await db.workOrders.get(prepared[0].entitySyncId)
    expect(created).toMatchObject({ customerCode: '018', customerName: '王师', quantity: 10 })
  })
})
