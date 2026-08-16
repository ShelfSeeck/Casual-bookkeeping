import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { CbDatabase } from '../db/schema'
import type { WorkOrder } from '../db/schema/business/workOrders'
import type { OutboxEntry } from '../db/schema/operations/outbox'
import { MutationService, RecordGatedError, type MutationInput } from './mutation'

// 被测缝：MutationService.commit()
// 验证：一次提交在同一个 IndexedDB 事务中原子写入 业务表 + operations + outbox；
//      事务中途失败则三处全部回滚（无部分写入）。
// 为什么测这里：本地写入事务是 data-model.md §6.1 的核心，破坏它会导致"本地已保存但同步丢失"。

const PHONE_A = '13800000000'

function makeOrder(syncId: string): WorkOrder {
  return {
    syncId,
    accountPhone: PHONE_A,
    workOrderDate: '2026-08-08',
    customerId: 1,
    customerCode: '001',
    customerName: '张三',
    serviceCategory: '洗水',
    serviceItem: '单洗',
    quantity: 5,
    unit: '件',
    unitPriceCents: null,
    isCompleted: false,
    rowVersion: 0,
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
    deletedAt: null,
  }
}

let db: CbDatabase
let svc: MutationService

function makeOutbox(overrides: Partial<OutboxEntry> = {}): Omit<OutboxEntry, 'queueId'> {
  return {
    operationId: 'op-conflict',
    operationType: 'update_work_order',
    entitySyncIds: ['sync-a'],
    command: { changes: [{ entitySyncId: 'sync-a', baseVersion: 1, patch: {} }] },
    status: 'conflict',
    attempts: 0,
    nextRetryAt: null,
    sendingStartedAt: null,
    lastErrorJson: null,
    actorType: 'user',
    sourceTurnId: null,
    conflictJson: { theirs: { row_version: 2 } },
    createdAt: '2026-08-08T00:00:00Z',
    ...overrides,
  }
}

beforeEach(async () => {
  db = createBusinessDb(PHONE_A)
  await db.delete()
  await db.open()
  svc = new MutationService(db)
})

describe('MutationService.commit', () => {
  it('一次提交同时写入 workOrders、operations、outbox', async () => {
    const order = makeOrder('sync-a')
    const input: MutationInput = {
      operationType: 'create_work_order',
      entitySyncIds: ['sync-a'],
      apply: (tx) => tx.workOrders.put(order),
      actorType: 'user',
    }
    await svc.commit(input)

    expect(await db.workOrders.get('sync-a')).toBeDefined()

    const ops = await db.operations.toArray()
    expect(ops).toHaveLength(1)
    expect(ops[0].syncStatus).toBe('pending')
    expect(ops[0].actorType).toBe('user')

    const outbox = await db.outbox.toArray()
    expect(outbox).toHaveLength(1)
    expect(outbox[0].operationId).toBe(ops[0].operationId)
    expect(outbox[0].entitySyncIds).toEqual(['sync-a'])
    expect(outbox[0].status).toBe('pending')
  })

  it('operationId 生成格式 op- + 12 位十六进制', async () => {
    const input: MutationInput = {
      operationType: 'create_work_order',
      entitySyncIds: ['sync-a'],
      apply: (tx) => tx.workOrders.put(makeOrder('sync-a')),
      actorType: 'user',
    }
    await svc.commit(input)
    const ops = await db.operations.toArray()
    expect(ops[0].operationId).toMatch(/^op-[0-9a-f]{12}$/)
  })

  it('commit 返回 operationId，且与 operations / outbox 中的 operationId 一致', async () => {
    const input: MutationInput = {
      operationType: 'create_work_order',
      entitySyncIds: ['sync-a'],
      apply: (tx) => tx.workOrders.put(makeOrder('sync-a')),
      actorType: 'user',
    }
    const operationId = await svc.commit(input)

    expect(operationId).toMatch(/^op-[0-9a-f]{12}$/)
    const ops = await db.operations.toArray()
    expect(operationId).toBe(ops[0].operationId)
    const outbox = await db.outbox.toArray()
    expect(operationId).toBe(outbox[0].operationId)
  })

  it('apply 抛错时三表全部回滚，无部分写入', async () => {
    const input: MutationInput = {
      operationType: 'create_work_order',
      entitySyncIds: ['sync-a'],
      apply: () => {
        throw new Error('boom')
      },
      actorType: 'user',
    }
    await expect(svc.commit(input)).rejects.toThrow('boom')

    expect(await db.workOrders.get('sync-a')).toBeUndefined()
    expect(await db.operations.count()).toBe(0)
    expect(await db.outbox.count()).toBe(0)
  })
})

describe('MutationService 跨实体 entityType 保留（docs/spec/business-p0p1.md §5.6）', () => {
  it('commit 把 change.entityType 原样写入 outbox.command.changes', async () => {
    const input: MutationInput = {
      operationType: 'create_customer_with_mapping',
      entitySyncIds: ['sync-cust', 'sync-map'],
      changes: [
        { entitySyncId: 'sync-cust', baseVersion: 0, entityType: 'customer', patch: {} },
        { entitySyncId: 'sync-map', baseVersion: 0, entityType: 'customer_code_mapping', patch: {} },
      ],
      apply: () => undefined,
      actorType: 'user',
    }
    await svc.commit(input)

    const outbox = (await db.outbox.toArray())[0]
    const command = outbox.command as {
      changes: { entitySyncId: string; entityType?: string }[]
    }
    expect(command.changes.map((c) => c.entityType)).toEqual([
      'customer',
      'customer_code_mapping',
    ])
  })
})

