import type { AcsDatabase } from '../db/schema'
import type { Customer } from '../db/schema/business/customers'

// CustomersRepository：客户主数据的受控读写（docs/data-model.md §4.3）。
// 归档客户默认不返回，可显式 includeArchived 包含。

export class CustomersRepository {
  private db: AcsDatabase

  constructor(db: AcsDatabase) {
    this.db = db
  }

  async get(accountPhone: string, syncId: string): Promise<Customer | undefined> {
    const row = await this.db.customers.get(syncId)
    return row && row.accountPhone === accountPhone ? row : undefined
  }

  async listByAccount(
    accountPhone: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<Customer[]> {
    const rows = await this.db.customers.where('accountPhone').equals(accountPhone).toArray()
    if (options.includeArchived) return rows
    return rows.filter((c) => c.archivedAt === null)
  }

  async put(customer: Customer): Promise<void> {
    await this.db.customers.put(customer)
  }
}
