import { applyWorkOrderPatch } from './businessCommands'
import type { MutationChange, MutationInput } from './mutation'
import { newId } from '../utils/id'

// chatApproval：确认 UI 的接口契约 + 草案转 MutationInput（docs/spec/agent-tools.md §8）。
// 约定：没有确认 UI 就没有任何写操作。本期 ChatApprovalUi 使用 notConnectedApprovalUi
// （requestApproval 恒 false），调用方据此不提交草案、不发 approve。
// buildAiOperationFromDraft 把后端 tool_confirm_request.draft（工具原始参数，§5.6）
// 按 toolName 补齐为 MutationService.commit 的输入；operationId 由 commit 时生成，
// 这里补齐 entitySyncIds、actorType='ai'、sourceTurnId=turnId，apply 复用
// businessCommands.applyWorkOrderPatch。

export interface ChatApprovalUi {
  /** 收到写草案时调用；resolve true 才继续 approve + 本地提交。 */
  requestApproval(draft: unknown): Promise<boolean>
}

export const notConnectedApprovalUi: ChatApprovalUi = {
  requestApproval: async (_draft: unknown): Promise<boolean> => false,
}

export function buildAiOperationFromDraft(
  turnId: string,
  toolName: string,
  draft: unknown,
): MutationInput | null {
  if (typeof draft !== 'object' || draft === null) return null
  const d = draft as { entity_sync_id?: unknown; base_version?: unknown; fields?: unknown }

  if (toolName !== 'create_work_order' && toolName !== 'update_work_order') return null

  const fields = d.fields
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return null

  let entitySyncId: string
  let baseVersion: number

  if (toolName === 'create_work_order') {
    // create：entity_sync_id 为 null 时生成 sync-<12hex>；字符串直接使用
    if (d.entity_sync_id === null) {
      entitySyncId = newId('sync')
    } else if (typeof d.entity_sync_id === 'string' && d.entity_sync_id.length > 0) {
      entitySyncId = d.entity_sync_id
    } else {
      return null
    }
    baseVersion = 0
  } else {
    // update：entity_sync_id 必填字符串，base_version 必须是正整数
    // （来自读工具返回的 row_version）
    if (typeof d.entity_sync_id !== 'string' || d.entity_sync_id.length === 0) return null
    if (
      typeof d.base_version !== 'number' ||
      !Number.isInteger(d.base_version) ||
      d.base_version <= 0
    ) {
      return null
    }
    entitySyncId = d.entity_sync_id
    baseVersion = d.base_version
  }

  const change: MutationChange = {
    entitySyncId,
    entityType: 'work_order',
    baseVersion,
    patch: fields as Record<string, unknown>,
  }
  if (toolName === 'create_work_order') {
    change.baseSnapshot = {}
  }

  return {
    operationType: toolName,
    entitySyncIds: [entitySyncId],
    changes: [change],
    apply: (tx) => applyWorkOrderPatch(tx, change),
    actorType: 'ai',
    sourceTurnId: turnId,
  }
}
