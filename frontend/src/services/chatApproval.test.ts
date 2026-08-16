import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { CbDatabase } from '../db/schema'
import type { WorkOrder } from '../db/schema/business/workOrders'
import { buildAiOperationFromDraft } from './chatApproval'
import { MutationService } from './mutation'

// 被测缝：chatApproval（docs/spec/agent-tools.md §8）
// 验证：
// 1. buildAiOperationFromDraft(db, turnId, toolName, draft) 把后端工具原始参数 draft（§5.6）
//    补齐为可直接喂给 MutationService.commit 的 MutationInput：
//    toolName 推导 operationType；entityType='work_order'；actorType='ai'；sourceTurnId=turnId；
//    create 的 entity_sync_id 为 null 时生成 sync-<12hex> 且 baseVersion=0；
//    update 要求 entity_sync_id 为字符串、base_version 为正整数；形状不合法返回 null。
// 2. update 分支从本地库读行补 baseSnapshot（终审前置项②）；行不存在返回 null。
// 3. apply 闭包复用 businessCommands.applyWorkOrderPatch：create 落新行、update 合并字段。

const PHONE = '13800000000'

function makeWorkOrder(syncId: string): WorkOrder {
  return {
    syncId,
    accountPhone: PHONE,
    workOrderDate: '2026-06-15',
    customerId: 1,
    customerCode: '001',
    customerName: '张三',
    serviceCategory: '洗水',
    serviceItem: null,
    quantity: 5,
    unit: '件',
    unitPriceCents: null,
    isCompleted: false,
    rowVersion: 1,
    createdAt: '2026-08-14T00:00:00Z',
    updatedAt: '2026-08-14T00:00:00Z',
    deletedAt: null,
  }
}

const createDraft = {
  entity_sync_id: null,
  fields: {
    work_order_date: '2026-06-15',
    customer_id: 1,
    customer_code: '001',
    customer_name: '张三',
    service_category: '洗水',
    service_item: null,
    quantity: 5,
    unit: '件',
    unit_price_cents: null,
  },
}

let db: CbDatabase

beforeEach(async () => {
  db = createBusinessDb(PHONE)
  await db.delete()
  await db.open()
})

