import { applyWorkOrderPatch } from './businessCommands'
import type { MutationChange, MutationInput } from './mutation'
import { newId } from '../utils/id'

// chatApproval：确认 UI 的接口契约 + 草案转 MutationInput（docs/spec/agent-tools.md §8）。
// 约定：没有确认 UI 就没有任何写操作。本期 ChatApprovalUi 使用 notConnectedApprovalUi
// （requestApproval 恒 false），调用方据此不提交草案、不发 approve。
// buildAiOperationFromDraft 把后端 tool_confirm_request.draft（工具参数）补齐为
// MutationService.commit 的输入；operationId 由 commit 时生成，这里补齐 entitySyncIds、
// actorType='ai'、sourceTurnId=turnId，apply 复用 businessCommands.applyWorkOrderPatch。

export interface ChatApprovalUi {
  /** 收到写草案时调用；resolve true 才继续 approve + 本地提交。 */
  requestApproval(draft: unknown): Promise<boolean>
}

export const notConnectedApprovalUi: ChatApprovalUi = {
  requestApproval: async (_draft: unknown): Promise<boolean> => false,
}

export function buildAiOperationFromDraft(
  turnId: string,
  draft: unknown,
): MutationInput | null {
  if (typeof draft !== 'object' || draft === null) return null
  const d = draft as { operation_type?: unknown; changes?: unknown }

  if (d.operation_type !== 'create_work_order' && d.operation_type !== 'update_work_order') {
    return null
  }
  if (!Array.isArray(d.changes) || d.changes.length !== 1) return null

  const rawChange = d.changes[0] as { [key: string]: unknown } | null
  if (typeof rawChange !== 'object' || rawChange === null) return null
  if (rawChange.entity_type !== 'work_order') return null

  const fields = rawChange.fields
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return null

  const rawEntitySyncId = rawChange.entity_sync_id
  let entitySyncId: string
  let baseVersion: number

  if (d.operation_type === 'create_work_order') {
    // create：entity_sync_id 可空，空时前端确认阶段生成 sync-<12hex>
    entitySyncId =
      typeof rawEntitySyncId === 'string' && rawEntitySyncId.length > 0
        ? rawEntitySyncId
        : newId('sync')
    baseVersion = 0
  } else {
    // update：entity_sync_id 必填，base_version 必须是数字（来自读工具返回的 row_version）
    if (typeof rawEntitySyncId !== 'string' || rawEntitySyncId.length === 0) return null
    if (typeof rawChange.base_version !== 'number') return null
    entitySyncId = rawEntitySyncId
    baseVersion = rawChange.base_version
  }

  const change: MutationChange = {
    entitySyncId,
    entityType: 'work_order',
    baseVersion,
    patch: fields as Record<string, unknown>,
  }
  if (d.operation_type === 'create_work_order') {
    change.baseSnapshot = {}
  }

  return {
    operationType: d.operation_type,
    entitySyncIds: [entitySyncId],
    changes: [change],
    apply: (tx) => applyWorkOrderPatch(tx, change),
    actorType: 'ai',
    sourceTurnId: turnId,
  }
}
