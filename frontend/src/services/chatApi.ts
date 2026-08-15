import type { ApiClient } from './apiClient'

// chatApi：会话/回合/SSE 契约（docs/spec/chat-agent.md §4/§5、docs/spec/agent-tools.md §8）。
// - JSON 端点走 ApiClient.request（401→refresh→重试一次由 ApiClient 统一处理）。
// - streamTurn 因为 POST 不能使用 EventSource，用 fetch + ReadableStream 解析 SSE；
//   开始阶段 401 → apiClient.refreshNow() 一次并用新 token 重试。
// - SSE 帧格式：`data: {json}\n\n`；只分发契约内的三种事件，未知类型忽略。

export interface ChatSession {
  sessionId: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  type: string
  toolName?: string
  draft?: unknown
}

export interface ChatTurn {
  turnId: string
  createdAt: string
  messages: ChatMessage[]
}

export interface ChatTurnPage {
  turns: ChatTurn[]
  nextCursor: string | null
}

export type ChatSseEvent =
  | { type: 'text_delta'; content: string }
  | {
      type: 'tool_confirm_request'
      request_id: string
      tool_call_id: string
      tool_name: string
      draft: unknown
    }
  | {
      type: 'done'
      turn_id: string
      error: { error_code: string; message: string } | null
    }

export interface TurnPayload {
  turn_id?: string
  message?: string
  allowed_tools?: string[]
  approval_request_id?: string
  approved?: boolean
}

interface RawSession {
  session_id: string
  title: string
  created_at: string
  updated_at: string
}

interface RawChatMessage {
  role: 'user' | 'assistant'
  content: string
  type: string
  tool_name?: string
  draft?: unknown
}

interface RawTurn {
  turn_id: string
  created_at: string
  messages: RawChatMessage[]
}

export class ChatApi {
  private api: ApiClient

  constructor(api: ApiClient) {
    this.api = api
  }

  async createSession(title: string): Promise<ChatSession> {
    const resp = await this.api.request('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    const body = (await resp.json()) as RawSession
    return ChatApi.toSession(body)
  }

  async listSessions(): Promise<ChatSession[]> {
    const resp = await this.api.request('/chat/sessions')
    const body = (await resp.json()) as { sessions: RawSession[] }
    return body.sessions.map(ChatApi.toSession)
  }

  async listTurns(
    sid: string,
    opts: { afterTurnId?: string; limit?: number } = {},
  ): Promise<ChatTurnPage> {
    const params = new URLSearchParams()
    if (opts.afterTurnId !== undefined) params.set('after_turn_id', opts.afterTurnId)
    if (opts.limit !== undefined) params.set('limit', String(opts.limit))
    const query = params.toString()
    const url = `/chat/sessions/${encodeURIComponent(sid)}/turns${query ? `?${query}` : ''}`
    const resp = await this.api.request(url)
    const body = (await resp.json()) as { turns: RawTurn[]; next_cursor: string | null }
    return {
      turns: body.turns.map((t) => ({
        turnId: t.turn_id,
        createdAt: t.created_at,
        messages: t.messages.map((m) => ({
          role: m.role,
          content: m.content,
          type: m.type,
          ...(m.tool_name !== undefined ? { toolName: m.tool_name } : {}),
          ...(m.draft !== undefined ? { draft: m.draft } : {}),
        })),
      })),
      nextCursor: body.next_cursor,
    }
  }

  async approveTurn(
    sid: string,
    approvalRequestId: string,
    approved: boolean,
    onEvent: (e: ChatSseEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.streamPost(
      sid,
      { approval_request_id: approvalRequestId, approved },
      onEvent,
      signal,
    )
  }

  async streamTurn(
    sid: string,
    payload: TurnPayload,
    onEvent: (e: ChatSseEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.streamPost(sid, payload, onEvent, signal)
  }

  // ---------- 私有辅助 ----------

  private async streamPost(
    sid: string,
    payload: TurnPayload,
    onEvent: (e: ChatSseEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `/chat/sessions/${encodeURIComponent(sid)}/turns`
    const init: RequestInit = {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        ...this.authHeaders(),
      },
      body: JSON.stringify(payload),
      signal,
    }

    let resp = await fetch(url, init)
    if (resp.status === 401) {
      // 开始阶段 access 过期：刷新一次（single-flight 在 ApiClient 内）→ 用新 token 重试
      const newToken = await this.api.refreshNow()
      const retryHeaders = new Headers(init.headers)
      retryHeaders.set('Authorization', `Bearer ${newToken}`)
      resp = await fetch(url, { ...init, headers: retryHeaders })
    }

    if (!resp.ok) {
      throw await ChatApi.toAppError(resp)
    }
    if (!resp.body) {
      throw new Error('sse_body_missing')
    }
    await ChatApi.readSse(resp.body, onEvent)
  }

  private authHeaders(): Record<string, string> {
    const token = this.api.getAccessToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  private static toSession(raw: RawSession): ChatSession {
    return {
      sessionId: raw.session_id,
      title: raw.title,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    }
  }

  private static async toAppError(resp: Response): Promise<Error> {
    try {
      const body = (await resp.json()) as { error_code?: string; message?: string }
      return new Error(body.error_code ?? `http_${resp.status}`)
    } catch {
      return new Error(`http_${resp.status}`)
    }
  }

  private static async readSse(
    body: ReadableStream<Uint8Array>,
    onEvent: (e: ChatSseEvent) => void,
  ): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        buffer = ChatApi.consumeFrames(buffer, onEvent)
      }
    } finally {
      reader.releaseLock()
    }
  }

  /** 从累积 buffer 中切出完整的 `\n\n` 帧并分发；返回未处理完的剩余部分。 */
  private static consumeFrames(
    buffer: string,
    onEvent: (e: ChatSseEvent) => void,
  ): string {
    let rest = buffer
    while (true) {
      const sep = rest.indexOf('\n\n')
      if (sep === -1) break
      const frame = rest.slice(0, sep)
      rest = rest.slice(sep + 2)
      ChatApi.dispatchFrame(frame, onEvent)
    }
    return rest
  }

  private static dispatchFrame(
    frame: string,
    onEvent: (e: ChatSseEvent) => void,
  ): void {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).replace(/^ /, ''))
      .join('\n')
    if (!data.trim()) return

    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const event = parsed as { type?: unknown }
    if (
      event.type === 'text_delta' ||
      event.type === 'tool_confirm_request' ||
      event.type === 'done'
    ) {
      onEvent(parsed as ChatSseEvent)
    }
  }
}