describe('buildAiOperationFromDraft', () => {
  it('create：补齐 actorType/sourceTurnId，entity_sync_id 为 null 时生成 sync-<12hex> 且 baseVersion=0', async () => {
    const input = await buildAiOperationFromDraft(db, 'turn-000000000001', 'create_work_order', createDraft)

    expect(input).not.toBeNull()
    expect(input?.operationType).toBe('create_work_order')
    expect(input?.actorType).toBe('ai')
    expect(input?.sourceTurnId).toBe('turn-000000000001')
    expect(input?.entitySyncIds).toHaveLength(1)
    const syncId = input?.entitySyncIds[0]
    expect(syncId).toMatch(/^sync-[0-9a-f]{12}$/)
    expect(input?.changes).toHaveLength(1)
    expect(input?.changes?.[0]).toMatchObject({
      entitySyncId: syncId,
      entityType: 'work_order',
      baseVersion: 0,
      baseSnapshot: {},
    })
    expect(input?.changes?.[0].patch).toEqual(createDraft.fields)
    expect(typeof input?.apply).toBe('function')
    // 返回对象本身不含 operationId（由 MutationService.commit 生成）
    expect('operationId' in (input as unknown as Record<string, unknown>)).toBe(false)

    // apply 闭包复用 applyWorkOrderPatch：提交后本地落新工单行
    await new MutationService(db).commit(input!)
    const row = await db.workOrders.get(syncId!)
    expect(row).toMatchObject({ syncId, accountPhone: PHONE, quantity: 5, rowVersion: 1 })
    const outbox = await db.outbox.toArray()
    expect(outbox).toHaveLength(1)
    expect(outbox[0].actorType).toBe('ai')
    expect(outbox[0].sourceTurnId).toBe('turn-000000000001')
  })

  it('create：entity_sync_id 为字符串时直接使用，不重新生成', async () => {
    const draft = {
      entity_sync_id: 'sync-provided0001',
      fields: { quantity: 5 },
    }
    const input = await buildAiOperationFromDraft(db, 'turn-1', 'create_work_order', draft)

    expect(input?.entitySyncIds).toEqual(['sync-provided0001'])
    expect(input?.changes?.[0]).toMatchObject({
      entitySyncId: 'sync-provided0001',
      baseVersion: 0,
    })
  })

  it('create：entity_sync_id 非 null/字符串 → null', async () => {
    expect(
      await buildAiOperationFromDraft(db, 'turn-1', 'create_work_order', {
        entity_sync_id: 123,
        fields: {},
      }),
    ).toBeNull()
    expect(
      await buildAiOperationFromDraft(db, 'turn-1', 'create_work_order', { fields: {} }),
    ).toBeNull()
  })

  it('update：使用 draft 的正整数 base_version，apply 合并字段到现有工单', async () => {
    await db.workOrders.put(makeWorkOrder('sync-existing'))
    const draft = {
      entity_sync_id: 'sync-existing',
      base_version: 1,
      fields: { quantity: 12 },
    }

    const input = await buildAiOperationFromDraft(db, 'turn-000000000002', 'update_work_order', draft)

    expect(input).not.toBeNull()
    expect(input?.operationType).toBe('update_work_order')
    expect(input?.entitySyncIds).toEqual(['sync-existing'])
    expect(input?.changes?.[0]).toMatchObject({
      entitySyncId: 'sync-existing',
      entityType: 'work_order',
      baseVersion: 1,
    })
    expect(input?.changes?.[0].patch).toEqual({ quantity: 12 })

    await new MutationService(db).commit(input!)
    const row = await db.workOrders.get('sync-existing')
    expect(row?.quantity).toBe(12)
    expect((await db.outbox.toArray())[0].actorType).toBe('ai')
  })

  it('update：本地行存在时 change 带完整 baseSnapshot（wire snake_case）', async () => {
    await db.workOrders.put(makeWorkOrder('sync-existing'))
    const draft = {
      entity_sync_id: 'sync-existing',
      base_version: 1,
      fields: { quantity: 12 },
    }

    const input = await buildAiOperationFromDraft(db, 'turn-1', 'update_work_order', draft)

    expect(input?.changes?.[0].baseSnapshot).toMatchObject({
      sync_id: 'sync-existing',
      quantity: 5,
      unit: '件',
      row_version: 1,
      customer_id: 1,
    })
  })

  it('update：本地行不存在 → null（不允许对不存在记录补空 Base）', async () => {
    const draft = {
      entity_sync_id: 'sync-missing',
      base_version: 1,
      fields: { quantity: 12 },
    }
    expect(await buildAiOperationFromDraft(db, 'turn-1', 'update_work_order', draft)).toBeNull()
  })

  it('update：base_version 非正整数（NaN/Infinity/0/1.5/-1/字符串/缺失）→ null', async () => {
    await db.workOrders.put(makeWorkOrder('sync-existing'))
    const valid = {
      entity_sync_id: 'sync-existing',
      base_version: 1,
      fields: { quantity: 12 },
    }
    for (const bad of [NaN, Infinity, 0, 1.5, -1, '1', null, undefined]) {
      expect(
        await buildAiOperationFromDraft(db, 'turn-1', 'update_work_order', {
          ...valid,
          base_version: bad,
        }),
      ).toBeNull()
    }
    expect(
      await buildAiOperationFromDraft(db, 'turn-1', 'update_work_order', {
        entity_sync_id: 'sync-existing',
        fields: { quantity: 12 },
      }),
    ).toBeNull()
  })

  it('update：entity_sync_id 非字符串 → null', async () => {
    expect(
      await buildAiOperationFromDraft(db, 'turn-1', 'update_work_order', {
        entity_sync_id: 123,
        base_version: 1,
        fields: {},
      }),
    ).toBeNull()
  })

  it('缺 fields / fields 非对象 / 错误 toolName / 非对象 draft → null', async () => {
    expect(
      await buildAiOperationFromDraft(db, 'turn-1', 'create_work_order', {
        entity_sync_id: null,
      }),
    ).toBeNull()
    expect(
      await buildAiOperationFromDraft(db, 'turn-1', 'create_work_order', {
        entity_sync_id: null,
        fields: 'bad',
      }),
    ).toBeNull()
    expect(
      await buildAiOperationFromDraft(db, 'turn-1', 'create_work_order', {
        entity_sync_id: null,
        fields: [],
      }),
    ).toBeNull()
    expect(
      await buildAiOperationFromDraft(db, 'turn-1', 'delete_work_order', {
        entity_sync_id: null,
        fields: {},
      }),
    ).toBeNull()
    expect(await buildAiOperationFromDraft(db, 'turn-1', 'create_work_order', null)).toBeNull()
    expect(await buildAiOperationFromDraft(db, 'turn-1', 'create_work_order', 'draft')).toBeNull()
  })
})
