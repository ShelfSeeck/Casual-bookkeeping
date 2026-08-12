// 待同步命令表（docs/data-model.md §5.2 outbox）。
// 一行 = 一次已作用于本地业务数据、但尚未得到服务端确认的写入请求。
// queueId 自增主键（本机发送顺序），operationId 唯一（前后端重复提交识别）。

/** outbox.command 的可识别形状（docs/data-model.md §6.3、§6.5）。
 *  - changes：这次操作希望改变的业务字段集合（含 base_version / base_snapshot / patch）。
 *  - reverts_operation_id：撤回操作指向的原操作 ID，仅撤回操作携带。
 *  command 字段本身保持 unknown，读取方按此形状做运行时校验后收窄。 */
export interface OutboxCommand {
  changes?: Array<{
    entitySyncId: string
    baseVersion: number
    baseSnapshot?: Record<string, unknown>
    patch?: Record<string, unknown>
  }>
  reverts_operation_id?: string
}

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
