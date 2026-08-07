import type { AcsDatabase } from '../db/schema'
import type { WorkOrder } from '../db/schema/business/workOrders'

// WorkOrdersRepository：工单表的受控读写（docs/data-model.md §5.2）。
// 前端每账户独立库 db_<phone>，当前打开的库天然只含一个账户的数据，
// 因此不需要按 accountPhone 过滤，直接操作当前库。

export class WorkOrdersRepository {
  private db: AcsDatabase

  constructor(db: AcsDatabase) {
    this.db = db
  }

  async get(syncId: string): Promise<WorkOrder | undefined> {
    return this.db.workOrders.get(syncId)
  }

  async list(): Promise<WorkOrder[]> {
    return this.db.workOrders.toArray()
  }

  async put(workOrder: WorkOrder): Promise<void> {
    await this.db.workOrders.put(workOrder)
  }
}
