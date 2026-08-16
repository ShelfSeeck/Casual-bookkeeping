import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { CbDatabase } from '../db/schema'
import type { WorkOrder } from '../db/schema/business/workOrders'
import type { Customer } from '../db/schema/business/customers'
import type { CustomerCodeMapping } from '../db/schema/business/customerCodeMappings'
import { MutationService } from './mutation'
import {
  SyncManager,
  buildPushOperation,
  type PushOperation,
  type PushResult,
  type SyncApi,
  type SyncStatus,
  type SyncManagerOptions,
} from './syncManager'

// 被测缝：SyncManager 同步循环（docs/sync-protocol.md §3.3 / §6）
// 验证：
// 1. 每轮先 Push 后 Pull；outbox 未清空（含 conflict/rejected）不 Pull
// 2. Push accepted → 删 outbox、operations 标 synced
// 3. conflict → 保留 outbox + 存 conflictJson；不自动重试
// 4. Pull 应用 after_json + after_version、推进 appliedServerSeq
// 5. 同步循环单飞（并发调用只跑一轮）
// API 用 mock（真实后端行为已在后端缝 14 验证，此处验证前端循环逻辑）

const PHONE = '13800000000'

function makeOrder(syncId: string): WorkOrder {
  return {
    syncId,
    accountPhone: PHONE,
    workOrderDate: '2026-08-08',
    customerId: 1,
    customerCode: '001',
    customerName: '张三',
    serviceCategory: '洗水',
    serviceItem: '单洗',
    quantity: 5,
    unit: '件',
    unitPriceCents: null,
    isCompleted: false,
    rowVersion: 0,
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
    deletedAt: null,
  }
}

function makeCustomer(syncId: string, rowVersion = 1): Customer {
  return {
    syncId,
    accountPhone: PHONE,
    customerId: 1,
    canonicalName: '某某厂',
    archivedAt: null,
    rowVersion,
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
  }
}

function makeMapping(syncId: string): CustomerCodeMapping {
  return {
    syncId,
    accountPhone: PHONE,
    customerId: 1,
    customerCode: '001',
    customerName: '张三',
    validFrom: '2026-01-01',
    validTo: null,
    rowVersion: 0,
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:00Z',
  }
}

function makeApi(overrides: Partial<SyncApi> = {}): SyncApi {
  return {
    push: vi.fn(async () => ({ results: [] })),
    pull: vi.fn(async () => ({ operations: [], hasMore: false })),
    bootstrap: vi.fn(async () => ({
      snapshotSeq: 0,
      hasMore: false,
      customers: [],
      serviceCategories: [],
      workOrders: [],
      customerCodeMappings: [],
    })),
    ...overrides,
  }
}

let db: CbDatabase
let mutation: MutationService
let statuses: SyncStatus[]

async function commitOrder(syncId: string): Promise<void> {
  await mutation.commit({
    operationType: 'create_work_order',
    entitySyncIds: [syncId],
    apply: (tx) => tx.workOrders.put(makeOrder(syncId)),
    actorType: 'user',
  })
}

beforeEach(async () => {
  db = createBusinessDb(PHONE)
  await db.delete()
  await db.open()
  mutation = new MutationService(db)
  statuses = []
})

function buildManager(api: SyncApi, options: SyncManagerOptions = {}): SyncManager {
  return new SyncManager(db, api, {
    onStatusChange: (s) => statuses.push(s),
  }, options)
}

