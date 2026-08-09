import type { CbDatabase } from '../db/schema'
import type { ServiceCategory } from '../db/schema/business/serviceCategories'

// ServiceCategoriesRepository：服务选项的受控读写（docs/data-model.md §4.2）。
// 前端每账户独立库，直接操作当前库，不按 accountPhone 过滤。
// 停用大类默认不返回，可显式 includeInactive 包含（历史工单不依赖此项）。

export class ServiceCategoriesRepository {
  private db: CbDatabase

  constructor(db: CbDatabase) {
    this.db = db
  }

  async get(syncId: string): Promise<ServiceCategory | undefined> {
    return this.db.serviceCategories.get(syncId)
  }

  async list(options: { includeInactive?: boolean } = {}): Promise<ServiceCategory[]> {
    const rows = await this.db.serviceCategories.toArray()
    if (options.includeInactive) return rows
    return rows.filter((c) => c.isActive)
  }

  async put(category: ServiceCategory): Promise<void> {
    await this.db.serviceCategories.put(category)
  }
}
