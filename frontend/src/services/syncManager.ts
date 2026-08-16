import type { CbDatabase } from '../db/schema'
import type { OutboxEntry } from '../db/schema/operations/outbox'
import { getOrCreateDeviceId } from '../db/device'
import { newId } from '../utils/id'
import { backoff } from './backoff'
import {
  analyzeConflict,
  buildMergedPatch,
  stripWireMetaFields,
  type ConflictResolution,
} from './conflictResolver'

// SyncManager：同步循环（docs/sync-protocol.md §3.3 / §6 / §7 / §8 / §9 / §10）
// 每轮：Push 全部 outbox（保序、逐条结果）→ 无 pending/sending 后 Pull → 清理历史。
// 约束：
// - 存在 pending / sending 不 Pull；仅剩 conflict / rejected 允许 Pull（材料保留在 outbox）
// - 同步循环单飞：并发调用只跑一轮
// - Pull 应用用 put（按 operationId 幂等覆盖），不跳过自己已 push 的操作
// - conflict / rejected 不自动重试（等用户 resolveConflict）
// - 网络错误：退回 pending + attempts++ + nextRetryAt（退避），不卡死循环
// - 应用重启时 sending 挂起恢复 pending（沿用原 operation_id 重试）

export const PUSH_BATCH_SIZE = 500

export interface PushChange {
  entityType: string
  entitySyncId: string
  baseVersion: number
  fields: Record<string, unknown>
}

export interface PushOperation {
  operationId: string
  operationType: string
  actorType: 'user' | 'ai' | 'system'
  sourceTurnId: string | null
  revertsOperationId: string | null
  changes: PushChange[]
}

export interface PushResult {
  operationId: string
  status: 'accepted' | 'conflict' | 'rejected'
  serverSeq?: number
  rowVersions?: Record<string, number>
  conflictJson?: unknown
  errors?: { entitySyncId: string; errorCode: string }[]
}

export interface PullChange {
  entityType: string
  entitySyncId: string
  changeType: string
  afterJson: string
  afterVersion: number
  /** 变更前快照（create 为 null）；Pull 新字段，旧后端可能缺省 */
  beforeJson?: string | null
  /** 变更字段展示 JSON（对象或数组的 JSON 字符串）；Pull 新字段，旧后端可能缺省 */
  changedFieldsJson?: string | null
}

export interface PullOperation {
  serverSeq: number
  operationId: string
  operationType: string
  /** 操作来源：user / ai / system；旧后端缺省或非法值由 syncApi 回退为 user */
  actorType: 'user' | 'ai' | 'system'
  /** 产生该操作的设备 ID；旧后端可能缺省 → null */
  deviceId: string | null
  revertsOperationId: string | null
  createdAt: string
  changes: PullChange[]
}

export interface PullResult {
  operations: PullOperation[]
  hasMore: boolean
}

export interface BootstrapData {
  snapshotSeq: number
  hasMore: boolean
  customers: unknown[]
  serviceCategories: unknown[]
  workOrders: unknown[]
  customerCodeMappings: unknown[]
}

export interface SyncApi {
  push(operations: PushOperation[]): Promise<{ results: PushResult[] }>
  pull(after: number, limit?: number): Promise<PullResult>
  bootstrap(): Promise<BootstrapData>
}

export interface SyncStatusCallbacks {
  onStatusChange: (status: SyncStatus) => void
  /** 本地数据被同步进程改写后（bootstrap 落库 / Pull 覆盖）通知上层刷新列表。
   *  App.vue 用它触发 appState.reload；未传则保持旧行为（调用方自己轮询）。 */
  onDataChange?: () => void | Promise<void>
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'conflict' | 'error'
  message?: string
}

/** outbox.command.changes 里一条变更的结构（data-model.md §6.3）。 */
interface OutboxCommandChange {
  entitySyncId: string
  /** 跨实体操作逐 change 标注实体类型（docs/spec/business-p0p1.md §5.6）。 */
  entityType?: string
  baseVersion: number
  baseSnapshot?: Record<string, unknown>
  patch?: Record<string, unknown>
}