describe('SyncManager', () => {
  it('每轮先 Push 后 Pull，outbox 清空后 Pull', async () => {
    await commitOrder('sync-a')
    const realOpId = (await db.outbox.toArray())[0].operationId
    const calls: string[] = []
    const api = makeApi({
      push: vi.fn(async () => {
        calls.push('push')
        return { results: [{ operationId: realOpId, status: 'accepted' as const, serverSeq: 1 }] }
      }),
      pull: vi.fn(async () => {
        calls.push('pull')
        return { operations: [], hasMore: false }
      }),
    })
    await buildManager(api).sync()

    expect(calls).toEqual(['push', 'pull'])
    // outbox 清空（accepted）
    expect(await db.outbox.count()).toBe(0)
    // operations 标 synced
    const ops = await db.operations.toArray()
    expect(ops[0].syncStatus).toBe('synced')
    expect(ops[0].serverSeq).toBe(1)
  })

  it('撤回操作 accepted 后，operations 镜像保留 revertsOperationId（docs/data-model.md §6.5）', async () => {
    // 撤回操作 commit 时 operations 已存 revertsOperationId；accepted 后写镜像不能丢撤回关系
    await mutation.commit({
      operationType: 'revert_work_order',
      entitySyncIds: ['sync-a'],
      revertsOperationId: 'op-100',
      apply: (tx) => tx.workOrders.put(makeOrder('sync-a')),
      actorType: 'user',
    })
    const realOpId = (await db.outbox.toArray())[0].operationId
    const api = makeApi({
      push: vi.fn(async () => ({
        results: [{ operationId: realOpId, status: 'accepted' as const, serverSeq: 1 }],
      })),
    })
    await buildManager(api).sync()

    const ops = await db.operations.toArray()
    expect(ops[0].syncStatus).toBe('synced')
    expect(ops[0].revertsOperationId).toBe('op-100')
  })

  it('真实 revert_operation 通过 Push 预检并推送空 changes（changes 由后端展开）', async () => {
    // 验证：revert_operation 在 entityTypeFor 无映射，但不能被 Push 前预检拦截，
    // 否则撤回永远 pending 并阻塞后续 Push。其 command.changes 为空数组，
    // PushOperation 应保留 revertsOperationId 且 changes 为 []。
    await mutation.commit({
      operationType: 'revert_operation',
      entitySyncIds: ['sync-a'],
      changes: [],
      revertsOperationId: 'op-100',
      apply: () => undefined,
      actorType: 'user',
    })
    const realOpId = (await db.outbox.toArray())[0].operationId
    const push = vi.fn(async () => ({
      results: [{ operationId: realOpId, status: 'accepted' as const, serverSeq: 9 }],
    }))
    const api = makeApi({ push })
    await buildManager(api).sync()

    expect(push).toHaveBeenCalledTimes(1)
    const pushed = ((push.mock.calls[0] as unknown) as [PushOperation[]])[0][0]
    expect(pushed.operationType).toBe('revert_operation')
    expect(pushed.revertsOperationId).toBe('op-100')
    expect(pushed.changes).toEqual([])
    expect(await db.outbox.count()).toBe(0)
  })

  it('conflict 时保留 outbox 并存 conflictJson，不 Pull', async () => {
    await commitOrder('sync-a')
    const realOpId = (await db.outbox.toArray())[0].operationId
    const pull = vi.fn(async () => ({ operations: [], hasMore: false }))
    const api = makeApi({
      push: vi.fn(async () => ({
        results: [
          {
            operationId: realOpId,
            status: 'conflict' as const,
            conflictJson: { theirs: { rowVersion: 5, quantity: 9 } },
          },
        ],
      })),
      pull,
    })
    await buildManager(api).sync()

    // outbox 保留为 conflict
    const entries = await db.outbox.toArray()
    expect(entries[0].status).toBe('conflict')
    expect(entries[0].conflictJson).toEqual({ theirs: { rowVersion: 5, quantity: 9 } })
    // 不 Pull
    expect(pull).not.toHaveBeenCalled()
  })

  it('rejected 时保留 outbox 并存错误，不 Pull', async () => {
    await commitOrder('sync-a')
    const realOpId = (await db.outbox.toArray())[0].operationId
    const pull = vi.fn(async () => ({ operations: [], hasMore: false }))
    const api = makeApi({
      push: vi.fn(async () => ({
        results: [
          {
            operationId: realOpId,
            status: 'rejected' as const,
            errors: [{ entitySyncId: 'sync-a', errorCode: 'invalid_quantity' }],
          },
        ],
      })),
      pull,
    })
    await buildManager(api).sync()

    const entries = await db.outbox.toArray()
    expect(entries[0].status).toBe('rejected')
    expect(entries[0].lastErrorJson).toContain('invalid_quantity')
    expect(pull).not.toHaveBeenCalled()
  })

  it('Pull 应用 after_json + after_version 到业务表并推进 appliedServerSeq', async () => {
    const api = makeApi({
      push: vi.fn(async () => ({ results: [] })),
      pull: vi.fn(async () => ({
        operations: [
          {
            serverSeq: 42,
            operationId: 'op-remote',
            operationType: 'create_customer',
            actorType: 'user' as const,
            deviceId: 'dev-remote',
            revertsOperationId: null,
            createdAt: '2026-08-08T00:00:00Z',
            changes: [
              {
                entityType: 'customer',
                entitySyncId: 'sync-remote',
                changeType: 'create',
                afterJson: JSON.stringify(makeCustomer('sync-remote', 3)),
                afterVersion: 3,
              },
            ],
          },
        ],
        hasMore: false,
      })),
    })
    await buildManager(api).sync()

    // 业务表写入远程记录 + rowVersion=3
    const customer = await db.customers.get('sync-remote')
    expect(customer?.rowVersion).toBe(3)
    expect(customer?.canonicalName).toBe('某某厂')
    // appliedServerSeq 推进
    const state = await db.syncState.get(PHONE)
    expect(state?.appliedServerSeq).toBe(42)
    // operations 镜像：deviceId 来自 Pull，changesJson 为新形状 {entitySyncIds, changes}
    const mirror = await db.operations.get('op-remote')
    expect(mirror?.deviceId).toBe('dev-remote')
    const changesJson = JSON.parse(mirror!.changesJson) as {
      entitySyncIds: string[]
      changes: { entitySyncId: string; afterJson: string }[]
    }
    expect(changesJson.entitySyncIds).toEqual(['sync-remote'])
    expect(changesJson.changes).toHaveLength(1)
    expect(changesJson.changes[0].afterJson).toBe(JSON.stringify(makeCustomer('sync-remote', 3)))
  })

  it('Pull 拉回撤回操作时，operations 镜像保留 revertsOperationId（跨设备撤回关系）', async () => {
    // 设备 B 的撤回操作经 Pull 下来，镜像应保留 revertsOperationId，历史页据此判断撤回关系
    const api = makeApi({
      push: vi.fn(async () => ({ results: [] })),
      pull: vi.fn(async () => ({
        operations: [
          {
            serverSeq: 7,
            operationId: 'op-revert-remote',
            operationType: 'revert_work_order',
            actorType: 'user' as const,
            deviceId: 'dev-remote',
            revertsOperationId: 'op-original-remote',
            createdAt: '2026-08-08T00:00:00Z',
            changes: [],
          },
        ],
        hasMore: false,
      })),
    })
    await buildManager(api).sync()

    const op = await db.operations.get('op-revert-remote')
    expect(op?.revertsOperationId).toBe('op-original-remote')
  })

  it('同步循环单飞：并发 sync() 只跑一轮 Push', async () => {
    await commitOrder('sync-a')
    let pushCount = 0
    const api = makeApi({
      push: vi.fn(async () => {
        pushCount += 1
        return { results: [{ operationId: 'op-x', status: 'accepted' as const, serverSeq: 1 }] }
      }),
    })
    const manager = buildManager(api)
    await Promise.all([manager.sync(), manager.sync(), manager.sync()])

    expect(pushCount).toBe(1)
  })

  it('isCurrentAccount 为 false 时 sync() 直接返回，不调用 API', async () => {
    const api = makeApi()
    await expect(
      buildManager(api, { isCurrentAccount: () => false }).sync(),
    ).resolves.toBeUndefined()

    expect(api.push).not.toHaveBeenCalled()
    expect(api.pull).not.toHaveBeenCalled()
    expect(api.bootstrap).not.toHaveBeenCalled()
  })

  it('init 时 outbox 有未决条目不 bootstrap（data-model §5.4 防覆盖）', async () => {
    // 本地有 pending 未推（如离线录入），即使无 syncState 也不 bootstrap 清空业务表
    await commitOrder('sync-a')
    const bootstrap = vi.fn(async () => ({
      snapshotSeq: 0,
      hasMore: false,
      customers: [],
      serviceCategories: [],
      workOrders: [],
      customerCodeMappings: [],
    }))
    const api = makeApi({ bootstrap })
    await buildManager(api).init()

    expect(bootstrap).not.toHaveBeenCalled()
    // 本地离线工单还在
    expect(await db.workOrders.get('sync-a')).toBeDefined()
  })

  it('init 时 outbox 为空才 bootstrap', async () => {
    const bootstrap = vi.fn(async () => ({
      snapshotSeq: 0,
      hasMore: false,
      customers: [],
      serviceCategories: [],
      workOrders: [],
      customerCodeMappings: [],
    }))
    const api = makeApi({ bootstrap })
    await buildManager(api).init()

    expect(bootstrap).toHaveBeenCalled()
  })

  it('网络错误：退回 pending、attempts++、nextRetryAt 与 lastErrorJson 记录', async () => {
    await commitOrder('sync-a')
    const api = makeApi({
      push: vi.fn(async () => {
        throw new Error('network down')
      }),
    })
    await expect(buildManager(api).sync()).rejects.toThrow('network down')

    const entries = await db.outbox.toArray()
    expect(entries[0].status).toBe('pending')
    expect(entries[0].attempts).toBe(1)
    expect(entries[0].nextRetryAt).toBeTruthy()
    expect(entries[0].sendingStartedAt).toBeNull()
    expect(entries[0].lastErrorJson).toContain('network down')
  })

  it('重启恢复：sending 挂起恢复 pending，沿用原 operation_id 重试', async () => {
    await commitOrder('sync-a')
    const entry = (await db.outbox.toArray())[0]
    await db.outbox.update(entry.queueId, {
      status: 'sending',
      sendingStartedAt: '2026-08-08T00:00:00Z',
    })
    const push = vi.fn(async (_ops: PushOperation[]) => ({
      results: [{ operationId: entry.operationId, status: 'accepted' as const, serverSeq: 1 }],
    }))
    await buildManager(makeApi({ push })).sync()

    // 用原 operation_id 推送并 accepted
    expect(push.mock.calls[0][0][0].operationId).toBe(entry.operationId)
    expect(await db.outbox.count()).toBe(0)
  })

  it('冲突解决：生成新合并操作并移除原冲突条目', async () => {
    await mutation.commit({
      operationType: 'update_work_order',
      entitySyncIds: ['sync-a'],
      changes: [
        {
          entitySyncId: 'sync-a',
          baseVersion: 2,
          baseSnapshot: { quantity: 5, unit: '件' },
          patch: { quantity: 9 },
        },
      ],
      apply: (tx) => tx.workOrders.put({ ...makeOrder('sync-a'), rowVersion: 2 }),
      actorType: 'user',
    })
    const entry = (await db.outbox.toArray())[0]
    const oldOpId = entry.operationId
    await db.outbox.update(entry.queueId, {
      status: 'conflict' as const,
      conflictJson: {
        entity_type: 'work_order',
        entity_sync_id: 'sync-a',
        theirs: { sync_id: 'sync-a', row_version: 5, quantity: 5, unit: '套' },
      },
    })

    await buildManager(makeApi()).resolveConflict(entry.queueId, {
      quantity: { source: 'ours' },
    })

    // 原冲突条目移除，新合并操作 pending：base_version = Theirs.row_version(5)，
    // patch = 合并结果（quantity 保留 Ours，unit 由 Theirs 改 → 不写）
    const entries = await db.outbox.toArray()
    expect(entries).toHaveLength(1)
    expect(entries[0].operationId).not.toBe(oldOpId)
    expect(entries[0].status).toBe('pending')
    const cmd = entries[0].command as { changes: { baseVersion: number; patch: Record<string, unknown> }[] }
    expect(cmd.changes[0].baseVersion).toBe(5)
    expect(cmd.changes[0].patch).toEqual({ quantity: 9 })
    // operations 镜像同步替换为新的 pending 操作
    const ops = await db.operations.toArray()
    expect(ops).toHaveLength(1)
    expect(ops[0].operationId).toBe(entries[0].operationId)
    expect(ops[0].syncStatus).toBe('pending')
  })

  it('冲突合并 patch 剔除 row_version/updated_at 等账本元字段', async () => {
    await mutation.commit({
      operationType: 'update_work_order',
      entitySyncIds: ['sync-a'],
      changes: [
        {
          entitySyncId: 'sync-a',
          baseVersion: 2,
          baseSnapshot: {
            sync_id: 'sync-a',
            row_version: 2,
            updated_at: '2026-08-08T00:00:00Z',
            quantity: 5,
            unit: '件',
          },
          patch: { quantity: 9 },
        },
      ],
      apply: (tx) => tx.workOrders.put({ ...makeOrder('sync-a'), rowVersion: 2 }),
      actorType: 'user',
    })
    const entry = (await db.outbox.toArray())[0]
    await db.outbox.update(entry.queueId, {
      status: 'conflict' as const,
      conflictJson: {
        entity_type: 'work_order',
        entity_sync_id: 'sync-a',
        theirs: {
          sync_id: 'sync-a',
          row_version: 5,
          updated_at: '2026-08-09T00:00:00Z',
          quantity: 5,
          unit: '套',
        },
      },
    })
    await buildManager(makeApi()).resolveConflict(entry.queueId, { quantity: { source: 'ours' } })

    const cmd = (await db.outbox.toArray())[0].command as {
      changes: { baseVersion: number; patch: Record<string, unknown> }[]
    }
    expect(cmd.changes[0].baseVersion).toBe(5)
    expect(cmd.changes[0].patch).toEqual({ quantity: 9 })
    expect(cmd.changes[0].patch).not.toHaveProperty('row_version')
    expect(cmd.changes[0].patch).not.toHaveProperty('updated_at')
  })

  it('多 change 冲突：仅冲突 change 重建 base_version，其余保留', async () => {
    await mutation.commit({
      operationType: 'update_work_order',
      entitySyncIds: ['sync-a', 'sync-b'],
      changes: [
        { entitySyncId: 'sync-a', baseVersion: 2, baseSnapshot: { quantity: 5 }, patch: { quantity: 9 } },
        { entitySyncId: 'sync-b', baseVersion: 1, baseSnapshot: { quantity: 3 }, patch: { quantity: 4 } },
      ],
      apply: (tx) => {
        tx.workOrders.put({ ...makeOrder('sync-a'), rowVersion: 2 })
        tx.workOrders.put({ ...makeOrder('sync-b'), rowVersion: 1 })
      },
      actorType: 'user',
    })
    const entry = (await db.outbox.toArray())[0]
    await db.outbox.update(entry.queueId, {
      status: 'conflict' as const,
      conflictJson: {
        entity_type: 'work_order',
        entity_sync_id: 'sync-b',
        theirs: { sync_id: 'sync-b', row_version: 9, quantity: 3 },
      },
    })
    await buildManager(makeApi()).resolveConflict(entry.queueId, {})

    const cmd = (await db.outbox.toArray())[0].command as {
      changes: { entitySyncId: string; baseVersion: number; patch: Record<string, unknown> }[]
    }
    // 冲突的 sync-b 用 Theirs 版本重建；未冲突的 sync-a 保持原 base_version
    expect(cmd.changes[0]).toEqual({
      entitySyncId: 'sync-a',
      baseVersion: 2,
      baseSnapshot: { quantity: 5 },
      patch: { quantity: 9 },
    })
    expect(cmd.changes[1].baseVersion).toBe(9)
    expect(cmd.changes[1].patch).toEqual({ quantity: 4 })
  })

  it('冲突解决后重新 Push 合并操作（走完整循环）', async () => {
    await mutation.commit({
      operationType: 'update_work_order',
      entitySyncIds: ['sync-a'],
      changes: [
        { entitySyncId: 'sync-a', baseVersion: 2, baseSnapshot: { quantity: 5 }, patch: { quantity: 9 } },
      ],
      apply: (tx) => tx.workOrders.put({ ...makeOrder('sync-a'), rowVersion: 2 }),
      actorType: 'user',
    })
    const entry = (await db.outbox.toArray())[0]
    await db.outbox.update(entry.queueId, {
      status: 'conflict' as const,
      conflictJson: {
        entity_type: 'work_order',
        entity_sync_id: 'sync-a',
        theirs: { sync_id: 'sync-a', row_version: 5, quantity: 5 },
      },
    })
    const manager = buildManager(makeApi())
    await manager.resolveConflict(entry.queueId, { quantity: { source: 'ours' } })

    const mergedOpId = (await db.outbox.toArray())[0].operationId
    const push = vi.fn(async (_ops: PushOperation[]) => ({
      results: [{ operationId: mergedOpId, status: 'accepted' as const, serverSeq: 7 }],
    }))
    const pull = vi.fn(async () => ({ operations: [], hasMore: false }))
    await buildManager(makeApi({ push, pull })).sync()

    expect(push.mock.calls[0][0][0].operationId).toBe(mergedOpId)
    expect(push.mock.calls[0][0][0].changes[0]).toEqual({
      entityType: 'work_order',
      entitySyncId: 'sync-a',
      baseVersion: 5,
      fields: { quantity: 9 },
    })
    // 合并操作 accepted → outbox 清空并 Pull
    expect(pull).toHaveBeenCalled()
    expect(await db.outbox.count()).toBe(0)
  })

  it('同一批 Push 结果原子应用：accepted 删除+镜像 synced，conflict 保留', async () => {
    await commitOrder('sync-a')
    await commitOrder('sync-b')
    const [ea, eb] = await db.outbox.orderBy('queueId').toArray()
    const api = makeApi({
      push: vi.fn(async () => ({
        results: [
          { operationId: ea.operationId, status: 'accepted' as const, serverSeq: 10 },
          {
            operationId: eb.operationId,
            status: 'conflict' as const,
            conflictJson: { theirs: { row_version: 3 } },
          },
        ],
      })),
    })
    await buildManager(api).sync()

    // accepted 的已删 outbox + 镜像标 synced 带 serverSeq；conflict 的保留
    const outbox = await db.outbox.toArray()
    expect(outbox).toHaveLength(1)
    expect(outbox[0].operationId).toBe(eb.operationId)
    expect(outbox[0].status).toBe('conflict')
    const mirror = (await db.operations.toArray()).find((o) => o.operationId === ea.operationId)
    expect(mirror?.syncStatus).toBe('synced')
    expect(mirror?.serverSeq).toBe(10)
  })

  it('未知 operationType：Push 前抛错，不静默写错表', async () => {
    await mutation.commit({
      operationType: 'mystery_command',
      entitySyncIds: ['sync-a'],
      apply: (tx) => tx.workOrders.put(makeOrder('sync-a')),
      actorType: 'user',
    })
    const api = makeApi()
    await expect(buildManager(api).sync()).rejects.toThrow('unknown_operation_type')

    expect(api.push).not.toHaveBeenCalled()
    const entries = await db.outbox.toArray()
    expect(entries[0].status).toBe('pending')
  })

  it('customer_code_mapping 操作映射为 customer_code_mapping（修复含 customer 前缀误判）', async () => {
    await mutation.commit({
      operationType: 'create_customer_code_mapping',
      entitySyncIds: ['sync-a'],
      apply: (tx) => tx.customerCodeMappings.put(makeMapping('sync-a')),
      actorType: 'user',
    })
    const push = vi.fn(async (_ops: PushOperation[]) => ({ results: [] }))
    await buildManager(makeApi({ push })).sync()

    expect(push.mock.calls[0][0][0].changes[0].entityType).toBe('customer_code_mapping')
  })

  it('超过 pushBatchSize 时拆分多批推送（按队列顺序）', async () => {
    for (const id of ['sync-a', 'sync-b', 'sync-c']) await commitOrder(id)
    const realIds = (await db.outbox.orderBy('queueId').toArray()).map((e) => e.operationId)
    const push = vi.fn(async (_ops: PushOperation[]) => ({ results: [] }))
    const api = makeApi({ push })
    await buildManager(api, { pushBatchSize: 2 }).sync()

    // 3 条按 2+1 拆两批，批次内保序
    expect(push.mock.calls).toHaveLength(2)
    expect(push.mock.calls[0][0].map((o: { operationId: string }) => o.operationId)).toEqual(
      realIds.slice(0, 2),
    )
    expect(push.mock.calls[1][0].map((o: { operationId: string }) => o.operationId)).toEqual(
      realIds.slice(2),
    )
  })
})

