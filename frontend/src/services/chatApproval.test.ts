import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { CbDatabase } from '../db/schema'
import type { WorkOrder } from '../db/schema/business/workOrders'
import { buildAiOperationFromDraft, notConnectedApprovalUi } from './chatApproval'
import { MutationService } from './mutation'

// 被测缝：chatApproval（docs/spec/agent-tools.md §8）
// 验证：
// 1. notConnectedApprovalUi.requestApproval 恒为 false（没有确认 UI 就没有任何写操作）。
// 2. buildAiOperationFromDraft 把写工具草案补齐为可直接喂给 MutationService.commit 的 MutationInput：
//    operationId 由 commit 生成；这里补齐 entitySyncIds/actorType='ai'/sourceTurnId，
//    create 的 entity_sync_id 为 null 时生成 sync-<12hex> 且 baseVersion=0，
//    update 必须携带数字 base_version，形状不合法返回 null。
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
  operation_type: 'create_work_order',
  changes: [
    {
      entity_type: 'work_order',
      entity_sync_id: null,
      base_version: 0,
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
    },
  ],
}

let db: CbDatabase

beforeEach(async () => {
  db = createBusinessDb(PHONE)
  await db.delete()
  await db.open()
})

describe('notConnectedApprovalUi', () => {
  it('requestApproval 恒为 false（拒绝草案，不提交、不发 approve）', async () => {
    await expect(notConnectedApprovalUi.requestApproval(createDraft)).resolves.toBe(false)
    await expect(notConnectedApprovalUi.requestApproval(null)).resolves.toBe(false)
  })
})

describe('buildAiOperationFromDraft', () => {
  it('create：补齐 actorType/sourceTurnId，entity_sync_id 为 null 时生成 sync-<12hex> 且 baseVersion=0', async () => {
    const input = buildAiOperationFromDraft('turn-000000000001', createDraft)

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
    expect(input?.changes?.[0].patch).toEqual(createDraft.changes[0].fields)
    expect(typeof input?.apply).toBe('function')

    // apply 闭包复用 applyWorkOrderPatch：提交后本地落新工单行
    await new MutationService(db).commit(input!)
    const row = await db.workOrders.get(syncId!)
    expect(row).toMatchObject({ syncId, accountPhone: PHONE, quantity: 5, rowVersion: 1 })
    const outbox = await db.outbox.toArray()
    expect(outbox).toHaveLength(1)
    expect(outbox[0].actorType).toBe('ai')
    expect(outbox[0].sourceTurnId).toBe('turn-000000000001')
  })

  it('create：entity_sync_id 为字符串时直接使用，不重新生成', () => {
    const draft = {
      operation_type: 'create_work_order',
      changes: [
        {
          entity_type: 'work_order',
          entity_sync_id: 'sync-provided0001',
          base_version: 0,
          fields: { quantity: 5 },
        },
      ],
    }
    const input = buildAiOperationFromDraft('turn-1', draft)

    expect(input?.entitySyncIds).toEqual(['sync-provided0001'])
    expect(input?.changes?.[0]).toMatchObject({
      entitySyncId: 'sync-provided0001',
      baseVersion: 0,
    })
  })

  it('update：使用 draft 的数字 base_version，apply 合并字段到现有工单', async () => {
    await db.workOrders.put(makeWorkOrder('sync-existing'))
    const draft = {
      operation_type: 'update_work_order',
      changes: [
        {
          entity_type: 'work_order',
          entity_sync_id: 'sync-existing',
          base_version: 1,
          fields: { quantity: 12 },
        },
      ],
    }

    const input = buildAiOperationFromDraft('turn-000000000002', draft)

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

  it('update：base_version 缺失或非数字 → null', () => {
    const base = {
      operation_type: 'update_work_order',
      changes: [
        { entity_type: 'work_order', entity_sync_id: 'sync-existing', fields: { quantity: 12 } },
      ],
    }
    expect(buildAiOperationFromDraft('turn-1', base)).toBeNull()
    expect(
      buildAiOperationFromDraft('turn-1', {
        ...base,
        changes: [{ ...base.changes[0], base_version: '1' }],
      }),
    ).toBeNull()
  })

  it('缺 fields / changes 非单条 / entity_type 非 work_order → null', () => {
    expect(
      buildAiOperationFromDraft('turn-1', {
        operation_type: 'create_work_order',
        changes: [{ entity_type: 'work_order', entity_sync_id: null, base_version: 0 }],
      }),
    ).toBeNull()
    expect(
      buildAiOperationFromDraft('turn-1', {
        operation_type: 'create_work_order',
        changes: [],
      }),
    ).toBeNull()
    expect(
      buildAiOperationFromDraft('turn-1', {
        operation_type: 'create_work_order',
        changes: [
          { entity_type: 'customer', entity_sync_id: null, base_version: 0, fields: {} },
        ],
      }),
    ).toBeNull()
  })

  it('错误的 operation_type → null', () => {
    expect(
      buildAiOperationFromDraft('turn-1', {
        operation_type: 'delete_work_order',
        changes: [{ entity_type: 'work_order', entity_sync_id: null, base_version: 0, fields: {} }],
      }),
    ).toBeNull()
  })
})
