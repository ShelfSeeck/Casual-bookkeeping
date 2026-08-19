import Dexie, { type EntityTable } from 'dexie'
import type { WorkOrder } from './schema/business/workOrders'
import { workOrdersSchema } from './schema/business/workOrders'
import type { Customer } from './schema/business/customers'
import { customersSchema } from './schema/business/customers'
import type { CustomerCodeMapping } from './schema/business/customerCodeMappings'
import { customerCodeMappingsSchema } from './schema/business/customerCodeMappings'
import type { ServiceCategory } from './schema/business/serviceCategories'
import { serviceCategoriesSchema } from './schema/business/serviceCategories'
import type { Operation } from './schema/operations/operations'
import { operationsSchema } from './schema/operations/operations'
import type { OutboxEntry } from './schema/operations/outbox'
import { outboxSchema } from './schema/operations/outbox'
import type { SyncState } from './schema/sync/syncState'
import { syncStateSchema } from './schema/sync/syncState'

export class CbDatabase extends Dexie {
  workOrders!: EntityTable<WorkOrder, 'syncId'>
  customers!: EntityTable<Customer, 'syncId'>
  customerCodeMappings!: EntityTable<CustomerCodeMapping, 'syncId'>
  serviceCategories!: EntityTable<ServiceCategory, 'syncId'>
  operations!: EntityTable<Operation, 'operationId'>
  outbox!: EntityTable<OutboxEntry, 'queueId'>
  syncState!: EntityTable<SyncState, 'accountPhone'>

  constructor(name: string) {
    super(name)
    this.version(1).stores({
      workOrders: workOrdersSchema,
      customers: customersSchema,
      customerCodeMappings: customerCodeMappingsSchema,
      serviceCategories: serviceCategoriesSchema,
      operations: operationsSchema,
      // v1 只有主键 + operationId 唯一；查询/排序索引在 v2 补上
      outbox: '++queueId, &operationId',
      syncState: syncStateSchema,
    })
    // v2：outbox 增加多值索引 entitySyncIds（同记录未决查询）、
    // status（同步器筛选）与 createdAt（按创建顺序发送）。Dexie 自动重建索引。
    this.version(2).stores({
      outbox: outboxSchema,
    })
    // v3：service_categories 新增 sortOrder；旧记录按 categoryName 升序初始化 1..n，
    // 与后端迁移规则一致。upgrade 只在旧库打开时执行一次。
    this.version(3).stores({
      serviceCategories: serviceCategoriesSchema,
    }).upgrade(async (tx) => {
      const rows = await tx.table('serviceCategories').toArray()
      const sorted = rows.sort((a, b) => a.categoryName.localeCompare(b.categoryName))
      for (let i = 0; i < sorted.length; i++) {
        await tx.table('serviceCategories').put({ ...sorted[i], sortOrder: i + 1 })
      }
    })
  }
}
