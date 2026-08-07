import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { AcsDatabase } from '../db/schema'
import type { Customer } from '../db/schema/business/customers'
import { CustomersRepository } from './customers'

// 被测缝：CustomersRepository 公共读写接口
// 验证：按账户增/改/查、账户隔离、不存在返回 undefined、list 含归档过滤参数。
// 为什么测这里：客户主数据是工单快照的来源，Repository 是唯一读写入口。

const PHONE_A = '13800000000'
const PHONE_B = '13900000000'

function makeCustomer(phone: string, syncId: string): Customer {
  return {
    syncId,
    accountPhone: phone,
    canonicalName: `厂家${syncId}`,
    archivedAt: null,
    rowVersion: 0,
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
  }
}

let db: AcsDatabase
let repo: CustomersRepository

beforeEach(async () => {
  db = createBusinessDb(PHONE_A)
  await db.delete()
  await db.open()
  repo = new CustomersRepository(db)
})

describe('CustomersRepository', () => {
  it('put 后可 get 到该客户', async () => {
    await repo.put(makeCustomer(PHONE_A, 'cust-a'))
    expect((await repo.get(PHONE_A, 'cust-a'))?.canonicalName).toBe('厂家cust-a')
  })

  it('get 不存在返回 undefined', async () => {
    expect(await repo.get(PHONE_A, 'cust-nope')).toBeUndefined()
  })

  it('账户隔离：B 账户查不到 A 账户客户', async () => {
    await repo.put(makeCustomer(PHONE_A, 'cust-a'))
    expect(await repo.get(PHONE_B, 'cust-a')).toBeUndefined()
  })

  it('listByAccount 默认不返回已归档客户', async () => {
    await repo.put(makeCustomer(PHONE_A, 'cust-a'))
    await repo.put({ ...makeCustomer(PHONE_A, 'cust-b'), archivedAt: '2026-08-09' })
    const active = await repo.listByAccount(PHONE_A)
    expect(active.map((c) => c.syncId)).toEqual(['cust-a'])
    const all = await repo.listByAccount(PHONE_A, { includeArchived: true })
    expect(all.map((c) => c.syncId)).toEqual(['cust-a', 'cust-b'])
  })
})
