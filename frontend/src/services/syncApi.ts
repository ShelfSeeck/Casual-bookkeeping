import type { ApiClient } from './apiClient'
import type {
  BootstrapData,
  PullResult,
  PushOperation,
  PushResult,
  SyncApi,
} from './syncManager'

// SyncApi 真实实现：通过 ApiClient 调后端三端点（docs/sync-protocol.md §4）
// 401 由 ApiClient 统一处理（refresh → 重试一次）；本层只做 JSON 编解码。

export class HttpSyncApi implements SyncApi {
  private api: ApiClient

  constructor(api: ApiClient) {
    this.api = api
  }

  async push(operations: PushOperation[]): Promise<{ results: PushResult[] }> {
    // wire 契约是 snake_case（docs/sync-protocol.md §4.1）：请求序列化 + 响应反序列化
    const resp = await this.api.request('/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operations: operations.map((op) => ({
          operation_id: op.operationId,
          operation_type: op.operationType,
          actor_type: op.actorType,
          source_turn_id: op.sourceTurnId,
          reverts_operation_id: op.revertsOperationId,
          changes: op.changes.map((c) => ({
            entity_type: c.entityType,
            entity_sync_id: c.entitySyncId,
            base_version: c.baseVersion,
            fields: c.fields,
          })),
        })),
      }),
    })
    const body = (await resp.json()) as {
      results: {
        operation_id: string
        status: 'accepted' | 'conflict' | 'rejected'
        server_seq?: number
        row_versions?: Record<string, number>
        conflict_json?: unknown
        errors?: { entity_sync_id: string; error_code: string }[]
      }[]
    }
    return {
      results: body.results.map((r) => ({
        operationId: r.operation_id,
        status: r.status,
        serverSeq: r.server_seq,
        rowVersions: r.row_versions,
        conflictJson: r.conflict_json,
        errors: r.errors?.map((e) => ({
          entitySyncId: e.entity_sync_id,
          errorCode: e.error_code,
        })),
      })),
    }
  }

  async pull(after: number, limit = 200): Promise<PullResult> {
    const resp = await this.api.request(`/sync/pull?after=${after}&limit=${limit}`)
    const body = (await resp.json()) as {
      operations: {
        server_seq: number
        operation_id: string
        operation_type: string
        reverts_operation_id: string | null
        created_at: string
        changes: {
          entity_type: string
          entity_sync_id: string
          change_type: string
          after_json: string | null
          after_version: number
        }[]
      }[]
      has_more: boolean
    }
    return {
      operations: body.operations.map((op) => ({
        serverSeq: op.server_seq,
        operationId: op.operation_id,
        operationType: op.operation_type,
        revertsOperationId: op.reverts_operation_id,
        createdAt: op.created_at,
        changes: op.changes.map((c) => ({
          entityType: c.entity_type,
          entitySyncId: c.entity_sync_id,
          changeType: c.change_type,
          afterJson: c.after_json ?? '',
          afterVersion: c.after_version,
        })),
      })),
      hasMore: body.has_more,
    }
  }

  async bootstrap(): Promise<BootstrapData> {
    const resp = await this.api.request('/sync/bootstrap')
    const body = (await resp.json()) as {
      snapshot_seq: number
      has_more: boolean
      customers: unknown[]
      service_categories: unknown[]
      work_orders: unknown[]
      customer_code_mappings: unknown[]
    }
    return {
      snapshotSeq: body.snapshot_seq,
      hasMore: body.has_more,
      customers: body.customers,
      serviceCategories: body.service_categories,
      workOrders: body.work_orders,
      customerCodeMappings: body.customer_code_mappings,
    }
  }
}
