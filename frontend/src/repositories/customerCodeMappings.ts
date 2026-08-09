import type { CbDatabase } from '../db/schema'
import type { CustomerCodeMapping } from '../db/schema/business/customerCodeMappings'

// CustomerCodeMappingsRepository：客户编号映射的受控读写（docs/data-model.md §4.4）。
// 前端每账户独立库，直接操作当前库，不按 accountPhone 过滤。
// 映射按工单业务日期判断有效期（区间含 valid_from，含/不含 valid_to 由调用语义统一）。

export class CustomerCodeMappingsRepository {
  private db: CbDatabase

  constructor(db: CbDatabase) {
    this.db = db
  }

  async get(syncId: string): Promise<CustomerCodeMapping | undefined> {
    return this.db.customerCodeMappings.get(syncId)
  }

  async findActiveByDate(date: string): Promise<CustomerCodeMapping[]> {
    const rows = await this.db.customerCodeMappings.toArray()
    return rows.filter((m) => m.validFrom <= date && (m.validTo === null || m.validTo >= date))
  }

  async put(mapping: CustomerCodeMapping): Promise<void> {
    await this.db.customerCodeMappings.put(mapping)
  }
}
