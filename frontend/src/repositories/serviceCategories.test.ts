import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { CbDatabase } from '../db/schema'
import type { ServiceCategory } from '../db/schema/business/serviceCategories'
import { ServiceCategoriesRepository } from './serviceCategories'

// 被测缝：ServiceCategoriesRepository 公共读写接口
// 验证：put/get 小类结构、list 默认排除停用大类、includeInactive 可选包含。
// 为什么测这里：服务选项是录入工单时的大小类来源，Repository 是唯一读写入口。

function makeCategory(syncId: string): ServiceCategory {
  return {
    syncId,
    accountPhone: '13800000000',
    categoryName: `大类${syncId}`,
    subcategoriesJson: [{ name: '单洗', defaultUnit: '件', isActive: true }],
    isActive: true,
    rowVersion: 0,
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
  }
}

let db: CbDatabase
let repo: ServiceCategoriesRepository

beforeEach(async () => {
  db = createBusinessDb('13800000000')
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

  it('list 默认只返回启用的大类', async () => {
    await repo.put(makeCategory('cat-a'))
    await repo.put({ ...makeCategory('cat-b'), isActive: false })
    const active = await repo.list()
    expect(active.map((c) => c.syncId)).toEqual(['cat-a'])
    const all = await repo.list({ includeInactive: true })
    expect(all.map((c) => c.syncId)).toEqual(['cat-a', 'cat-b'])
  })
})
