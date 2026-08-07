// 服务选项表，对应后端 service_categories（docs/data-model.md §4.2）。
// 一行 = 一个服务大类及其全部小类配置；以 syncId 为主键。

export interface Subcategory {
  name: string
  defaultUnit: string
  isActive: boolean
}

export interface ServiceCategory {
  syncId: string
  accountPhone: string
  categoryName: string
  subcategoriesJson: Subcategory[]
  isActive: boolean
  rowVersion: number
  createdAt: string
  updatedAt: string
}

export const serviceCategoriesSchema = 'syncId'