/** 冲突响应 conflict_json：Theirs 为服务端当前状态（docs/sync-protocol.md §4.1）。 */
interface ConflictJson {
  entity_type: string
  entity_sync_id: string
  theirs: Record<string, unknown>
}

export interface SyncManagerOptions {
  /** 单次 Push 的最大条数（后端批量上限 500，见 docs/sync-protocol.md §5）；测试可调小。 */
  pushBatchSize?: number
  /** 当前账户是否仍是同步启动时的账户；false 表示已登出/切换账户，应中止本轮同步。 */
  isCurrentAccount?: () => boolean
}

export class SyncManager {
  private db: CbDatabase
  private api: SyncApi
  private callbacks: SyncStatusCallbacks
  private pushBatchSize: number
  private isCurrentAccount?: () => boolean
  private running = false

  constructor(
    db: CbDatabase,
    api: SyncApi,
    callbacks: SyncStatusCallbacks,
    options: SyncManagerOptions = {},
  ) {
    this.db = db
    this.api = api
    this.callbacks = callbacks
    this.pushBatchSize = options.pushBatchSize ?? PUSH_BATCH_SIZE
    this.isCurrentAccount = options.isCurrentAccount
  }

  /** 同步循环（单飞）：并发调用只跑一轮，其余共享。 */
  async sync(): Promise<void> {
    if (this.isCurrentAccount && !this.isCurrentAccount()) return
    if (this.running) return
    this.running = true
    this.callbacks.onStatusChange({ state: 'syncing' })
    try {
      await this.runOnce()
      this.callbacks.onStatusChange({ state: 'idle' })
    } catch (e) {
      this.callbacks.onStatusChange({ state: 'error', message: (e as Error).message })
      throw e
    } finally {
      this.running = false
    }
  }

  /** 初始化：恢复 sending 挂起 → 本地无进度且 outbox 无未决才 bootstrap；否则直接同步。 */
  async init(): Promise<void> {
    await this.recoverStuckSending()
    const phone = this.db.name.replace('db_', '')
    const state = await this.db.syncState.get(phone)
    // data-model.md §5.4：bootstrap 不能覆盖仍有 pending/conflict 数据的本地库。
    // 有未决 outbox 时先同步（Push 后 Pull 收敛），不清空业务表。
    const hasUnresolved = (await this.db.outbox.count()) > 0
    if ((state === undefined || state.appliedServerSeq === 0) && !hasUnresolved) {
      await this.bootstrap()
    }
  }

  async bootstrap(): Promise<void> {
    const data = await this.api.bootstrap()
    const phone = this.db.name.replace('db_', '')
    // meta 库访问在事务外，deviceId 先取好
    const deviceId = await getOrCreateDeviceId()
    await this.db.transaction('rw', this.db.tables, async () => {
      await this.db.workOrders.clear()
      await this.db.customers.clear()
      await this.db.customerCodeMappings.clear()
      await this.db.serviceCategories.clear()
      for (const c of data.customers) {
        await this.db.customers.put(toCamelRecord(c as Record<string, unknown>) as never)
      }
      for (const c of data.serviceCategories) {
        await this.db.serviceCategories.put(
          normalizeServiceCategory(toCamelRecord(c as Record<string, unknown>)) as never,
        )
      }
      for (const o of data.workOrders) {
        await this.db.workOrders.put(
          normalizeWorkOrder(toCamelRecord(o as Record<string, unknown>)) as never,
        )
      }
      for (const m of data.customerCodeMappings) {
        await this.db.customerCodeMappings.put(toCamelRecord(m as Record<string, unknown>) as never)
      }
      await this.db.syncState.put({
        accountPhone: phone,
        deviceId,
        appliedServerSeq: data.snapshotSeq,
        lastSyncAt: new Date().toISOString(),
      })
    })
    // bootstrap 后立即 Pull 增量
    if (data.hasMore || data.snapshotSeq > 0) {
      await this.pullAll()
    }
    // 首次登录场景：本地库刚被整包覆盖，必须通知上层刷新 UI 列表
    await this.callbacks.onDataChange?.()
  }

