// 本地操作历史镜像表（docs/data-model.md §5.2 operations）。
// 一行 = 一次近期操作的来源、状态和展示信息；仅供查看，不参与业务写入。

export interface Operation {
  operationId: string
  serverSeq: number | null
  actorType: 'user' | 'ai' | 'system'
  operationType: string
  syncStatus: 'pending' | 'synced'
  /** 撤回操作指向被撤回的原操作；非撤回为 null（docs/data-model.md §5.2） */
  revertsOperationId: string | null
  changesJson: string
  createdAt: string
  updatedAt: string
}

export const operationsSchema = 'operationId'
