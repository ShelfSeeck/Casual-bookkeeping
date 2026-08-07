// 待同步命令表（docs/data-model.md §5.2 outbox）。
// 一行 = 一次已作用于本地业务数据、但尚未得到服务端确认的写入请求。
// queueId 自增主键（本机发送顺序），operationId 唯一（前后端重复提交识别）。

export interface OutboxEntry {
  queueId: number
  operationId: string
  operationType: string
  entitySyncIds: string[]
  command: unknown
  status: 'pending' | 'sending' | 'conflict' | 'rejected'
  attempts: number
  nextRetryAt: string | null
  sendingStartedAt: string | null
  lastErrorJson: string | null
  actorType: 'user' | 'ai' | 'system'
  sourceTurnId: string | null
  conflictJson: unknown
  createdAt: string
}

export const outboxSchema = '++queueId, &operationId'
