import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { CbDatabase } from '../db/schema'
import type { CustomerCodeMapping } from '../db/schema/business/customerCodeMappings'
import { CustomerCodeMappingsRepository } from './customerCodeMappings'

// 被测缝：CustomerCodeMappingsRepository 公共读写接口
// 验证：put/get、按业务日期查找该日期有效的映射（valid_from/valid_to 区间）。
// 为什么测这里：工单录入按业务日期选择客户编号映射，日期区间判断是核心业务语义。

function makeMapping(syncId: string, validFrom: string, validTo: string | null): CustomerCodeMapping {
  return {
    syncId,
    accountPhone: '13800000000',
    customerId: 1,
    customerCode: '001',
    customerName: '张三',
    validFrom,
    validTo,
    rowVersion: 0,
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
  }
}

let db: CbDatabase
let repo: CustomerCodeMappingsRepository

beforeEach(async () => {
  db = createBusinessDb('13800000000')
  await db.delete()
  await db.open()
  repo = new CustomerCodeMappingsRepository(db)
})

describe('CustomerCodeMappingsRepository', () => {
  it('put 后可 get 到该映射', async () => {
    await repo.put(makeMapping('map-a', '2026-01-01', null))
    expect((await repo.get('map-a'))?.customerName).toBe('张三')
  })

  it('findActiveByDate 返回业务日期落在区间内的映射', async () => {
    await repo.put(makeMapping('map-early', '2026-01-01', '2026-06-30'))
    await repo.put(makeMapping('map-late', '2026-07-01', null))
    const inRange = await repo.findActiveByDate('2026-06-15')
    expect(inRange.map((m) => m.syncId)).toEqual(['map-early'])
    const after = await repo.findActiveByDate('2026-07-15')
    expect(after.map((m) => m.syncId)).toEqual(['map-late'])
  })

  it('findActiveByDate 返回空数组当无有效映射', async () => {
    await repo.put(makeMapping('map-early', '2026-01-01', '2026-06-30'))
    expect(await repo.findActiveByDate('2026-07-15')).toEqual([])
  })
})