describe('SyncManager.pruneLocalHistory（docs/sync-protocol.md §10）', () => {
  function makeHistOp(operationId: string, daysAgo: number, synced = true) {
    return {
      operationId,
      serverSeq: synced ? 1 : null,
      actorType: 'user' as const,
      operationType: 'create_customer',
      syncStatus: (synced ? 'synced' : 'pending') as 'synced' | 'pending',
      revertsOperationId: null,
      deviceId: null,
      changesJson: '{}',
      createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      updatedAt: '',
    }
  }

  it('只清 synced 且超窗口（30 天且非最近 500 条）的旧记录；pending 与近期记录保留', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => makeHistOp(`recent-${i}`, 1))
    rows.push(makeHistOp('old-1', 40))
    rows.push(makeHistOp('pending-old', 40, false))
    await db.operations.bulkAdd(rows)
    await buildManager(makeApi()).pruneLocalHistory()

    // old-1（40 天前、不在最近 500 条内）被清；recent 与 pending-old 保留
    const remaining = (await db.operations.toArray()).map((o) => o.operationId)
    expect(remaining).toContain('pending-old')
    expect(remaining).not.toContain('old-1')
    expect(await db.operations.count()).toBe(501)
  })

  it('synced 超过 500 条时只保留最近 500 条（全超期也只留 500）', async () => {
    const rows = Array.from({ length: 505 }, (_, i) => makeHistOp(`op-${i}`, 30 + i))
    await db.operations.bulkAdd(rows)
    await buildManager(makeApi()).pruneLocalHistory()

    expect(await db.operations.count()).toBe(500)
  })

  it('同步成功后调用清理：旧 synced 历史被清，未决 outbox 不受影响', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => makeHistOp(`recent-${i}`, 1))
    rows.push(makeHistOp('old-1', 40))
    await db.operations.bulkAdd(rows)
    // 制造一条 pending 业务操作，让本轮同步实际发生
    await commitOrder('sync-a')
    const realOpId = (await db.outbox.toArray())[0].operationId
    const push = vi.fn(async () => ({
      results: [{ operationId: realOpId, status: 'accepted' as const, serverSeq: 1 }],
    }))
    const pull = vi.fn(async () => ({ operations: [], hasMore: false }))
    await buildManager(makeApi({ push, pull })).sync()

    const remaining = (await db.operations.toArray()).map((o) => o.operationId)
    expect(remaining).toContain('recent-0')
    expect(remaining).not.toContain('old-1')
  })
})

