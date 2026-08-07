import type { Table } from 'dexie'
import { newId } from '../utils/id'
import type { AcsDatabase } from '../db/schema'
import type { Operation } from '../db/schema/operations/operations'
import type { OutboxEntry } from '../db/schema/operations/outbox'

// MutationService：本地业务写入服务（data-model.md §6.1）。
// 一次 commit = 在同一个 IndexedDB 事务中原子完成：
//   修改业务表 + 写入 operations（pending）+ 写入 outbox（pending）。
// 事务全部成功才算"已保存到本机"，中途失败全部回滚。

export interface MutationInput {
  operationType: string
  entitySyncIds: string[]
  apply: (tx: MutationTx) => unknown
  actorType: 'user' | 'ai' | 'system'
  sourceTurnId?: string
}

export interface MutationTx {
  workOrders: Table<import('../db/schema/business/workOrders').WorkOrder, string>
  customers: Table<import('../db/schema/business/customers').Customer, string>
  customerCodeMappings: Table<import('../db/schema/business/customerCodeMappings').CustomerCodeMapping, string>
  serviceCategories: Table<import('../db/schema/business/serviceCategories').ServiceCategory, string>
}

export class MutationService {
  private db: AcsDatabase

  constructor(db: AcsDatabase) {
    this.db = db
  }

  async commit(input: MutationInput): Promise<void> {
    const operationId = newId('op')
    const now = new Date().toISOString()
    const operation: Operation = {
      operationId,
      serverSeq: null,
      actorType: input.actorType,
      operationType: input.operationType,
      syncStatus: 'pending',
      changesJson: JSON.stringify({ entitySyncIds: input.entitySyncIds }),
      createdAt: now,
      updatedAt: now,
    }
    const outbox: Omit<OutboxEntry, 'queueId'> = {
      operationId,
      operationType: input.operationType,
      entitySyncIds: input.entitySyncIds,
      command: { changes: input.entitySyncIds },
      status: 'pending',
      attempts: 0,
      nextRetryAt: null,
      sendingStartedAt: null,
      lastErrorJson: null,
      actorType: input.actorType,
      sourceTurnId: input.sourceTurnId ?? null,
      conflictJson: null,
      createdAt: now,
    }

    await this.db.transaction('rw', [
      this.db.workOrders,
      this.db.customers,
      this.db.customerCodeMappings,
      this.db.serviceCategories,
      this.db.operations,
      this.db.outbox,
    ], async (tx) => {
      const txApi: MutationTx = {
        workOrders: tx.table('workOrders'),
        customers: tx.table('customers'),
        customerCodeMappings: tx.table('customerCodeMappings'),
        serviceCategories: tx.table('serviceCategories'),
      }
      await input.apply(txApi)
      await tx.table('operations').add(operation)
      await tx.table('outbox').add(outbox)
    })
  }
}
