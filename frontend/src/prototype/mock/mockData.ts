export interface MockCustomer {
  customerId: number
  customerName: string
  code: string
  displayName: string
  validFrom: string
  validTo: string | null
}

export interface MockSubcategory {
  name: string
  defaultUnit: string
  isActive: boolean
}

export interface MockCategory {
  categoryId: number
  name: string
  isActive: boolean
  subcategories: MockSubcategory[]
}

export interface MockWorkOrder {
  orderId: string
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
  createdAt: string
  updatedAt: string
  history?: Array<{
    operationId: string
    timestamp: string
    summary: string
    device: string
  }>
}

export const INITIAL_CUSTOMERS: MockCustomer[] = [
  {
    customerId: 1,
    customerName: '广州张记服饰有限公司',
    code: '001',
    displayName: '张老板',
    validFrom: '2026-01-01',
    validTo: null,
  },
  {
    customerId: 2,
    customerName: '佛山卓越制衣实业',
    code: '002',
    displayName: '李厂',
    validFrom: '2026-01-01',
    validTo: null,
  },
  {
    customerId: 3,
    customerName: '金达外贸服饰制造厂',
    code: '003',
    displayName: '金达',
    validFrom: '2026-01-01',
    validTo: null,
  },
  {
    customerId: 4,
    customerName: '东莞顺发洗染纺织有限公司',
    code: '008',
    displayName: '顺发',
    validFrom: '2026-01-01',
    validTo: null,
  },
  {
    customerId: 5,
    customerName: '恒达牛仔水洗厂',
    code: '012',
    displayName: '恒达',
    validFrom: '2026-01-01',
    validTo: null,
  },
]

export const INITIAL_CATEGORIES: MockCategory[] = [
  {
    categoryId: 1,
    name: '洗水',
    isActive: true,
    subcategories: [
      { name: '单洗', defaultUnit: '件', isActive: true },
      { name: '普洗', defaultUnit: '件', isActive: true },
      { name: '酵洗', defaultUnit: '件', isActive: true },
      { name: '重酵', defaultUnit: '件', isActive: true },
      { name: '套色', defaultUnit: '件', isActive: true },
    ],
  },
  {
    categoryId: 2,
    name: '刷毛',
    isActive: true,
    subcategories: [
      { name: '单面刷毛', defaultUnit: '件', isActive: true },
      { name: '双面刷毛', defaultUnit: '件', isActive: true },
      { name: '抓剪毛', defaultUnit: '件', isActive: true },
    ],
  },
  {
    categoryId: 3,
    name: '车缝',
    isActive: true,
    subcategories: [
      { name: '锁边打枣', defaultUnit: '包', isActive: true },
      { name: '改领换标', defaultUnit: '条', isActive: true },
      { name: '平车修补', defaultUnit: '件', isActive: true },
    ],
  },
]

export const INITIAL_WORK_ORDERS: MockWorkOrder[] = [
  {
    orderId: 'wo_20260815_001',
    orderDate: '2026-08-15',
    customerId: 1,
    customerCode: '001',
    customerDisplayName: '张老板',
    customerOfficialName: '广州张记服饰有限公司',
    categoryName: '洗水',
    subcategoryName: '酵洗',
    quantity: 3200,
    unit: '件',
    unitPriceCents: 150, // ¥1.50
    syncStatus: 'synced',
    createdAt: '2026-08-15 09:30:00',
    updatedAt: '2026-08-15 09:30:00',
    history: [
      {
        operationId: 'op_101',
        timestamp: '2026-08-15 09:30:00',
        summary: '创建工单：3200件 / 酵洗 (单价 ¥1.50)',
        device: '车间主手机 (dev_a1)',
      },
    ],
  },
  {
    orderId: 'wo_20260815_002',
    orderDate: '2026-08-15',
    customerId: 2,
    customerCode: '002',
    customerDisplayName: '李厂',
    customerOfficialName: '佛山卓越制衣实业',
    categoryName: '刷毛',
    subcategoryName: '双面刷毛',
    quantity: 1500,
    unit: '件',
    unitPriceCents: 280, // ¥2.80
    syncStatus: 'synced',
    createdAt: '2026-08-15 10:15:00',
    updatedAt: '2026-08-15 11:20:00',
    history: [
      {
        operationId: 'op_102',
        timestamp: '2026-08-15 10:15:00',
        summary: '创建工单：1500件 / 双面刷毛',
        device: '车间主手机 (dev_a1)',
      },
      {
        operationId: 'op_103',
        timestamp: '2026-08-15 11:20:00',
        summary: '更新单价为 ¥2.80',
        device: '车间主手机 (dev_a1)',
      },
    ],
  },
  {
    orderId: 'wo_20260815_003',
    orderDate: '2026-08-15',
    customerId: 3,
    customerCode: '003',
    customerDisplayName: '金达',
    customerOfficialName: '金达外贸服饰制造厂',
    categoryName: '洗水',
    subcategoryName: '普洗',
    quantity: 800,
    unit: '件',
    unitPriceCents: null, // 未定价
    syncStatus: 'pending',
    createdAt: '2026-08-15 13:05:00',
    updatedAt: '2026-08-15 13:05:00',
    history: [
      {
        operationId: 'op_104',
        timestamp: '2026-08-15 13:05:00',
        summary: '创建工单：800件 / 普洗 (待定价)',
        device: '车间主手机 (dev_a1)',
      },
    ],
  },
  {
    orderId: 'wo_20260814_001',
    orderDate: '2026-08-14',
    customerId: 1,
    customerCode: '001',
    customerDisplayName: '张老板',
    customerOfficialName: '广州张记服饰有限公司',
    categoryName: '洗水',
    subcategoryName: '重酵',
    quantity: 4500,
    unit: '件',
    unitPriceCents: 220,
    syncStatus: 'synced',
    createdAt: '2026-08-14 14:00:00',
    updatedAt: '2026-08-14 18:30:00',
  },
  {
    orderId: 'wo_20260814_002',
    orderDate: '2026-08-14',
    customerId: 4,
    customerCode: '008',
    customerDisplayName: '顺发',
    customerOfficialName: '东莞顺发洗染纺织有限公司',
    categoryName: '车缝',
    subcategoryName: '改领换标',
    quantity: 600,
    unit: '条',
    unitPriceCents: 120,
    syncStatus: 'synced',
    createdAt: '2026-08-14 16:20:00',
    updatedAt: '2026-08-14 17:00:00',
  },
  {
    orderId: 'wo_20260813_001',
    orderDate: '2026-08-13',
    customerId: 2,
    customerCode: '002',
    customerDisplayName: '李厂',
    customerOfficialName: '佛山卓越制衣实业',
    categoryName: '洗水',
    subcategoryName: '套色',
    quantity: 2100,
    unit: '件',
    unitPriceCents: 350,
    syncStatus: 'synced',
    createdAt: '2026-08-13 11:00:00',
    updatedAt: '2026-08-13 16:40:00',
  },
]