  /**
   * 丢弃整条冲突（docs/sync-protocol.md §5 冲突/rejected 可丢弃）：放弃本机修改，
   * 服务端 Theirs 保留；移除 outbox 冲突条目与 operations 镜像，不生成新操作。
   */
  async discardConflict(queueId: number): Promise<void> {
    await this.db.transaction('rw', [this.db.outbox, this.db.operations], async () => {
      const entry = await this.db.outbox.get(queueId)
      if (!entry) throw new Error('outbox_entry_not_found')
      if (entry.status !== 'conflict') throw new Error('not_a_conflict_entry')
      await this.db.outbox.delete(queueId)
      await this.db.operations.delete(entry.operationId)
    })
  }

  /**
   * 解决冲突（docs/sync-protocol.md §7）：以 Theirs 当前 row_version 为 base_version、
   * 合并结果为新 patch，生成新 operation（新 operation_id）重新走 Push。
   * 原冲突操作从 outbox 移除。resolution 覆盖该条冲突记录所有 both 字段的决策。
   */
  async resolveConflict(
    queueId: number,
    resolution: ConflictResolution,
  ): Promise<void> {
    const now = new Date().toISOString()
    await this.db.transaction('rw', [this.db.outbox, this.db.operations], async () => {
      const entry = await this.db.outbox.get(queueId)
      if (!entry) throw new Error('outbox_entry_not_found')
      if (entry.status !== 'conflict') throw new Error('not_a_conflict_entry')
      const conflictJson = entry.conflictJson as ConflictJson | null
      if (!conflictJson) throw new Error('conflict_json_missing')
      const changes = (entry.command as { changes?: OutboxCommandChange[] }).changes
      if (!changes || changes.length === 0) throw new Error('no_changes_to_merge')

      // 仅合并冲突的那条 change；其余 change 保持原 base_version / patch
      // （整条操作未提交，其余记录在服务端仍是原版本）。
      const conflictingId = conflictJson.entity_sync_id
      const mergedChanges = changes.map((c) => {
        if (c.entitySyncId !== conflictingId) {
          return {
            entitySyncId: c.entitySyncId,
            ...(c.entityType !== undefined ? { entityType: c.entityType } : {}),
            baseVersion: c.baseVersion,
            baseSnapshot: c.baseSnapshot,
            patch: c.patch,
          }
        }
        const base = stripWireMetaFields(c.baseSnapshot ?? {})
        const ours = stripWireMetaFields({ ...(c.baseSnapshot ?? {}), ...(c.patch ?? {}) })
        const theirs = stripWireMetaFields(conflictJson.theirs)
        const analysis = analyzeConflict(base, ours, theirs)
        const mergedPatch = buildMergedPatch(analysis, resolution)
        const rowVersion =
          typeof conflictJson.theirs.row_version === 'number'
            ? conflictJson.theirs.row_version
            : 0
        return {
          entitySyncId: c.entitySyncId,
          ...(c.entityType !== undefined ? { entityType: c.entityType } : {}),
          baseVersion: rowVersion,
          patch: stripWireMetaFields(mergedPatch),
        }
      })

      // 新合并操作（pending），原冲突操作移除（outbox + operations 镜像）
      const newOperationId = newId('op')
      // 保留撤回意图：原命令带 reverts_operation_id（撤回操作冲突后重推仍是撤回）
      const revertsOperationId = (
        entry.command as { reverts_operation_id?: string } | null
      )?.reverts_operation_id ?? null
      await this.db.outbox.add({
        operationId: newOperationId,
        operationType: entry.operationType,
        entitySyncIds: entry.entitySyncIds,
        command: {
          changes: mergedChanges,
          ...(revertsOperationId ? { reverts_operation_id: revertsOperationId } : {}),
        },
        status: 'pending',
        attempts: 0,
        nextRetryAt: null,
        sendingStartedAt: null,
        lastErrorJson: null,
        actorType: entry.actorType,
        sourceTurnId: entry.sourceTurnId,
        conflictJson: null,
        createdAt: now,
      })
      const oldMirror = await this.db.operations.get(entry.operationId)
      await this.db.operations.add({
        operationId: newOperationId,
        serverSeq: null,
        actorType: entry.actorType,
        operationType: entry.operationType,
        syncStatus: 'pending',
        revertsOperationId,
        deviceId: oldMirror?.deviceId ?? null,
        changesJson: JSON.stringify({ entitySyncIds: entry.entitySyncIds }),
        createdAt: now,
        updatedAt: now,
      })
      await this.db.outbox.delete(entry.queueId)
      await this.db.operations.delete(entry.operationId)
    })
  }

