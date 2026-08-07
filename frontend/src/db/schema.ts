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

export class AcsDatabase extends Dexie {
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
      outbox: outboxSchema,
      syncState: syncStateSchema,
    })
  }
}
