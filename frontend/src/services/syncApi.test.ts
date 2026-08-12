import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpSyncApi } from './syncApi'
import { ApiClient } from './apiClient'
import type { PushOperation } from './syncManager'

// 被测缝：HttpSyncApi（docs/sync-protocol.md §4 的 wire 适配器）
// 验证：camelCase（前端内部）→ snake_case（wire 契约）的请求序列化与响应反序列化。
// 为什么测这里：push 请求体若直接用 camelCase 透传，后端 Pydantic 期待 snake_case 会 422；
// 响应若不映射，syncManager 读不到 operationId 会导致 outbox 永远清不空、永不 Pull。

let api: HttpSyncApi
let requestMock: ReturnType<typeof vi.fn>

function stubApiClient() {
  requestMock = vi.fn()
  const client = { request: requestMock } as unknown as ApiClient
  api = new HttpSyncApi(client)
}

function sampleOperation(): PushOperation {
  return {
    operationId: 'op-000000000001',
    operationType: 'create_customer',
    actorType: 'user',
    sourceTurnId: null,
    revertsOperationId: null,
    changes: [
      {
        entityType: 'customer',
        entitySyncId: 'sync-000000000001',
        baseVersion: 0,
        fields: { canonical_name: '某某厂' },
      },
    ],
  }
}

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body
    },
  } as Response
}

beforeEach(() => {
  stubApiClient()
})

describe('HttpSyncApi.push', () => {
  it('请求体用 snake_case 序列化（wire 契约），前端内部是 camelCase', async () => {
    requestMock.mockResolvedValue(okResponse({ results: [] }))
    await api.push([sampleOperation()])

    expect(requestMock).toHaveBeenCalledTimes(1)
    const [, init] = requestMock.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.operations[0]).toMatchObject({
      operation_id: 'op-000000000001',
      operation_type: 'create_customer',
      actor_type: 'user',
      source_turn_id: null,
    })
    expect(body.operations[0].changes[0]).toMatchObject({
      entity_type: 'customer',
      entity_sync_id: 'sync-000000000001',
      base_version: 0,
    })
    // 没有 camelCase 字段漏出去
    expect(body.operations[0].operationId).toBeUndefined()
  })

  it('撤回操作序列化带 reverts_operation_id（docs/data-model.md §6.5）', async () => {
    requestMock.mockResolvedValue(okResponse({ results: [] }))
    const op = sampleOperation()
    op.revertsOperationId = 'op-100'
    await api.push([op])

    const [, init] = requestMock.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.operations[0].reverts_operation_id).toBe('op-100')
  })

  it('响应把 snake_case 反序列化为 camelCase（accepted 带 server_seq/row_versions）', async () => {
    requestMock.mockResolvedValue(
      okResponse({
        results: [
          {
            operation_id: 'op-000000000001',
            status: 'accepted',
            server_seq: 42,
            row_versions: { 'sync-000000000001': 1 },
          },
        ],
      }),
    )
    const { results } = await api.push([sampleOperation()])

    expect(results[0]).toMatchObject({
      operationId: 'op-000000000001',
      status: 'accepted',
      serverSeq: 42,
      rowVersions: { 'sync-000000000001': 1 },
    })
  })

  it('响应把 conflict/rejected 反序列化（conflict_json / errors 带 entitySyncId）', async () => {
    requestMock.mockResolvedValue(
      okResponse({
        results: [
          {
            operation_id: 'op-000000000001',
            status: 'conflict',
            conflict_json: { theirs: { row_version: 5 } },
          },
          {
            operation_id: 'op-000000000002',
            status: 'rejected',
            errors: [{ entity_sync_id: 'sync-2', error_code: 'invalid_quantity' }],
          },
        ],
      }),
    )
    const { results } = await api.push([sampleOperation()])

    expect(results[0].conflictJson).toEqual({ theirs: { row_version: 5 } })
    expect(results[1].errors?.[0]).toEqual({
      entitySyncId: 'sync-2',
      errorCode: 'invalid_quantity',
    })
  })
})

describe('HttpSyncApi.pull / bootstrap', () => {
  it('pull 响应 snake→camel 映射（after_json / after_version / reverts）', async () => {
    requestMock.mockResolvedValue(
      okResponse({
        operations: [
          {
            server_seq: 42,
            operation_id: 'op-r',
            operation_type: 'create_customer',
            reverts_operation_id: 'op-100',
            created_at: '2026-08-08T00:00:00Z',
            changes: [
              {
                entity_type: 'customer',
                entity_sync_id: 'sync-r',
                change_type: 'create',
                after_json: '{"sync_id":"sync-r"}',
                after_version: 1,
              },
            ],
          },
        ],
        has_more: false,
      }),
    )
    const result = await api.pull(0)

    expect(result.operations[0]).toMatchObject({
      serverSeq: 42,
      operationId: 'op-r',
      revertsOperationId: 'op-100',
    })
    expect(result.operations[0].changes[0]).toMatchObject({
      entityType: 'customer',
      entitySyncId: 'sync-r',
      afterVersion: 1,
    })
  })

  it('bootstrap 响应 snake→camel 映射', async () => {
    requestMock.mockResolvedValue(
      okResponse({
        snapshot_seq: 5,
        has_more: false,
        customers: [],
        service_categories: [],
        work_orders: [],
        customer_code_mappings: [],
      }),
    )
    const result = await api.bootstrap()

    expect(result).toMatchObject({ snapshotSeq: 5, hasMore: false })
  })
})
