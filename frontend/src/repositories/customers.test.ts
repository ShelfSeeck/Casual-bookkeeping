import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { CbDatabase } from '../db/schema'
import type { Customer } from '../db/schema/business/customers'
import { CustomersRepository } from './customers'

// 被测缝：CustomersRepository 公共读写接口
// 验证：put/get、不存在返回 undefined、list 默认排除归档、includeArchived 可选包含。
// 为什么测这里：客户主数据是工单快照的来源，Repository 是唯一读写入口。

function makeCustomer(syncId: string): Customer {
  return {
    syncId,
    accountPhone: '13800000000',
    canonicalName: `厂家${syncId}`,
    archivedAt: null,
    rowVersion: 0,
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
  }
}

let db: CbDatabase
let repo: CustomersRepository

beforeEach(async () => {
  db = createBusinessDb('13800000000')
  await db.delete()
  await db.open()
  repo = new CustomersRepository(db)
})

describe('CustomersRepository', () => {
  it('put 后可 get 到该客户', async () => {
    await repo.put(makeCustomer('cust-a'))
    expect((await repo.get('cust-a'))?.canonicalName).toBe('厂家cust-a')
  })

  it('get 不存在返回 undefined', async () => {
    expect(await repo.get('cust-nope')).toBeUndefined()
  })

  it('list 默认不返回已归档客户', async () => {
    await repo.put(makeCustomer('cust-a'))
    await repo.put({ ...makeCustomer('cust-b'), archivedAt: '2026-08-09' })
    const active = await repo.list()
    expect(active.map((c) => c.syncId)).toEqual(['cust-a'])
    const all = await repo.list({ includeArchived: true })
    expect(all.map((c) => c.syncId)).toEqual(['cust-a', 'cust-b'])
  })
})
