// UI 视图模型类型：组件层展示用，由 appState 从真实 Dexie 数据组装。

export interface CustomerUi {
  customerId: number
  /** 编号映射 syncId（真实数据层用） */
  syncId?: string
  customerName: string
  code: string
  displayName: string
  validFrom: string
  validTo: string | null
}

export interface SubcategoryUi {
  name: string
  defaultUnit: string
  isActive: boolean
}

export interface ServiceCategoryUi {
  categoryId: number
  /** 服务大类 syncId（真实数据层用） */
  syncId?: string
  name: string
  isActive: boolean
  sortOrder?: number
  subcategories: SubcategoryUi[]
}

export interface WorkOrderUi {
  orderId: string
  /** 工单 syncId（真实数据层用） */
  syncId?: string
  orderDate: string
  customerId: number
  customerCode: string
  customerDisplayName: string
  customerOfficialName: string
  categoryName: string
  subcategoryName: string
  quantity: number
  unit: string
  unitPriceCents: number | null // 分为单位
  syncStatus: 'synced' | 'pending' | 'conflict'
  isCompleted?: boolean
  createdAt: string
  updatedAt: string
  history?: Array<{
    operationId: string
    summary: string
    timestamp: string
    device: string | null
    actorType: 'user' | 'ai' | 'system'
    operationType: string
    canRevert: boolean
  }>
}