  /** 本地历史保留（docs/sync-protocol.md §10）：只清 synced 且超过窗口的旧记录（30 天或 500 条）；未决永不清理。 */
  async pruneLocalHistory(): Promise<void> {
    const KEEP_MS = 30 * 24 * 3600 * 1000
    const MAX_KEEP = 500
    const cutoff = Date.now() - KEEP_MS
    const all = await this.db.operations.toArray()
    const synced = all
      .filter((o) => o.syncStatus === 'synced')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    // 保留最近 500 条 synced 中的最新者；其余仅当 30 天前才清
    const keepLatest = synced.slice(-MAX_KEEP)
    const toDelete = synced.filter(
      (o) => !keepLatest.includes(o) && new Date(o.createdAt).getTime() < cutoff,
    )
    if (toDelete.length === 0) return
    await this.db.transaction('rw', this.db.operations, async () => {
      for (const op of toDelete) {
        await this.db.operations.delete(op.operationId)
      }
    })
  }

  // ---------- 私有 ----------

  private isAccountCurrent(): boolean {
    return this.isCurrentAccount ? this.isCurrentAccount() : true
  }

  /** 账户已切换/登出时中止本轮同步（会话级中止，不属于网络错误，不退避）。 */
  private assertCurrentAccount(): void {
    if (!this.isAccountCurrent()) {
      throw new Error('account_changed')
    }
  }

  private async runOnce(): Promise<void> {
    this.assertCurrentAccount()
    // 启动恢复：应用重启后，超时停留在 sending 的恢复为 pending（沿用原 operation_id 重试）
    await this.recoverStuckSending()

    // 1. Push 全部 outbox（按 queueId 升序保序）
    // status 索引只取 pending；queueId 排序复用主键顺序。
    const pending = await this.db.outbox.where('status').equals('pending').sortBy('queueId')
    if (pending.length > 0) {
      // Push 前校验 operationType 可映射，未知类型直接抛错、不静默写错表。
      // revert_operation 的 command.changes 为空、由后端按 reverts_operation_id 展开，
      // 不参与 entityTypeFor 映射，预检放行（否则撤回永远 pending 并阻塞后续 Push）。
      const unknown = pending.find(
        (e) => e.operationType !== 'revert_operation' && entityTypeFor(e.operationType) === null,
      )
      if (unknown) {
        throw new Error(`unknown_operation_type:${unknown.operationType}`)
      }
      this.assertCurrentAccount()
      await this.markSending(pending)
      try {
        // 分批推送（后端批量上限 500 / 请求体 1MB，超出客户端拆批）
        for (let i = 0; i < pending.length; i += this.pushBatchSize) {
          this.assertCurrentAccount()
          const chunk = pending.slice(i, i + this.pushBatchSize)
          const operations = chunk.map((e) => this.toPushOperation(e))
          const { results } = await this.api.push(operations)
          await this.applyPushResults(chunk, results)
        }
      } catch (e) {
        // 网络错误：退回 pending + attempts++ + nextRetryAt（退避），不卡死循环；
        // 账户已切换/登出是会话级中止，不执行退避/恢复 sending。
        if (this.isAccountCurrent()) {
          await this.revertOnNetworkError(pending, e)
        }
        throw e
      }
    }

    // 2. 仍存在 pending / sending（未决待推）不 Pull；
    //    仅剩 conflict / rejected 时允许 Pull：材料保留在 outbox，业务表可被 Pull 快照覆盖。
    const inFlight = await this.db.outbox
      .where('status').anyOf('pending', 'sending').count()
    if (inFlight === 0) {
      await this.pullAll()
      await this.pruneLocalHistory()
    }
  }

  private toPushOperation(entry: OutboxEntry): PushOperation {
    return buildPushOperation(entry)
  }

  /** pending → sending，记录 sendingStartedAt（判断中断后挂起的发送任务）。 */
  private async markSending(entries: OutboxEntry[]): Promise<void> {
    const now = new Date().toISOString()
    await this.db.transaction('rw', this.db.outbox, async () => {
      for (const e of entries) {
        await this.db.outbox.update(e.queueId, {
          status: 'sending',
          sendingStartedAt: now,
        })
      }
    })
  }

