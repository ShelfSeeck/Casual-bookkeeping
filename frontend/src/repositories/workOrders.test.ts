import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { CbDatabase } from '../db/schema'
import type { WorkOrder } from '../db/schema/business/workOrders'
import { WorkOrdersRepository } from './workOrders'

// 被测缝：WorkOrdersRepository 公共读写接口
// 验证：
// 1. put 后 get、list 返回全部、不存在返回 undefined、put 覆盖更新（基础读写）。
// 2. query()：过滤、排序（workOrderDate DESC, createdAt DESC）、limit/offset、软删排除。
// 3. summarize()：笔数、总数量、已定价金额（整数分）、未定价笔数。
// 为什么测这里：Repository 是页面读写业务数据的唯一入口（docs/spec/business-p0p1.md §5.8.1）；
// 金额必须精确到整数分，软删工单不得进入查询与汇总。

const PHONE = '13800000000'

function makeOrder(syncId: string, overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    syncId,
    accountPhone: PHONE,
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
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  }
}

let db: CbDatabase
let repo: WorkOrdersRepository

beforeEach(async () => {
  db = createBusinessDb(PHONE)
  await db.delete()
  await db.open()
  repo = new WorkOrdersRepository(db)
})

describe('WorkOrdersRepository 基础读写', () => {
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
    await repo.put(makeOrder('sync-a', { quantity: 5 }))
    await repo.put(makeOrder('sync-a', { quantity: 9, rowVersion: 1 }))
    const found = await repo.get('sync-a')
    expect(found?.quantity).toBe(9)
    expect(found?.rowVersion).toBe(1)
  })
})

describe('WorkOrdersRepository.query（§5.8.1）', () => {
  beforeEach(async () => {
    await repo.put(makeOrder('sync-a', {
      createdAt: '2026-08-08T01:00:00.000Z',
      unitPriceCents: 1000,
    }))
    await repo.put(makeOrder('sync-b', {
      workOrderDate: '2026-08-09',
      customerId: 2,
      customerCode: '002',
      customerName: '李四',
      serviceItem: null,
      quantity: 3,
      unitPriceCents: null,
      isCompleted: true,
      createdAt: '2026-08-09T00:00:00.000Z',
    }))
    await repo.put(makeOrder('sync-c', {
      customerName: '张三丰',
      serviceCategory: '刷毛',
      serviceItem: '背心',
      quantity: 2,
      unitPriceCents: 500,
      createdAt: '2026-08-08T02:00:00.000Z',
    }))
    await repo.put(makeOrder('sync-d', {
      workOrderDate: '2026-07-01',
      customerId: 3,
      customerCode: '003',
      customerName: '王五',
      quantity: 7,
      unitPriceCents: 0,
      deletedAt: '2026-08-01T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
    }))
  })

  it('排除软删并按 workOrderDate DESC、createdAt DESC 排序', async () => {
    const list = await repo.query()
    expect(list.map((o) => o.syncId)).toEqual(['sync-b', 'sync-c', 'sync-a'])
  })

  it('dateFrom/dateTo 含端点过滤', async () => {
    const list = await repo.query({ dateFrom: '2026-08-08', dateTo: '2026-08-08' })
    expect(list.map((o) => o.syncId)).toEqual(['sync-c', 'sync-a'])
  })

  it('customerCode 精确匹配、customerName 包含匹配', async () => {
    expect((await repo.query({ customerCode: '001' })).map((o) => o.syncId)).toEqual(['sync-c', 'sync-a'])
    expect((await repo.query({ customerName: '张三' })).map((o) => o.syncId)).toEqual(['sync-c', 'sync-a'])
  })

  it('serviceCategory 精确匹配', async () => {
    const list = await repo.query({ serviceCategory: '洗水' })
    expect(list.map((o) => o.syncId)).toEqual(['sync-b', 'sync-a'])
  })

  it('serviceItem 字符串精确匹配；serviceItem: null 只查小类为空的工单', async () => {
    expect((await repo.query({ serviceItem: '单洗' })).map((o) => o.syncId)).toEqual(['sync-a'])
    expect((await repo.query({ serviceItem: null })).map((o) => o.syncId)).toEqual(['sync-b'])
  })

  it('isCompleted 与 unpricedOnly 过滤（unpricedOnly 与 serviceItem:null 语义分开）', async () => {
    expect((await repo.query({ isCompleted: true })).map((o) => o.syncId)).toEqual(['sync-b'])
    expect((await repo.query({ unpricedOnly: true })).map((o) => o.syncId)).toEqual(['sync-b'])
    // serviceItem:null 且已定价不存在于当前数据；两者是独立过滤条件
    expect(await repo.query({ serviceItem: null, unpricedOnly: true })).toHaveLength(1)
  })

  it('keyword 匹配编号/客户名/大类/小类任一包含', async () => {
    expect((await repo.query({ keyword: '李四' })).map((o) => o.syncId)).toEqual(['sync-b'])
    expect((await repo.query({ keyword: '刷毛' })).map((o) => o.syncId)).toEqual(['sync-c'])
    expect((await repo.query({ keyword: '002' })).map((o) => o.syncId)).toEqual(['sync-b'])
  })

  it('limit/offset 分页在排序之后', async () => {
    expect((await repo.query({ limit: 2, offset: 0 })).map((o) => o.syncId)).toEqual(['sync-b', 'sync-c'])
    expect((await repo.query({ limit: 2, offset: 1 })).map((o) => o.syncId)).toEqual(['sync-c', 'sync-a'])
  })
})

describe('WorkOrdersRepository.summarize（§5.8.1）', () => {
  beforeEach(async () => {
    await repo.put(makeOrder('sync-a', { unitPriceCents: 1000 })) // 5*1000 = 5000
    await repo.put(makeOrder('sync-b', {
      workOrderDate: '2026-08-09',
      customerCode: '002',
      customerName: '李四',
      serviceItem: null,
      quantity: 3,
      unitPriceCents: null,
    })) // 未定价
    await repo.put(makeOrder('sync-c', {
      customerName: '张三丰',
      serviceCategory: '刷毛',
      serviceItem: '背心',
      quantity: 2,
      unitPriceCents: 500,
    })) // 2*500 = 1000
    await repo.put(makeOrder('sync-d', { deletedAt: '2026-08-01T00:00:00.000Z', unitPriceCents: 999 }))
  })

  it('汇总只统计未软删工单；金额只累加已定价且为整数分', async () => {
    const summary = await repo.summarize()
    expect(summary).toEqual({
      count: 3,
      totalQuantity: 10,
      totalAmountCents: 6000,
      unpricedCount: 1,
    })
  })

  it('summarize 支持与 query 相同的过滤条件', async () => {
    const summary = await repo.summarize({ unpricedOnly: true })
    expect(summary).toEqual({
      count: 1,
      totalQuantity: 3,
      totalAmountCents: 0,
      unpricedCount: 1,
    })
  })
})
