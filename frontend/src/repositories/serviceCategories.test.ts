import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { AcsDatabase } from '../db/schema'
import type { ServiceCategory } from '../db/schema/business/serviceCategories'
import { ServiceCategoriesRepository } from './serviceCategories'

// 被测缝：ServiceCategoriesRepository 公共读写接口
// 验证：put/get 小类 JSON 结构、账户隔离、list 按 isActive 过滤。
// 为什么测这里：服务选项是录入工单时的大小类来源，Repository 是唯一读写入口。

const PHONE_A = '13800000000'
const PHONE_B = '13900000000'

function makeCategory(phone: string, syncId: string): ServiceCategory {
  return {
    syncId,
    accountPhone: phone,
    categoryName: `大类${syncId}`,
    subcategories: [{ name: '单洗', defaultUnit: '件', isActive: true }],
    isActive: true,
    rowVersion: 0,
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
  }
}

let db: AcsDatabase
let repo: ServiceCategoriesRepository

beforeEach(async () => {
  db = createBusinessDb(PHONE_A)
  await db.delete()
  await db.open()
  repo = new ServiceCategoriesRepository(db)
})

describe('ServiceCategoriesRepository', () => {
  it('put 后可 get 到该大类及其小类', async () => {
    await repo.put(makeCategory(PHONE_A, 'cat-a'))
    const found = await repo.get(PHONE_A, 'cat-a')
    expect(found?.subcategories[0].name).toBe('单洗')
  })

  it('账户隔离：B 账户查不到 A 账户大类', async () => {
    await repo.put(makeCategory(PHONE_A, 'cat-a'))
    expect(await repo.get(PHONE_B, 'cat-a')).toBeUndefined()
  })

  it('listByAccount 默认只返回启用的大类', async () => {
    await repo.put(makeCategory(PHONE_A, 'cat-a'))
    await repo.put({ ...makeCategory(PHONE_A, 'cat-b'), isActive: false })
    const active = await repo.listByAccount(PHONE_A)
    expect(active.map((c) => c.syncId)).toEqual(['cat-a'])
    const all = await repo.listByAccount(PHONE_A, { includeInactive: true })
    expect(all.map((c) => c.syncId)).toEqual(['cat-a', 'cat-b'])
  })
})
