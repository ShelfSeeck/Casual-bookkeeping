import type { CbDatabase } from '../db/schema'

// 同步状态推导（docs/spec/business-p0p1.md §5.8.3）。
// 单记录状态：outbox 有 conflict → conflict；rejected → rejected；
// pending/sending → saved；否则 synced。
// 计数：pending（含 sending）/ conflict / rejected。

export type RecordSyncStatus = 'saved' | 'synced' | 'conflict' | 'rejected'

export async function getRecordSyncStatus(
  db: CbDatabase,
  syncId: string,
): Promise<RecordSyncStatus> {
  const entries = await db.outbox
    .filter((e) => e.entitySyncIds.includes(syncId))
    .toArray()
  if (entries.some((e) => e.status === 'conflict')) return 'conflict'
  if (entries.some((e) => e.status === 'rejected')) return 'rejected'
  if (entries.some((e) => e.status === 'pending' || e.status === 'sending')) return 'saved'
  return 'synced'
}

export async function getSyncCounts(
  db: CbDatabase,
): Promise<{ pending: number; conflict: number; rejected: number }> {
  const entries = await db.outbox.toArray()
  return {
    pending: entries.filter((e) => e.status === 'pending' || e.status === 'sending').length,
    conflict: entries.filter((e) => e.status === 'conflict').length,
    rejected: entries.filter((e) => e.status === 'rejected').length,
  }
}
