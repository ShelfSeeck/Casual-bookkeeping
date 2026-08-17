import type { CbDatabase } from '../db/schema'
import type { MutationInput } from './mutation'
import {
  AiDraftValidationError,
  buildAiBatchOperation,
  prepareAiDraftBatch,
} from './chatApprovalBatch'

/**
 * 单条草案兼容入口。
 *
 * 新代码使用 prepareAiDraftBatch/buildAiBatchOperation；此函数保留给既有调用缝，
 * 但同样经过严格字段白名单、客户映射和业务校验，不能绕过批量审核安全边界。
 */
export async function buildAiOperationFromDraft(
  db: CbDatabase,
  turnId: string,
  toolName: string,
  draft: unknown,
): Promise<MutationInput | null> {
  try {
    const prepared = await prepareAiDraftBatch(db, [
      { toolCallId: 'legacy-single', toolName, draft },
    ])
    return buildAiBatchOperation(turnId, prepared)
  } catch (error) {
    if (error instanceof AiDraftValidationError) return null
    throw error
  }
}
