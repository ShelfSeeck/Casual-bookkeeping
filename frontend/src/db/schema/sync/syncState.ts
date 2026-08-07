// 同步元数据表（docs/data-model.md §5.2 sync_state）。
// 一行 = 一个账户的本地同步进度；以 accountPhone 为主键。

export interface SyncState {
  accountPhone: string
  deviceId: string
  appliedServerSeq: number
  lastSyncAt: string | null
}

export const syncStateSchema = 'accountPhone'
