import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { CbDatabase } from '../db/schema'
import type { CustomerCodeMapping } from '../db/schema/business/customerCodeMappings'
import { CustomerCodeMappingsRepository } from './customerCodeMappings'

// 被测缝：CustomerCodeMappingsRepository 公共读写接口
// 验证：put/get、list 过滤与排序（customerCode 升序、validFrom 升序）、
// findValid 按 customerCode + 业务日期返回有效映射、findActiveByDate 兼容旧接口。
// 为什么测这里：工单录入按业务日期选择客户编号映射，日期区间判断是核心业务语义。

const PHONE = '13800000000'

function makeMapping(
  syncId: string,
  overrides: Partial<CustomerCodeMapping> = {},
): CustomerCodeMapping {
  return {
    syncId,
    accountPhone: PHONE,
    customerId: 1,
    customerCode: '001',
    customerName: '张三',
    validFrom: '2026-01-01',
    validTo: null,
    rowVersion: 0,
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
    ...overrides,
  }
}

let db: CbDatabase
let repo: CustomerCodeMappingsRepository

beforeEach(async () => {
  db = createBusinessDb(PHONE)
  await db.delete()
  await db.open()
  repo = new CustomerCodeMappingsRepository(db)
})

describe('CustomerCodeMappingsRepository', () => {
  it('put 后可 get 到该映射', async () => {
    await repo.put(makeMapping('map-a'))
    expect((await repo.get('map-a'))?.customerName).toBe('张三')
  })

  it('findActiveByDate 返回业务日期落在区间内的映射', async () => {
    await repo.put(makeMapping('map-early', { validFrom: '2026-01-01', validTo: '2026-06-30' }))
    await repo.put(makeMapping('map-late', { validFrom: '2026-07-01', validTo: null }))
    const inRange = await repo.findActiveByDate('2026-06-15')
    expect(inRange.map((m) => m.syncId)).toEqual(['map-early'])
    const after = await repo.findActiveByDate('2026-07-15')
    expect(after.map((m) => m.syncId)).toEqual(['map-late'])
  })

  it('findActiveByDate 返回空数组当无有效映射', async () => {
    await repo.put(makeMapping('map-early', { validFrom: '2026-01-01', validTo: '2026-06-30' }))
    expect(await repo.findActiveByDate('2026-07-15')).toEqual([])
  })

  it('list 按 customerCode 升序、validFrom 升序', async () => {
    await repo.put(makeMapping('map-b', { customerCode: '001', validFrom: '2026-07-01' }))
    await repo.put(makeMapping('map-a', { customerCode: '002', validFrom: '2026-01-01' }))
    await repo.put(makeMapping('map-c', { customerCode: '001', validFrom: '2026-01-01' }))
    const list = await repo.list()
    expect(list.map((m) => m.syncId)).toEqual(['map-c', 'map-b', 'map-a'])
  })

  it('list 支持 customerCode 精确过滤', async () => {
    await repo.put(makeMapping('map-a', { customerCode: '001' }))
    await repo.put(makeMapping('map-b', { customerCode: '002' }))
    const list = await repo.list({ customerCode: '001' })
    expect(list.map((m) => m.syncId)).toEqual(['map-a'])
  })

  it('list 支持 onDate 仅返回该日期有效映射（含端点）', async () => {
    await repo.put(makeMapping('map-early', { validFrom: '2026-01-01', validTo: '2026-06-30' }))
    await repo.put(makeMapping('map-late', { validFrom: '2026-07-01', validTo: null }))
    const list = await repo.list({ onDate: '2026-06-30' })
    expect(list.map((m) => m.syncId)).toEqual(['map-early'])
    const none = await repo.list({ onDate: '2025-12-31' })
    expect(none).toEqual([])
  })

  it('list 支持 customerId 过滤', async () => {
    await repo.put(makeMapping('map-a', { customerId: 1 }))
    await repo.put(makeMapping('map-b', { customerId: 2, customerCode: '002' }))
    const list = await repo.list({ customerId: 2 })
    expect(list.map((m) => m.syncId)).toEqual(['map-b'])
  })

  it('findValid 返回该编号该日期第一条有效映射，无则 undefined', async () => {
    await repo.put(makeMapping('map-early', { validFrom: '2026-01-01', validTo: '2026-06-30' }))
    await repo.put(makeMapping('map-late', { validFrom: '2026-07-01', validTo: null }))
    expect((await repo.findValid('001', '2026-06-15'))?.syncId).toBe('map-early')
    expect((await repo.findValid('001', '2026-07-15'))?.syncId).toBe('map-late')
    expect(await repo.findValid('001', '2025-12-31')).toBeUndefined()
  })
})