describe('MutationService 撤回操作（docs/data-model.md §6.5）', () => {
  it('撤回操作 commit 后，operations 记录 revertsOperationId，outbox.command 含 reverts_operation_id', async () => {
    // 验证：撤回是普通操作，走同一本地事务；前端只提交"撤回哪条原操作"的意图，
    // 反向 patch 由服务端根据 before_json 生成（§6.5）。所以 operations 存 camelCase
    // revertsOperationId，outbox.command 存 wire 形状 snake_case reverts_operation_id。
    const input: MutationInput = {
      operationType: 'revert_work_order',
      entitySyncIds: ['sync-a'],
      revertsOperationId: 'op-100',
      apply: (tx) => tx.workOrders.put(makeOrder('sync-a')),
      actorType: 'user',
    }
    await svc.commit(input)

    const ops = await db.operations.toArray()
    expect(ops).toHaveLength(1)
    expect(ops[0].revertsOperationId).toBe('op-100')

    const outbox = await db.outbox.toArray()
    expect(outbox).toHaveLength(1)
    expect(outbox[0].command).toEqual({
      changes: [{ entitySyncId: 'sync-a', baseVersion: 0 }],
      reverts_operation_id: 'op-100',
    })
  })

  it('普通操作不携带 revertsOperationId（默认 null）', async () => {
    // 验证：非撤回操作不影响既有结构——operations.revertsOperationId 为 null，
    // outbox.command 不出现 reverts_operation_id，保持现有命令形状不变。
    const input: MutationInput = {
      operationType: 'create_work_order',
      entitySyncIds: ['sync-a'],
      apply: (tx) => tx.workOrders.put(makeOrder('sync-a')),
      actorType: 'user',
    }
    await svc.commit(input)

    const ops = await db.operations.toArray()
    expect(ops[0].revertsOperationId).toBeNull()

    const outbox = await db.outbox.toArray()
    const command = outbox[0].command as Record<string, unknown>
    expect(command.reverts_operation_id).toBeUndefined()
  })
})

describe('MutationService 单记录 gate（docs/sync-protocol.md §8）', () => {
  it('syncId 在 outbox 有 conflict 未决条目时禁止再写该记录', async () => {
    await db.outbox.add(makeOutbox())
    const input: MutationInput = {
      operationType: 'create_work_order',
      entitySyncIds: ['sync-a'],
      apply: (tx) => tx.workOrders.put(makeOrder('sync-a')),
      actorType: 'user',
    }
    await expect(svc.commit(input)).rejects.toThrow(RecordGatedError)
    // 未写入任何数据：业务表 / operations / outbox 都保持原状
    expect(await db.workOrders.get('sync-a')).toBeUndefined()
    expect(await db.operations.count()).toBe(0)
    expect(await db.outbox.count()).toBe(1)
  })

  it('syncId 在 outbox 有 rejected 未决条目时禁止再写该记录', async () => {
    await db.outbox.add(makeOutbox({ status: 'rejected', conflictJson: null }))
    const input: MutationInput = {
      operationType: 'create_work_order',
      entitySyncIds: ['sync-a'],
      apply: (tx) => tx.workOrders.put(makeOrder('sync-a')),
      actorType: 'user',
    }
    await expect(svc.commit(input)).rejects.toThrow(RecordGatedError)
  })

  it('pending 未决条目允许继续写（保序）', async () => {
    await db.outbox.add(makeOutbox({ status: 'pending', conflictJson: null }))
    const input: MutationInput = {
      operationType: 'create_work_order',
      entitySyncIds: ['sync-a'],
      apply: (tx) => tx.workOrders.put(makeOrder('sync-a')),
      actorType: 'user',
    }
    await svc.commit(input)
    expect(await db.operations.count()).toBe(1)
  })

  it('冲突未决条目存在时，写其他无冲突记录不受影响', async () => {
    await db.outbox.add(makeOutbox())
    const input: MutationInput = {
      operationType: 'create_work_order',
      entitySyncIds: ['sync-other'],
      apply: (tx) => tx.workOrders.put(makeOrder('sync-other')),
      actorType: 'user',
    }
    await svc.commit(input)
    expect(await db.workOrders.get('sync-other')).toBeDefined()
  })

  it('gate 检查在事务内做：批量提交命中 gate 时不留下任何写入', async () => {
    await db.outbox.add(makeOutbox())
    const input: MutationInput = {
      operationType: 'update_work_order',
      entitySyncIds: ['sync-a', 'sync-b'],
      apply: (tx) => {
        tx.workOrders.put(makeOrder('sync-a'))
        tx.workOrders.put(makeOrder('sync-b'))
      },
      actorType: 'user',
    }
    await expect(svc.commit(input)).rejects.toThrow(RecordGatedError)
    expect(await db.workOrders.get('sync-b')).toBeUndefined()
  })
})
