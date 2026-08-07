import type { AcsDatabase } from '../db/schema'
import type { ServiceCategory } from '../db/schema/business/serviceCategories'

// ServiceCategoriesRepository：服务选项的受控读写（docs/data-model.md §4.2）。
// 停用大类默认不返回，可显式 includeInactive 包含（历史工单不依赖此项）。

export class ServiceCategoriesRepository {
  private db: AcsDatabase

  constructor(db: AcsDatabase) {
    this.db = db
  }

  async get(accountPhone: string, syncId: string): Promise<ServiceCategory | undefined> {
    const row = await this.db.serviceCategories.get(syncId)
    return row && row.accountPhone === accountPhone ? row : undefined
  }

  async listByAccount(
    accountPhone: string,
    options: { includeInactive?: boolean } = {},
  ): Promise<ServiceCategory[]> {
    const rows = await this.db.serviceCategories
      .where('accountPhone')
      .equals(accountPhone)
      .toArray()
    if (options.includeInactive) return rows
    return rows.filter((c) => c.isActive)
  }

  async put(category: ServiceCategory): Promise<void> {
    await this.db.serviceCategories.put(category)
  }
}
