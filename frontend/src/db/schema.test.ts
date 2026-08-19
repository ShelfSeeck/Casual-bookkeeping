import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb, businessDbName } from './db'
import { CbDatabase } from './schema'

// 被测缝：schema.ts 建出的业务库
// 验证：打开 db_<phone> 后 7 张表齐全，主键/唯一约束符合 data-model.md §5.2。
// 为什么测这里：建库是前端数据库地基，表集合或主键错误会级联影响所有 Repository 和同步。

beforeEach(async () => {
  await createBusinessDb('13800000000').delete()
})

describe('业务库 schema', () => {
  it('库名使用规范化手机号（db_<phone>）', () => {
    expect(businessDbName('13800000000')).toBe('db_13800000000')
  })

  it('打开后 7 张表齐全', async () => {
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

  it('outbox 带 entitySyncIds 多值索引、status 与 createdAt 索引', async () => {
    // Obsidian 存储设计 §4：entity_sync_ids 多值索引（同记录未决查询）、
    // status 索引（同步器筛选）、created_at 索引（按创建顺序发送）。
    const db = createBusinessDb('13800000000')
    await db.open()
    const outbox = db.table('outbox')
    const idx = outbox.schema.idxByName
    expect(idx['entitySyncIds']?.multi, 'entitySyncIds 应为多值索引').toBe(true)
    expect(idx['status'], 'status 应有索引').toBeTruthy()
    expect(idx['createdAt'], 'createdAt 应有索引').toBeTruthy()
  })

  it('operations 以 operationId 为主键，syncState 以 accountPhone 为主键', async () => {
    const db = createBusinessDb('13800000000')
    await db.open()
    expect(db.table('operations').schema.primKey.src).toBe('operationId')
    expect(db.table('syncState').schema.primKey.src).toBe('accountPhone')
  })

  it('version(3) upgrade 为旧 serviceCategories 按名称初始化 sortOrder', async () => {
    // 模拟旧版库：只有 serviceCategories 表、记录无 sortOrder 字段；
    // 打开新 CbDatabase 时应自动执行 upgrade，按 categoryName 补 1..n。
    const name = businessDbName('13900000000')
    await Dexie.delete(name)
    const oldDb = new Dexie(name)
    oldDb.version(2).stores({
      serviceCategories: 'syncId',
    })
    await oldDb.open()
    await oldDb.table('serviceCategories').put({
      syncId: 'cat-b',
      accountPhone: '13900000000',
      categoryName: 'B大类',
      subcategoriesJson: [],
      isActive: true,
      rowVersion: 1,
      createdAt: '2026-08-08T00:00:00Z',
      updatedAt: '2026-08-08T00:00:00Z',
    })
    await oldDb.table('serviceCategories').put({
      syncId: 'cat-a',
      accountPhone: '13900000000',
      categoryName: 'A大类',
      subcategoriesJson: [],
      isActive: true,
      rowVersion: 1,
      createdAt: '2026-08-08T00:00:00Z',
      updatedAt: '2026-08-08T00:00:00Z',
    })
    oldDb.close()

    const db = new CbDatabase(name)
    await db.open()
    const rows = await db.serviceCategories.orderBy('syncId').toArray()
    const byId = Object.fromEntries(rows.map((r) => [r.syncId, r]))
    expect(byId['cat-a'].sortOrder).toBe(1)
    expect(byId['cat-b'].sortOrder).toBe(2)
    db.close()
  })
})
