import type { CbDatabase } from '../db/schema'
import type { ServiceCategory } from '../db/schema/business/serviceCategories'

// ServiceCategoriesRepository：服务选项的受控读写（docs/data-model.md §4.2）。
// 前端每账户独立库，直接操作当前库，不按 accountPhone 过滤。
// 停用大类默认不返回，可显式 includeInactive 包含（docs/spec/business-p0p1.md §5.8.1）。

export class ServiceCategoriesRepository {
  private db: CbDatabase

  constructor(db: CbDatabase) {
    this.db = db
  }

  async get(syncId: string): Promise<ServiceCategory | undefined> {
    return this.db.serviceCategories.get(syncId)
  }

  async list(includeInactive = false): Promise<ServiceCategory[]> {
    const rows = await this.db.serviceCategories.toArray()
    const visible = includeInactive ? rows : rows.filter((c) => c.isActive)
    // 排序：sortOrder 升序（缺省按 0），同值再按 categoryName 升序兜底
    return visible.sort((a, b) => {
      const ao = a.sortOrder ?? 0
      const bo = b.sortOrder ?? 0
      if (ao !== bo) return ao - bo
      return a.categoryName.localeCompare(b.categoryName)
    })
  }

  async findByCategoryName(name: string): Promise<ServiceCategory | undefined> {
    const rows = await this.db.serviceCategories.toArray()
    return rows.find((c) => c.categoryName === name)
  }

  async put(category: ServiceCategory): Promise<void> {
    await this.db.serviceCategories.put(category)
  }
}
