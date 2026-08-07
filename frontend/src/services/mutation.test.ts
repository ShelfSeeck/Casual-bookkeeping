import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { AcsDatabase } from '../db/schema'
import type { WorkOrder } from '../db/schema/business/workOrders'
import { MutationService, type MutationInput } from './mutation'

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

let db: AcsDatabase
let svc: MutationService

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
      accountPhone: PHONE_A,
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
      accountPhone: PHONE_A,
      operationType: 'create_work_order',
      entitySyncIds: ['sync-a'],
      apply: (tx) => tx.workOrders.put(makeOrder('sync-a')),
      actorType: 'user',
    }
    await svc.commit(input)
    const ops = await db.operations.toArray()
    expect(ops[0].operationId).toMatch(/^op-[0-9a-f]{12}$/)
  })

  it('apply 抛错时三表全部回滚，无部分写入', async () => {
    const input: MutationInput = {
      accountPhone: PHONE_A,
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
