import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb, businessDbName } from './db'

// 被测缝：schema.ts 建出的业务库
// 验证：打开 db_<phone> 后 8 张表齐全，主键/唯一约束符合 data-model.md §5.2。
// 为什么测这里：建库是前端数据库地基，表集合或主键错误会级联影响所有 Repository 和同步。

beforeEach(async () => {
  await createBusinessDb('13800000000').delete()
})

describe('业务库 schema', () => {
  it('库名使用规范化手机号（db_<phone>）', () => {
    expect(businessDbName('13800000000')).toBe('db_13800000000')
  })

  it('打开后 8 张表齐全', async () => {
    const db = createBusinessDb('13800000000')
    await db.open()
    const names = db.tables.map((t) => t.name).sort()
    expect(names).toEqual([
      'customerCodeMappings',
      'customers',
      'operations',
      'outbox',
      'serviceCategories',
      'syncState',
      'workOrders',
    ].sort())
  })

  it('业务表以 syncId 为主键', async () => {
    const db = createBusinessDb('13800000000')
    await db.open()
    for (const table of ['workOrders', 'customers', 'customerCodeMappings', 'serviceCategories']) {
      const schema = db.table(table).schema
      expect(schema.primKey.src, `${table} 主键应为 syncId`).toBe('syncId')
    }
  })

  it('outbox 主键为自增 queueId，operationId 唯一', async () => {
    const db = createBusinessDb('13800000000')
    await db.open()
    const outbox = db.table('outbox')
    expect(outbox.schema.primKey.src).toBe('++queueId')
    expect(outbox.schema.primKey.auto).toBe(true)
    expect(outbox.schema.idxByName['operationId']?.unique).toBe(true)
  })

  it('operations 以 operationId 为主键，syncState 以 accountPhone 为主键', async () => {
    const db = createBusinessDb('13800000000')
    await db.open()
    expect(db.table('operations').schema.primKey.src).toBe('operationId')
    expect(db.table('syncState').schema.primKey.src).toBe('accountPhone')
  })
})
