import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installSyncTriggers } from './syncTriggers'

// 被测缝：installSyncTriggers 的事件接线（docs/sync-protocol.md 触发时机：前台恢复 / 网络恢复）
// 验证：
// 1. visibilitychange 在 visible 时调用 sync，hidden 时不调用
// 2. window online 事件调用 sync
// 3. sync 返回 rejected Promise 时不产生未处理 rejection
// 4. cleanup 移除两个监听
// 通过 stub globalThis.document / globalThis.window 的真实事件方法验证行为。

function makeEventTarget() {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  return {
    visibilityState: 'visible',
    listeners,
    addEventListener: vi.fn(
      (type: string, handler: (event: unknown) => void) => {
        const set = listeners.get(type) ?? new Set()
        set.add(handler)
        listeners.set(type, set)
      },
    ),
    removeEventListener: vi.fn(
      (type: string, handler: (event: unknown) => void) => {
        listeners.get(type)?.delete(handler)
      },
    ),
  }
}

type EventTargetStub = ReturnType<typeof makeEventTarget>

function emit(target: EventTargetStub, type: string): void {
  for (const handler of target.listeners.get(type) ?? []) {
    handler({})
  }
}

let documentTarget: EventTargetStub
let windowTarget: EventTargetStub

beforeEach(() => {
  documentTarget = makeEventTarget()
  windowTarget = makeEventTarget()
  vi.stubGlobal('document', documentTarget)
  vi.stubGlobal('window', windowTarget)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('installSyncTriggers', () => {
  it('triggers sync on visibilitychange when visible and not when hidden', () => {
    const sync = vi.fn(async () => {})
    const cleanup = installSyncTriggers(sync)

    documentTarget.visibilityState = 'hidden'
    emit(documentTarget, 'visibilitychange')
    expect(sync).not.toHaveBeenCalled()

    documentTarget.visibilityState = 'visible'
    emit(documentTarget, 'visibilitychange')
    expect(sync).toHaveBeenCalledTimes(1)

    cleanup()
  })

  it('triggers sync on window online event', () => {
    const sync = vi.fn(async () => {})
    const cleanup = installSyncTriggers(sync)

    emit(windowTarget, 'online')
    expect(sync).toHaveBeenCalledTimes(1)

    cleanup()
  })

  it('does not leave an unhandled rejection when sync fails', async () => {
    const nodeProcess = (globalThis as unknown as {
      process: {
        on: (event: string, listener: (reason: unknown) => void) => void
        off: (event: string, listener: (reason: unknown) => void) => void
      }
    }).process
    const onUnhandled = vi.fn()
    nodeProcess.on('unhandledRejection', onUnhandled)
    try {
      const cleanup = installSyncTriggers(() => Promise.reject(new Error('sync failed')))
      emit(documentTarget, 'visibilitychange')

      await Promise.resolve()
      await Promise.resolve()

      expect(onUnhandled).not.toHaveBeenCalled()
      cleanup()
    } finally {
      nodeProcess.off('unhandledRejection', onUnhandled)
    }
  })

  it('cleanup removes both listeners', () => {
    const sync = vi.fn(async () => {})
    const cleanup = installSyncTriggers(sync)

    cleanup()

    documentTarget.visibilityState = 'visible'
    emit(documentTarget, 'visibilitychange')
    emit(windowTarget, 'online')

    expect(sync).not.toHaveBeenCalled()
    expect(documentTarget.removeEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    )
    expect(windowTarget.removeEventListener).toHaveBeenCalledWith(
      'online',
      expect.any(Function),
    )
  })
})