  /** 网络错误：仍处于 sending 的条目退回 pending，attempts++，nextRetryAt 按退避设置。 */
  private async revertOnNetworkError(
    entries: OutboxEntry[],
    err: unknown,
  ): Promise<void> {
    const now = new Date().toISOString()
    const message = (err as Error).message
    await this.db.transaction('rw', this.db.outbox, async () => {
      for (const e of entries) {
        const current = await this.db.outbox.get(e.queueId)
        if (current && current.status === 'sending') {
          const attempts = current.attempts ?? 0
          await this.db.outbox.update(e.queueId, {
            status: 'pending',
            attempts: attempts + 1,
            nextRetryAt: new Date(Date.now() + backoff(attempts)).toISOString(),
            sendingStartedAt: null,
            lastErrorJson: JSON.stringify({ error: message, at: now }),
          })
        }
      }
    })
  }

  /** 应用重启时：sending 挂起恢复 pending（沿用原 operation_id 重试）。 */
  private async recoverStuckSending(): Promise<void> {
    await this.db.transaction('rw', this.db.outbox, async () => {
      const stuck = await this.db.outbox
        .where('status').equals('sending')
        .toArray()
      for (const e of stuck) {
        await this.db.outbox.update(e.queueId, {
          status: 'pending',
          sendingStartedAt: null,
        })
      }
    })
  }

  /** Push 结果原子应用（docs/sync-protocol.md §4.1）：删 outbox + 写 operations 镜像 + 回写 rowVersion 在同一个事务。 */
  private async applyPushResults(
    entries: OutboxEntry[],
    results: PushResult[],
  ): Promise<void> {
    const now = new Date().toISOString()
    let hadConflict = false
    await this.db.transaction('rw', [
      this.db.workOrders,
      this.db.customers,
      this.db.customerCodeMappings,
      this.db.serviceCategories,
      this.db.outbox,
      this.db.operations,
    ], async () => {
      for (const result of results) {
        const entry = entries.find((e) => e.operationId === result.operationId)
        if (!entry) continue
        if (result.status === 'accepted') {
          // 回写服务端确认的 rowVersion（docs/spec/business-p0p1.md §5.7），
          // 与删 outbox、operations 标 synced 同事务，避免本地版本停留在旧值导致假冲突。
          await this.writeBackRowVersions(entry, result.rowVersions ?? {})
          const mirror = await this.db.operations.get(entry.operationId)
          await this.db.outbox.delete(entry.queueId)
          await this.db.operations.put({
            operationId: entry.operationId,
            serverSeq: result.serverSeq ?? null,
            actorType: entry.actorType,
            operationType: entry.operationType,
            syncStatus: 'synced',
            // 保留撤回关系（撤回操作 command 里带 reverts_operation_id，见 OutboxCommand）
            revertsOperationId: this.revertsOf(entry),
            deviceId: mirror?.deviceId ?? null,
            changesJson: JSON.stringify({ entitySyncIds: entry.entitySyncIds }),
            createdAt: entry.createdAt,
            updatedAt: now,
          })
        } else if (result.status === 'conflict') {
          await this.db.outbox.update(entry.queueId, {
            status: 'conflict',
            conflictJson: result.conflictJson ?? null,
          })
          hadConflict = true
        } else if (result.status === 'rejected') {
          await this.db.outbox.update(entry.queueId, {
            status: 'rejected',
            lastErrorJson: JSON.stringify(result.errors ?? []),
          })
        }
      }
    })
    if (hadConflict) {
      this.callbacks.onStatusChange({ state: 'conflict' })
    }
  }

