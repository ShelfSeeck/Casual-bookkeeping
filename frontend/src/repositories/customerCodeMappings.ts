import type { CbDatabase } from '../db/schema'
import type { CustomerCodeMapping } from '../db/schema/business/customerCodeMappings'

// CustomerCodeMappingsRepository：客户编号映射的受控读写（docs/data-model.md §4.4）。
// 前端每账户独立库，直接操作当前库，不按 accountPhone 过滤。
// 映射按工单业务日期判断有效期（区间含端点：valid_from <= d <= valid_to）。
// list/findValid 对应 docs/spec/business-p0p1.md §5.8.1。

export interface CustomerCodeMappingFilter {
  customerCode?: string | null
  onDate?: string | null       // 仅返回该日期有效（validFrom <= d <= validTo）
  customerId?: number | null
}

export class CustomerCodeMappingsRepository {
  private db: CbDatabase

  constructor(db: CbDatabase) {
    this.db = db
  }

  async get(syncId: string): Promise<CustomerCodeMapping | undefined> {
    return this.db.customerCodeMappings.get(syncId)
  }

  async list(filters: CustomerCodeMappingFilter = {}): Promise<CustomerCodeMapping[]> {
    const rows = await this.db.customerCodeMappings.toArray()
    const filtered = rows.filter((m) => {
      if (filters.customerCode !== undefined && filters.customerCode !== null && m.customerCode !== filters.customerCode) return false
      if (filters.onDate) {
        if (m.validFrom > filters.onDate) return false
        if (m.validTo !== null && m.validTo < filters.onDate) return false
      }
      if (filters.customerId !== undefined && filters.customerId !== null && m.customerId !== filters.customerId) return false
      return true
    })
    // 排序固定：customerCode 升序、validFrom 升序
    return filtered.sort(
      (a, b) =>
        a.customerCode.localeCompare(b.customerCode) ||
        a.validFrom.localeCompare(b.validFrom),
    )
  }

  async findValid(customerCode: string, date: string): Promise<CustomerCodeMapping | undefined> {
    const rows = await this.list({ customerCode, onDate: date })
    return rows[0]
  }

  async put(mapping: CustomerCodeMapping): Promise<void> {
    await this.db.customerCodeMappings.put(mapping)
  }
}
