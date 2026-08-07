import type { AcsDatabase } from '../db/schema'
import type { CustomerCodeMapping } from '../db/schema/business/customerCodeMappings'

// CustomerCodeMappingsRepository：客户编号映射的受控读写（docs/data-model.md §4.4）。
// 映射按工单业务日期判断有效期（区间含 valid_from，含/不含 valid_to 由调用语义统一）。

export class CustomerCodeMappingsRepository {
  private db: AcsDatabase

  constructor(db: AcsDatabase) {
    this.db = db
  }

  async get(accountPhone: string, syncId: string): Promise<CustomerCodeMapping | undefined> {
    const row = await this.db.customerCodeMappings.get(syncId)
    return row && row.accountPhone === accountPhone ? row : undefined
  }

  async findActiveByDate(accountPhone: string, date: string): Promise<CustomerCodeMapping[]> {
    const rows = await this.db.customerCodeMappings
      .where('accountPhone')
      .equals(accountPhone)
      .toArray()
    return rows.filter((m) => m.validFrom <= date && (m.validTo === null || m.validTo >= date))
  }

  async put(mapping: CustomerCodeMapping): Promise<void> {
    await this.db.customerCodeMappings.put(mapping)
  }
}
