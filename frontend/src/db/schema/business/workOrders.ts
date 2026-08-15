// 工单业务表，对应后端 work_orders（docs/data-model.md §4.5）。
// 一行 = 一次完整工单记录；以 syncId 为主键，保存录入时的文本快照。

export interface WorkOrder {
  syncId: string
  accountPhone: string
  workOrderDate: string
  customerId: number
  customerCode: string
  customerName: string
  serviceCategory: string
  serviceItem: string | null
  quantity: number
  unit: string
  unitPriceCents: number | null
  isCompleted: boolean
  rowVersion: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export const workOrdersSchema = 'syncId'
