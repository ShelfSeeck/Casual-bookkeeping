// 真实客户表，对应后端 customers（docs/data-model.md §4.3）。
// 一行 = 一个长期稳定的真实厂家/客户对象；以 syncId 为主键。

export interface Customer {
  syncId: string
  accountPhone: string
  customerId: number
  canonicalName: string
  archivedAt: string | null
  rowVersion: number
  createdAt: string
  updatedAt: string
}

export const customersSchema = 'syncId'