describe('SyncManager.buildPushOperation（docs/spec/business-p0p1.md §5.6）', () => {
  function makeEntry(
    operationType: string,
    changes: Array<{
      entitySyncId: string
      baseVersion: number
      patch?: Record<string, unknown>
      entityType?: string
    }>,
  ): Parameters<typeof buildPushOperation>[0] {
    return {
      queueId: 1,
      operationId: 'op-1',
      operationType,
      entitySyncIds: changes.map((c) => c.entitySyncId),
      command: { changes },
      status: 'pending',
      attempts: 0,
      nextRetryAt: null,
      sendingStartedAt: null,
      lastErrorJson: null,
      actorType: 'user',
      sourceTurnId: null,
      conflictJson: null,
      createdAt: '2026-08-08T00:00:00Z',
    }
  }

  it('change 未带 entityType 时回退 operationType 推导', () => {
    const op = buildPushOperation(makeEntry('create_work_order', [
      { entitySyncId: 'sync-a', baseVersion: 0, patch: { quantity: 5 } },
    ]))
    expect(op.changes[0].entityType).toBe('work_order')
    expect(op.changes[0].fields).toEqual({ quantity: 5 })
  })

  it('create_customer_with_mapping 逐 change 使用各自的 entityType', () => {
    const op = buildPushOperation(makeEntry('create_customer_with_mapping', [
      { entitySyncId: 'sync-cust', baseVersion: 0, entityType: 'customer', patch: { canonical_name: '厂' } },
      { entitySyncId: 'sync-map', baseVersion: 0, entityType: 'customer_code_mapping', patch: { customer_code: '001' } },
    ]))
    expect(op.changes.map((c) => c.entityType)).toEqual(['customer', 'customer_code_mapping'])
  })

  it('跨实体操作类型缺逐条 entityType → 抛 unknown_operation_type', () => {
    expect(() =>
      buildPushOperation(makeEntry('create_customer_with_mapping', [
        { entitySyncId: 'sync-cust', baseVersion: 0 },
      ])),
    ).toThrow('unknown_operation_type')
    expect(() =>
      buildPushOperation(makeEntry('archive_customer_with_mappings', [
        { entitySyncId: 'sync-cust', baseVersion: 1 },
      ])),
    ).toThrow('unknown_operation_type')
  })

  it('未知 operationType 仍抛 unknown_operation_type', () => {
    expect(() =>
      buildPushOperation(makeEntry('mystery_command', [
        { entitySyncId: 'sync-a', baseVersion: 0 },
      ])),
    ).toThrow('unknown_operation_type')
  })
})

