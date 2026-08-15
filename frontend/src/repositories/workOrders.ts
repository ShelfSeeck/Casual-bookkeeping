import type { CbDatabase } from '../db/schema'
import type { WorkOrder } from '../db/schema/business/workOrders'

// WorkOrdersRepository：工单表的受控读写（docs/data-model.md §5.2）。
// 前端每账户独立库 db_<phone>，当前打开的库天然只含一个账户的数据，
// 因此不需要按 accountPhone 过滤，直接操作当前库。
// query/summarize 对应 docs/spec/business-p0p1.md §5.8.1；MVP 数据量小，
// 允许全表 toArray 后在内存过滤排序，schema 索引只保留主键/唯一约束。

export interface WorkOrderFilter {
  dateFrom?: string | null       // YYYY-MM-DD，含端点
  dateTo?: string | null
  customerCode?: string | null   // 精确
  customerName?: string | null   // 包含匹配
  serviceCategory?: string | null
  serviceItem?: string | null    // null 表示"小类为空"
  isCompleted?: boolean | null
  unpricedOnly?: boolean         // unitPriceCents === null
  keyword?: string | null        // 匹配编号/客户名/大类/小类任一包含
  limit?: number
  offset?: number
}

export interface WorkOrderSummary {
  count: number
  totalQuantity: number
  totalAmountCents: number
  unpricedCount: number
}

export class WorkOrdersRepository {
  private db: CbDatabase

  constructor(db: CbDatabase) {
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

  async query(filters: WorkOrderFilter = {}): Promise<WorkOrder[]> {
    const rows = await this.db.workOrders.toArray()
    const filtered = rows.filter((o) => this.matches(o, filters))
    // 排序固定：workOrderDate DESC、createdAt DESC（docs/spec/business-p0p1.md §5.8.1）
    filtered.sort(
      (a, b) =>
        b.workOrderDate.localeCompare(a.workOrderDate) ||
        b.createdAt.localeCompare(a.createdAt),
    )
    const offset = Math.max(0, filters.offset ?? 0)
    if (filters.limit !== undefined) {
      return filtered.slice(offset, offset + Math.max(0, filters.limit))
    }
    return filtered.slice(offset)
  }

  async summarize(
    filters: Omit<WorkOrderFilter, 'limit' | 'offset'> = {},
  ): Promise<WorkOrderSummary> {
    const rows = await this.db.workOrders.toArray()
    const filtered = rows.filter((o) => this.matches(o, filters))
    let totalQuantity = 0
    let totalAmountCents = 0
    let unpricedCount = 0
    for (const o of filtered) {
      totalQuantity += o.quantity
      if (o.unitPriceCents === null) {
        unpricedCount += 1
      } else {
        totalAmountCents += o.quantity * o.unitPriceCents
      }
    }
    return {
      count: filtered.length,
      totalQuantity,
      totalAmountCents,
      unpricedCount,
    }
  }

  private matches(o: WorkOrder, f: WorkOrderFilter): boolean {
    // 软删排除（docs/spec/business-p0p1.md §5.8.1）
    if (o.deletedAt !== null) return false
    if (f.dateFrom && o.workOrderDate < f.dateFrom) return false
    if (f.dateTo && o.workOrderDate > f.dateTo) return false
    if (f.customerCode !== undefined && f.customerCode !== null && o.customerCode !== f.customerCode) return false
    if (f.customerName !== undefined && f.customerName !== null && !o.customerName.includes(f.customerName)) return false
    if (f.serviceCategory !== undefined && f.serviceCategory !== null && o.serviceCategory !== f.serviceCategory) return false
    // serviceItem: null 表示"小类为空"，与 undefined（不过滤）语义不同
    if (f.serviceItem !== undefined && o.serviceItem !== f.serviceItem) return false
    if (f.isCompleted !== undefined && f.isCompleted !== null && o.isCompleted !== f.isCompleted) return false
    if (f.unpricedOnly && o.unitPriceCents !== null) return false
    if (f.keyword) {
      const k = f.keyword
      const hit =
        o.customerCode.includes(k) ||
        o.customerName.includes(k) ||
        o.serviceCategory.includes(k) ||
        (o.serviceItem !== null && o.serviceItem.includes(k))
      if (!hit) return false
    }
    return true
  }
}
