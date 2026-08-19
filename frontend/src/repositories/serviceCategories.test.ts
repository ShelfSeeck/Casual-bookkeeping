import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { CbDatabase } from '../db/schema'
import type { ServiceCategory } from '../db/schema/business/serviceCategories'
import { ServiceCategoriesRepository } from './serviceCategories'

// 被测缝：ServiceCategoriesRepository 公共读写接口
// 验证：put/get 小类结构、list 默认排除停用大类且按 categoryName 升序、
// includeInactive 可选包含、findByCategoryName 按大类名查找。
// 为什么测这里：服务选项是录入工单时的大小类来源，Repository 是唯一读写入口。

const PHONE = '13800000000'

function makeCategory(syncId: string, overrides: Partial<ServiceCategory> = {}): ServiceCategory {
  return {
    syncId,
    accountPhone: PHONE,
    categoryName: `大类${syncId}`,
    subcategoriesJson: [{ name: '单洗', defaultUnit: '件', isActive: true }],
    isActive: true,
    rowVersion: 0,
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
    ...overrides,
  }
}

let db: CbDatabase
let repo: ServiceCategoriesRepository

beforeEach(async () => {
  db = createBusinessDb(PHONE)
  await db.delete()
  await db.open()
  repo = new ServiceCategoriesRepository(db)
})

describe('ServiceCategoriesRepository', () => {
  it('put 后可 get 到该大类及其小类', async () => {
    await repo.put(makeCategory('cat-a'))
    const found = await repo.get('cat-a')
    expect(found?.subcategoriesJson[0].name).toBe('单洗')
  })

  it('list 默认只返回启用的大类，includeInactive 可包含', async () => {
    await repo.put(makeCategory('cat-a'))
    await repo.put(makeCategory('cat-b', { isActive: false }))
    const active = await repo.list()
    expect(active.map((c) => c.syncId)).toEqual(['cat-a'])
    const all = await repo.list(true)
    expect(all.map((c) => c.syncId)).toEqual(['cat-a', 'cat-b'])
  })

  it('list 按 categoryName 升序', async () => {
    await repo.put(makeCategory('cat-b', { categoryName: 'B大类' }))
    await repo.put(makeCategory('cat-a', { categoryName: 'A大类' }))
    await repo.put(makeCategory('cat-c', { categoryName: 'C大类' }))
    const list = await repo.list()
    expect(list.map((c) => c.categoryName)).toEqual(['A大类', 'B大类', 'C大类'])
  })

  it('list 按 sortOrder 升序，同值再按 categoryName 升序', async () => {
    await repo.put(makeCategory('cat-a', { categoryName: 'A大类', sortOrder: 2 }))
    await repo.put(makeCategory('cat-b', { categoryName: 'B大类', sortOrder: 1 }))
    await repo.put(makeCategory('cat-c', { categoryName: 'C大类', sortOrder: 1 }))
    const list = await repo.list()
    expect(list.map((c) => c.categoryName)).toEqual(['B大类', 'C大类', 'A大类'])
  })

  it('findByCategoryName 按大类名查找，不存在返回 undefined', async () => {
    await repo.put(makeCategory('cat-a', { categoryName: '洗水' }))
    expect((await repo.findByCategoryName('洗水'))?.syncId).toBe('cat-a')
    expect(await repo.findByCategoryName('不存在')).toBeUndefined()
  })
})