describe('SyncManager accepted 回写 rowVersion（docs/spec/business-p0p1.md §5.7）', () => {
  it('accepted 后把 result.row_versions 按 syncId 回写对应业务表（同一事务）', async () => {
    await commitOrder('sync-a')
    const orderOpId = (await db.outbox.toArray())[0].operationId
    // 再提交一条客户创建，让同一批 Push 覆盖两张业务表
    await mutation.commit({
      operationType: 'create_customer',
      entitySyncIds: ['sync-cust'],
      changes: [
        { entitySyncId: 'sync-cust', baseVersion: 0, entityType: 'customer', patch: { canonical_name: '某某厂' } },
      ],
      apply: (tx) => tx.customers.put(makeCustomer('sync-cust', 1)),
      actorType: 'user',
    })
    const customerOpId = (await db.outbox.orderBy('queueId').toArray())[1].operationId

    const push = vi.fn(async (): Promise<{ results: PushResult[] }> => ({
      results: [
        { operationId: orderOpId, status: 'accepted', serverSeq: 10, rowVersions: { 'sync-a': 7 } },
        { operationId: customerOpId, status: 'accepted', serverSeq: 11, rowVersions: { 'sync-cust': 3 } },
      ],
    }))
    await buildManager(makeApi({ push })).sync()

    expect((await db.workOrders.get('sync-a'))?.rowVersion).toBe(7)
    expect((await db.customers.get('sync-cust'))?.rowVersion).toBe(3)
    // 同一事务副作用：outbox 清空、operations 标 synced
    expect(await db.outbox.count()).toBe(0)
    const ops = await db.operations.toArray()
    expect(ops.every((o) => o.syncStatus === 'synced')).toBe(true)
  })
})
