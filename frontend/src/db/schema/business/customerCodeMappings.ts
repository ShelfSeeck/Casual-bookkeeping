// 客户编号映射表，对应后端 customer_code_mappings（docs/data-model.md §4.4）。
// 一行 = 某个客户编号在一个明确时期内对应的真实客户和显示人名；以 syncId 为主键。

export interface CustomerCodeMapping {
  syncId: string
  accountPhone: string
  customerId: number
  customerCode: string
  customerName: string
  validFrom: string
  validTo: string | null
  rowVersion: number
  createdAt: string
  updatedAt: string
}

export const customerCodeMappingsSchema = 'syncId'
