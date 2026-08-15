import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, type SessionCallbacks } from './apiClient'
import { ChatApi, type ChatSseEvent } from './chatApi'

// 被测缝：ChatApi（docs/spec/chat-agent.md §4/§5、docs/spec/agent-tools.md §8）
// 验证：
// 1. 三个 JSON 端点（createSession/listSessions/listTurns）的路径、方法与 snake→camel 映射。
// 2. streamTurn 用 fetch + ReadableStream 解析 SSE（POST 不支持 EventSource）：
//    data: 帧按 \n\n 分割，支持多个帧与跨 chunk 拆分。
// 3. streamTurn 开始阶段 401 → apiClient.refreshNow() 后带新 token 重试一次。
// 4. 非 2xx JSON 错误抛出的 Error.message 包含后端 error_code（供 errorMessages 映射）。

const ACCESS = 'access-1'
const NEW_ACCESS = 'access-2'
const REFRESH_PATH = '/auth/refresh'

function makeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k) => store.get(k) ?? null,
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => void store.set(k, String(v)),
  }
}

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    async json() {
      return body
    },
    async text(): Promise<string> {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  } as unknown as Response
}

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

let callbacks: SessionCallbacks
let client: ApiClient
let chat: ChatApi

beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorage())
  callbacks = { onSessionInvalid: vi.fn() }
  client = new ApiClient(callbacks)
  chat = new ChatApi(client)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ChatApi JSON 端点', () => {
  it('createSession POST /chat/sessions 并把响应映射为 camelCase', async () => {
    const requestMock = vi.fn()
    requestMock.mockResolvedValue(
      okResponse({
        session_id: 's-1',
        title: '7月对账',
        created_at: '2026-08-14T00:00:00Z',
        updated_at: '2026-08-14T00:00:00Z',
      }),
    )
    chat = new ChatApi({ request: requestMock } as unknown as ApiClient)

    const session = await chat.createSession('7月对账')

    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(requestMock).toHaveBeenCalledWith(
      '/chat/sessions',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ title: '7月对账' }) }),
    )
    expect(session).toEqual({
      sessionId: 's-1',
      title: '7月对账',
      createdAt: '2026-08-14T00:00:00Z',
      updatedAt: '2026-08-14T00:00:00Z',
    })
  })

  it('listSessions GET /chat/sessions 并拆出 sessions 数组', async () => {
    const requestMock = vi.fn()
    requestMock.mockResolvedValue(
      okResponse({
        sessions: [
          { session_id: 's-2', title: '对账', created_at: '2026-08-13T00:00:00Z', updated_at: '2026-08-13T00:00:00Z' },
        ],
      }),
    )
    chat = new ChatApi({ request: requestMock } as unknown as ApiClient)

    const sessions = await chat.listSessions()

    expect(requestMock).toHaveBeenCalledWith('/chat/sessions')
    expect(sessions).toEqual([
      { sessionId: 's-2', title: '对账', createdAt: '2026-08-13T00:00:00Z', updatedAt: '2026-08-13T00:00:00Z' },
    ])
  })

  it('listTurns GET /chat/sessions/{sid}/turns 带游标与 limit，映射 turns 与 nextCursor', async () => {
    const requestMock = vi.fn()
    requestMock.mockResolvedValue(
      okResponse({
        turns: [
          {
            turn_id: 'turn-2',
            created_at: '2026-08-14T00:00:00Z',
            messages: [
              { role: 'user', content: '帮我把昨天王老板的工单改成 12 件', type: 'text' },
              { role: 'assistant', content: '好的，改为 12 件。', type: 'text' },
            ],
          },
        ],
        next_cursor: 'turn-2',
      }),
    )
    chat = new ChatApi({ request: requestMock } as unknown as ApiClient)

    const page = await chat.listTurns('s1', { afterTurnId: 'turn-1', limit: 50 })

    expect(requestMock).toHaveBeenCalledWith('/chat/sessions/s1/turns?after_turn_id=turn-1&limit=50')
    expect(page.nextCursor).toBe('turn-2')
    expect(page.turns).toHaveLength(1)
    expect(page.turns[0]).toEqual({
      turnId: 'turn-2',
      createdAt: '2026-08-14T00:00:00Z',
      messages: [
        { role: 'user', content: '帮我把昨天王老板的工单改成 12 件', type: 'text' },
        { role: 'assistant', content: '好的，改为 12 件。', type: 'text' },
      ],
    })
  })
})

