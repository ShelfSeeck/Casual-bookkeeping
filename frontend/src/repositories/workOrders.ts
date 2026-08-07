import type { AcsDatabase } from '../db/schema'
import type { WorkOrder } from '../db/schema/business/workOrders'

// WorkOrdersRepository：工单表的受控读写（docs/data-model.md §5.2）。
// 所有查询强制按 accountPhone 过滤，账户之间互不可见（账户硬隔离）。

export class WorkOrdersRepository {
  private db: AcsDatabase

  constructor(db: AcsDatabase) {
    this.db = db
  }

  async get(accountPhone: string, syncId: string): Promise<WorkOrder | undefined> {
    const row = await this.db.workOrders.get(syncId)
    return row && row.accountPhone === accountPhone ? row : undefined
  }

  async listByAccount(accountPhone: string): Promise<WorkOrder[]> {
    return this.db.workOrders.where('accountPhone').equals(accountPhone).toArray()
  }

  async put(workOrder: WorkOrder): Promise<void> {
    await this.db.workOrders.put(workOrder)
  }
}
