import type { CbDatabase } from '../db/schema'
import type { Customer } from '../db/schema/business/customers'

// CustomersRepository：客户主数据的受控读写（docs/data-model.md §4.3）。
// 前端每账户独立库，直接操作当前库，不按 accountPhone 过滤。
// 归档客户默认不返回，可显式 includeArchived 包含（docs/spec/business-p0p1.md §5.8.1）。

export class CustomersRepository {
  private db: CbDatabase

  constructor(db: CbDatabase) {
    this.db = db
  }

  async get(syncId: string): Promise<Customer | undefined> {
    return this.db.customers.get(syncId)
  }

  async list(includeArchived = false): Promise<Customer[]> {
    const rows = await this.db.customers.toArray()
    const visible = includeArchived ? rows : rows.filter((c) => c.archivedAt === null)
    // 排序固定：canonicalName 升序
    return visible.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName))
  }

  async getByCustomerId(customerId: number): Promise<Customer | undefined> {
    const rows = await this.db.customers.toArray()
    return rows.find((c) => c.customerId === customerId)
  }

  async put(customer: Customer): Promise<void> {
    await this.db.customers.put(customer)
  }
}
