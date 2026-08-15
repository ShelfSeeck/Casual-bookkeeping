import type { Table } from 'dexie'
import { newId } from '../utils/id'
import type { CbDatabase } from '../db/schema'
import type { Operation } from '../db/schema/operations/operations'
import type { OutboxEntry } from '../db/schema/operations/outbox'

// MutationService：本地业务写入服务（data-model.md §6.1）。
// 一次 commit = 在同一个 IndexedDB 事务中原子完成：
//   修改业务表 + 写入 operations（pending）+ 写入 outbox（pending）。
// 事务全部成功才算"已保存到本机"，中途失败全部回滚。

export interface MutationChange {
  entitySyncId: string
  /** 实体类型（wire entity_type）。单实体操作可省略，由 operationType 推导；
   *  跨实体操作（create_customer_with_mapping / archive_customer_with_mappings）
   *  必须逐 change 标注（docs/spec/business-p0p1.md §5.6）。 */
  entityType?: string
  /** 修改前服务端确认的版本（create 为 0）；取自本地记录的 rowVersion */
  baseVersion: number
  /** 修改前快照，冲突三方对比的 Base（data-model.md §6.3） */
  baseSnapshot?: Record<string, unknown>
  /** 这次操作希望改变的业务字段 */
  patch?: Record<string, unknown>
}

export interface MutationInput {
  operationType: string
  entitySyncIds: string[]
  /** outbox.command.changes：缺省时按 create（baseVersion=0）生成 */
  changes?: MutationChange[]
  /** 撤回操作指向的原操作 ID；写入 outbox.command.reverts_operation_id（docs/data-model.md §6.5） */
  revertsOperationId?: string
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

/** 单记录 gate 错误：目标记录在 outbox 有 conflict/rejected 未决条目（docs/sync-protocol.md §8）。 */
export class RecordGatedError extends Error {
  constructor(blockedSyncIds: string[]) {
    super(`record_gated:${blockedSyncIds.join(',')}`)
  }
}

export class MutationService {
  private db: CbDatabase

  constructor(db: CbDatabase) {
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
      revertsOperationId: input.revertsOperationId ?? null,
      changesJson: JSON.stringify({ entitySyncIds: input.entitySyncIds }),
      createdAt: now,
      updatedAt: now,
    }
    const changes: MutationChange[] = input.changes ?? input.entitySyncIds.map((id) => ({
      entitySyncId: id,
      baseVersion: 0,
    }))
    // outbox.command.changes 原样保留 entityType（docs/spec/business-p0p1.md §5.6）：
    // 跨实体操作依赖逐 change 的 entityType，提交时不能丢字段。
    const commandChanges = changes.map((c) => ({
      entitySyncId: c.entitySyncId,
      baseVersion: c.baseVersion,
      ...(c.entityType !== undefined ? { entityType: c.entityType } : {}),
      ...(c.baseSnapshot !== undefined ? { baseSnapshot: c.baseSnapshot } : {}),
      ...(c.patch !== undefined ? { patch: c.patch } : {}),
    }))
    const outbox: Omit<OutboxEntry, 'queueId'> = {
      operationId,
      operationType: input.operationType,
      entitySyncIds: input.entitySyncIds,
      command: input.revertsOperationId
        ? { changes: commandChanges, reverts_operation_id: input.revertsOperationId }
        : { changes: commandChanges },
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
      // 单记录 gate（docs/sync-protocol.md §8）：conflict/rejected 未决条目禁止再写该记录，
      // 必须先解决冲突；pending 允许（保序）。查询在事务内做，保证与写入同读同写视图。
      const outboxEntries = await tx.table('outbox').toArray()
      const blocked = input.entitySyncIds.filter((id) =>
        outboxEntries.some(
          (e) =>
            (e.status === 'conflict' || e.status === 'rejected') &&
            e.entitySyncIds.includes(id),
        ),
      )
      if (blocked.length > 0) throw new RecordGatedError(blocked)

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
