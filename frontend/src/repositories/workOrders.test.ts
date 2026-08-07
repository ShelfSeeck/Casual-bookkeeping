import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { AcsDatabase } from '../db/schema'
import { WorkOrdersRepository } from './workOrders'

// 被测缝：WorkOrdersRepository 公共读写接口
// 验证：按账户增/改/查、账户隔离（跨账户不可见）、不存在返回 undefined。
// 为什么测这里：Repository 是页面读写业务数据的唯一入口，账户过滤是业务隔离的落地处。

const PHONE_A = '13800000000'
const PHONE_B = '13900000000'

function makeOrder(phone: string, syncId: string, quantity = 5): import('../db/schema/business/workOrders').WorkOrder {
  return {
    syncId,
    accountPhone: phone,
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
  db = createBusinessDb(PHONE_A)
  await db.delete()
  await db.open()
  repo = new WorkOrdersRepository(db)
})

describe('WorkOrdersRepository', () => {
  it('put 后可 get 到该工单', async () => {
    await repo.put(makeOrder(PHONE_A, 'sync-a'))
    const found = await repo.get(PHONE_A, 'sync-a')
    expect(found?.quantity).toBe(5)
  })

  it('get 不存在返回 undefined', async () => {
    expect(await repo.get(PHONE_A, 'sync-nope')).toBeUndefined()
  })

  it('账户隔离：B 账户查不到 A 账户的工单', async () => {
    await repo.put(makeOrder(PHONE_A, 'sync-a'))
    expect(await repo.get(PHONE_B, 'sync-a')).toBeUndefined()
  })

  it('listByAccount 只返回该账户的工单', async () => {
    await repo.put(makeOrder(PHONE_A, 'sync-a'))
    await repo.put(makeOrder(PHONE_B, 'sync-b'))
    const list = await repo.listByAccount(PHONE_A)
    expect(list.map((o) => o.syncId)).toEqual(['sync-a'])
  })

  it('put 已存在的 syncId 覆盖更新', async () => {
    await repo.put(makeOrder(PHONE_A, 'sync-a', 5))
    await repo.put({ ...makeOrder(PHONE_A, 'sync-a', 9), rowVersion: 1 })
    const found = await repo.get(PHONE_A, 'sync-a')
    expect(found?.quantity).toBe(9)
    expect(found?.rowVersion).toBe(1)
  })
})
