import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { AcsDatabase } from '../db/schema'
import type { WorkOrder } from '../db/schema/business/workOrders'
import { WorkOrdersRepository } from './workOrders'

// 被测缝：WorkOrdersRepository 公共读写接口
// 验证：put 后 get、list 返回全部、不存在返回 undefined、put 覆盖更新。
// 为什么测这里：Repository 是页面读写业务数据的唯一入口；
// 前端每账户独立库，直接操作当前库，不按账户过滤。

function makeOrder(syncId: string, quantity = 5): WorkOrder {
  return {
    syncId,
    accountPhone: '13800000000',
    workOrderDate: '2026-08-08',
    customerId: 1,
    customerCode: '001',
    customerName: '张三',
    serviceCategory: '洗水',
    serviceItem: '单洗',
    quantity,
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
let repo: WorkOrdersRepository

beforeEach(async () => {
  db = createBusinessDb('13800000000')
  await db.delete()
  await db.open()
  repo = new WorkOrdersRepository(db)
})

describe('WorkOrdersRepository', () => {
  it('put 后可 get 到该工单', async () => {
    await repo.put(makeOrder('sync-a'))
    const found = await repo.get('sync-a')
    expect(found?.quantity).toBe(5)
  })

  it('get 不存在返回 undefined', async () => {
    expect(await repo.get('sync-nope')).toBeUndefined()
  })

  it('list 返回当前库全部工单', async () => {
    await repo.put(makeOrder('sync-a'))
    await repo.put(makeOrder('sync-b'))
    const list = await repo.list()
    expect(list.map((o) => o.syncId)).toEqual(['sync-a', 'sync-b'])
  })

  it('put 已存在的 syncId 覆盖更新', async () => {
    await repo.put(makeOrder('sync-a', 5))
    await repo.put({ ...makeOrder('sync-a', 9), rowVersion: 1 })
    const found = await repo.get('sync-a')
    expect(found?.quantity).toBe(9)
    expect(found?.rowVersion).toBe(1)
  })
})
