import { beforeEach, describe, expect, it } from 'vitest'
import { createBusinessDb } from '../db/db'
import type { CbDatabase } from '../db/schema'
import type { OutboxEntry } from '../db/schema/operations/outbox'
import { getRecordSyncStatus, getSyncCounts } from './syncStatus'

// 被测缝：syncStatus 同步状态推导（docs/spec/business-p0p1.md §5.8.3）
// 验证：outbox 有 conflict → conflict、rejected → rejected、
// pending/sending → saved、无未决 → synced；计数包含 pending（含 sending）。
// 为什么测这里：工单卡片/同步面板的状态徽标完全依赖这套推导，错一条 UI 就误导用户。

const PHONE = '13800000000'

function makeEntry(
  status: OutboxEntry['status'],
  syncIds: string[],
  operationId = `op-${status}`,
): Omit<OutboxEntry, 'queueId'> {
  return {
    operationId,
    operationType: 'update_work_order',
    entitySyncIds: syncIds,
    command: { changes: [] },
    status,
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

let db: CbDatabase

beforeEach(async () => {
  db = createBusinessDb(PHONE)
  await db.delete()
  await db.open()
})

describe('getRecordSyncStatus', () => {
  it('outbox 有 conflict → conflict（优先级最高）', async () => {
    await db.outbox.add(makeEntry('conflict', ['sync-a']))
    await db.outbox.add(makeEntry('pending', ['sync-a'], 'op-pending'))
    expect(await getRecordSyncStatus(db, 'sync-a')).toBe('conflict')
  })

  it('outbox 有 rejected → rejected', async () => {
    await db.outbox.add(makeEntry('rejected', ['sync-a']))
    expect(await getRecordSyncStatus(db, 'sync-a')).toBe('rejected')
  })

  it('outbox 有 pending/sending → saved', async () => {
    await db.outbox.add(makeEntry('pending', ['sync-a']))
    expect(await getRecordSyncStatus(db, 'sync-a')).toBe('saved')
    await db.outbox.toCollection().delete()
    await db.outbox.add(makeEntry('sending', ['sync-a'], 'op-sending'))
    expect(await getRecordSyncStatus(db, 'sync-a')).toBe('saved')
  })

  it('无该 syncId 的未决 outbox → synced', async () => {
    await db.outbox.add(makeEntry('pending', ['sync-other']))
    expect(await getRecordSyncStatus(db, 'sync-a')).toBe('synced')
  })
})

describe('getSyncCounts', () => {
  it('统计 pending（含 sending）/ conflict / rejected 三类计数', async () => {
    await db.outbox.add(makeEntry('pending', ['sync-a'], 'op-pending'))
    await db.outbox.add(makeEntry('sending', ['sync-b'], 'op-sending'))
    await db.outbox.add(makeEntry('conflict', ['sync-c'], 'op-conflict'))
    await db.outbox.add(makeEntry('rejected', ['sync-d'], 'op-rejected'))
    expect(await getSyncCounts(db)).toEqual({
      pending: 2,
      conflict: 1,
      rejected: 1,
    })
  })

  it('无 outbox 时全为 0', async () => {
    expect(await getSyncCounts(db)).toEqual({ pending: 0, conflict: 0, rejected: 0 })
  })
})