describe('ChatApi.streamTurn SSE', () => {
  it('用 fetch + ReadableStream 解析多个 data: 帧，支持跨 chunk 拆分', async () => {
    localStorage.setItem('cb_access_token', ACCESS)
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      sseResponse([
        'data: {"type":"text_delta","content":"你',
        '好"}\n\ndata: {"type":"tool_confirm_request","request_id":"ar-000000000001","tool_call_id":"pyd_ai_1","tool_name":"update_work_order","draft":{"entity_sync_id":"sync-000000000001","base_version":4,"fields":{"quantity":12}}}\n\n',
        'data: {"type":"done","turn_id":"turn-000000000001","error":null}\n\n',
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const events: ChatSseEvent[] = []
    await chat.streamTurn('s1', { turn_id: 'turn-000000000001', message: '帮我把昨天王老板的工单改成 12 件' }, (e) => {
      events.push(e)
    })

    expect(events).toEqual([
      { type: 'text_delta', content: '你好' },
      {
        type: 'tool_confirm_request',
        request_id: 'ar-000000000001',
        tool_call_id: 'pyd_ai_1',
        tool_name: 'update_work_order',
        draft: {
          entity_sync_id: 'sync-000000000001',
          base_version: 4,
          fields: { quantity: 12 },
        },
      },
      { type: 'done', turn_id: 'turn-000000000001', error: null },
    ])

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/chat/sessions/s1/turns')
    expect(new Headers(init?.headers as HeadersInit).get('Authorization')).toBe(`Bearer ${ACCESS}`)
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      turn_id: 'turn-000000000001',
      message: '帮我把昨天王老板的工单改成 12 件',
    })
  })

  it('开始阶段 401 时 refreshNow 一次并用新 token 重试', async () => {
    localStorage.setItem('cb_access_token', ACCESS)
    let turnCalls = 0
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === REFRESH_PATH) {
        return new Response(JSON.stringify({ access_token: NEW_ACCESS }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url === '/chat/sessions/s1/turns') {
        turnCalls += 1
        if (turnCalls === 1) {
          return new Response(JSON.stringify({ error_code: 'invalid_token' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return sseResponse(['data: {"type":"done","turn_id":"turn-000000000001","error":null}\n\n'])
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const events: ChatSseEvent[] = []
    await chat.streamTurn('s1', { message: '你好' }, (e) => {
      events.push(e)
    })

    expect(turnCalls).toBe(2)
    expect(events).toEqual([{ type: 'done', turn_id: 'turn-000000000001', error: null }])
    expect(localStorage.getItem('cb_access_token')).toBe(NEW_ACCESS)

    const turnRequests = fetchMock.mock.calls.filter(([url]) => url === '/chat/sessions/s1/turns')
    expect(new Headers(turnRequests[0][1]?.headers as HeadersInit).get('Authorization')).toBe(
      `Bearer ${ACCESS}`,
    )
    expect(new Headers(turnRequests[1][1]?.headers as HeadersInit).get('Authorization')).toBe(
      `Bearer ${NEW_ACCESS}`,
    )
  })

  it('approveTurn 走同一 SSE 传输：payload 为 approval_request_id/approved 且事件分发', async () => {
    localStorage.setItem('cb_access_token', ACCESS)
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      sseResponse([
        'data: {"type":"text_delta","content":"已批准"}\n\n',
        'data: {"type":"done","turn_id":"turn-000000000001","error":null}\n\n',
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)

    const events: ChatSseEvent[] = []
    await chat.approveTurn('s1', 'ar-000000000001', true, (e) => {
      events.push(e)
    })

    expect(events).toEqual([
      { type: 'text_delta', content: '已批准' },
      { type: 'done', turn_id: 'turn-000000000001', error: null },
    ])

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/chat/sessions/s1/turns')
    expect(new Headers(init?.headers as HeadersInit).get('Authorization')).toBe(`Bearer ${ACCESS}`)
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      approval_request_id: 'ar-000000000001',
      approved: true,
    })
  })

  it('非 2xx JSON 错误抛出包含后端 error_code 的 Error', async () => {
    localStorage.setItem('cb_access_token', ACCESS)
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error_code: 'session_busy', message: 'busy' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      chat.streamTurn('s1', { message: '你好' }, vi.fn()),
    ).rejects.toThrow('session_busy')
    // 非 2xx 不重试
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
