// 本地操作历史镜像表（docs/data-model.md §5.2 operations）。
// 一行 = 一次近期操作的来源、状态和展示信息；仅供查看，不参与业务写入。

export interface Operation {
  operationId: string
  serverSeq: number | null
  actorType: 'user' | 'ai' | 'system'
  operationType: string
  syncStatus: 'pending' | 'synced'
  changesJson: string
  createdAt: string
  updatedAt: string
}

export const operationsSchema = 'operationId'