  /** 把 accepted 结果里的 row_versions 按 syncId 回写到四张业务表对应记录。 */
  private async writeBackRowVersions(
    entry: OutboxEntry,
    rowVersions: Record<string, number>,
  ): Promise<void> {
    const command = entry.command as {
      changes?: OutboxCommandChange[]
    }
    const entityTypeBySyncId = new Map<string, string>()
    for (const c of command.changes ?? []) {
      const entityType = c.entityType ?? entityTypeFor(entry.operationType)
      if (entityType) entityTypeBySyncId.set(c.entitySyncId, entityType)
    }

    for (const [syncId, rowVersion] of Object.entries(rowVersions)) {
      let entityType = entityTypeBySyncId.get(syncId)
      if (!entityType) {
        entityType = await this.findBusinessEntityType(syncId)
      }
      if (!entityType) continue
      await this.updateBusinessRowVersion(entityType, syncId, rowVersion)
    }
  }

  private async findBusinessEntityType(syncId: string): Promise<string | undefined> {
    if (await this.db.workOrders.get(syncId)) return 'work_order'
    if (await this.db.customers.get(syncId)) return 'customer'
    if (await this.db.customerCodeMappings.get(syncId)) return 'customer_code_mapping'
    if (await this.db.serviceCategories.get(syncId)) return 'service_category'
    return undefined
  }

  private async updateBusinessRowVersion(
    entityType: string,
    syncId: string,
    rowVersion: number,
  ): Promise<void> {
    if (entityType === 'work_order') {
      await this.db.workOrders.update(syncId, { rowVersion })
    } else if (entityType === 'customer') {
      await this.db.customers.update(syncId, { rowVersion })
    } else if (entityType === 'customer_code_mapping') {
      await this.db.customerCodeMappings.update(syncId, { rowVersion })
    } else if (entityType === 'service_category') {
      await this.db.serviceCategories.update(syncId, { rowVersion })
    }
  }

  private async pullAll(): Promise<void> {
    const phone = this.db.name.replace('db_', '')
    const state = await this.db.syncState.get(phone)
    let after = state?.appliedServerSeq ?? 0

    let hasMore = true
    while (hasMore) {
      this.assertCurrentAccount()
      const page = await this.api.pull(after, 200)
      await this.applyPullPage(page)
      after = this.lastSeq(page.operations)
      hasMore = page.hasMore
      if (page.operations.length === 0) break
    }
  }

  private async applyPullPage(page: PullResult): Promise<void> {
    const phone = this.db.name.replace('db_', '')
    if (page.operations.length === 0) return
    // meta 库访问在事务外（避免跨库事务），deviceId 先取好
    const deviceId = await getOrCreateDeviceId()
    await this.db.transaction('rw', this.db.tables, async () => {
      for (const op of page.operations) {
        for (const change of op.changes) {
          // 用 after_json 覆盖业务表对应记录；不执行"移除记录"动作（软删由快照表达）
          if (change.afterJson) {
            const record = toCamelRecord(JSON.parse(change.afterJson))
            await this.putToTable(change.entityType, record)
          }
        }
        // operations 镜像用 put（按 operationId 幂等覆盖），不跳过自己已 push 的操作。
        // changesJson 新形状：{ entitySyncIds, changes }；changes 为 Pull 解析后的数组
        // （含 afterJson / beforeJson / changedFieldsJson 等，供历史载荷展示）。
        const entitySyncIds = [...new Set(op.changes.map((c) => c.entitySyncId))]
        await this.db.operations.put({
          operationId: op.operationId,
          serverSeq: op.serverSeq,
          actorType: op.actorType,
          operationType: op.operationType,
          syncStatus: 'synced',
          revertsOperationId: op.revertsOperationId,
          deviceId: op.deviceId,
          changesJson: JSON.stringify({ entitySyncIds, changes: op.changes }),
          createdAt: op.createdAt,
          updatedAt: new Date().toISOString(),
        })
      }
      // 推进 appliedServerSeq
      const last = this.lastSeq(page.operations)
      if (last > 0) {
        await this.db.syncState.put({
          accountPhone: phone,
          deviceId,
          appliedServerSeq: last,
          lastSyncAt: new Date().toISOString(),
        })
      }
    })
  }

  private async putToTable(
    entityType: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    if (entityType === 'work_order') {
      await this.db.workOrders.put(normalizeWorkOrder(record) as never)
    } else if (entityType === 'customer') {
      await this.db.customers.put(record as never)
    } else if (entityType === 'service_category') {
      await this.db.serviceCategories.put(normalizeServiceCategory(record) as never)
    } else if (entityType === 'customer_code_mapping') {
      await this.db.customerCodeMappings.put(record as never)
    }
  }

