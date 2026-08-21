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

export interface CustomerMappingUi {
  syncId: string
  customerId: number
  customerCode: string
  customerName: string
  canonicalName: string
  validFrom: string
  validTo: string | null
}

export interface CustomerEntityUi {
  customerId: number
  syncId: string
  canonicalName: string
  archivedAt: string | null
  activeCodes: string[]
  mappings: CustomerMappingUi[]
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

export interface HistoryDiffUi {
  fieldKey: string
  fieldLabel: string
  beforeValue?: unknown
  afterValue?: unknown
  beforeText: string
  afterText: string
}

export type HistoryIconType = 'create' | 'update' | 'price' | 'complete' | 'revert' | 'other'

export interface HistoryItemUi {
  operationId: string
  summary: string
  timestamp: string
  formattedTime?: string
  device: string | null
  deviceLabel?: string
  actorType: 'user' | 'ai' | 'system'
  actorLabel?: string
  operationType: string
  iconType?: HistoryIconType
  canRevert: boolean
  isReverted?: boolean
  revertsOperationId?: string | null
  diffs?: HistoryDiffUi[]
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
  history?: HistoryItemUi[]
}