  /** 从 outbox 条目的 command 读撤回意图（撤回操作才有值），供写 operations 镜像时保留。 */
  private revertsOf(entry: OutboxEntry): string | null {
    const command = entry.command as { reverts_operation_id?: string } | null
    return command?.reverts_operation_id ?? null
  }

  private lastSeq(operations: PullOperation[]): number {
    if (operations.length === 0) return 0
    return operations[operations.length - 1].serverSeq
  }
}

/**
 * outbox 条目 → PushOperation 的公共纯函数（docs/spec/business-p0p1.md §5.6）。
 * 每条 change 的 entityType：c.entityType ?? entityTypeFor(operationType)。
 * 跨实体操作类型（create_customer_with_mapping / archive_customer_with_mappings）
 * 必须逐 change 标注，缺失直接抛 unknown_operation_type。
 */
export function buildPushOperation(entry: OutboxEntry): PushOperation {
  const command = entry.command as {
    changes?: OutboxCommandChange[]
    reverts_operation_id?: string
  }
  return {
    operationId: entry.operationId,
    operationType: entry.operationType,
    actorType: entry.actorType,
    sourceTurnId: entry.sourceTurnId,
    revertsOperationId: command?.reverts_operation_id ?? null,
    changes: (command?.changes ?? []).map((c) => ({
      entityType: resolveEntityType(entry.operationType, c),
      entitySyncId: c.entitySyncId,
      baseVersion: c.baseVersion,
      fields: c.patch ?? {},
    })),
  }
}

/** operationType → 后端实体类型（docs/data-model.md §5.3 entity_type 取值）；未知返回 null。 */
function entityTypeFor(operationType: string): string | null {
  // 注意顺序：customer_code_mapping 含 "customer"，必须在其之前判断
  if (operationType.includes('work_order')) return 'work_order'
  if (operationType.includes('customer_code_mapping')) return 'customer_code_mapping'
  if (operationType.includes('service_category')) return 'service_category'
  if (operationType.includes('customer')) return 'customer'
  return null
}

function resolveEntityType(
  operationType: string,
  change: OutboxCommandChange,
): string {
  if (change.entityType) return change.entityType
  // 跨实体操作必须逐 change 标注，不允许回退（docs/spec/business-p0p1.md §5.6）
  if (
    operationType === 'create_customer_with_mapping' ||
    operationType === 'archive_customer_with_mappings'
  ) {
    throw new Error(`unknown_operation_type:${operationType}`)
  }
  const fallback = entityTypeFor(operationType)
  if (!fallback) {
    throw new Error(`unknown_operation_type:${operationType}`)
  }
  return fallback
}

// 后端快照是 snake_case（sync_id/row_version/account_phone...），前端 Dexie 用 camelCase
// （AGENTS.md 已定：字段名由后端 snake_case 一对一转换）。这里做映射。
function toCamelRecord(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    out[snakeToCamel(key)] = value
  }
  return out
}

/** 工单布尔字段归一化：SQLite 快照里 is_completed 为 0/1，转 camelCase 后
 *  boolean 化，避免 UI 把 1/0 当数字渲染；其余字段原样。 */
function normalizeWorkOrder(record: Record<string, unknown>): Record<string, unknown> {
  record.isCompleted = Boolean(record.isCompleted)
  return record
}

/** 服务选项本地表 subcategoriesJson 是数组；后端快照里是 JSON 字符串，
 *  且元素字段是 snake_case（default_unit / is_active），写入前统一转 camelCase。 */
function normalizeServiceCategory(record: Record<string, unknown>): Record<string, unknown> {
  const value = record.subcategoriesJson
  let list: Array<Record<string, unknown>> = []
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value)
    } catch {
      list = []
    }
  } else if (Array.isArray(value)) {
    list = value as Array<Record<string, unknown>>
  }
  record.subcategoriesJson = list.map((s) => ({
    name: s.name as string,
    defaultUnit: (s.default_unit ?? s.defaultUnit ?? '') as string,
    isActive: Boolean(s.is_active ?? s.isActive ?? true),
  }))
  return record
}

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}
