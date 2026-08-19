/**
 * 移动端/PWA 触控与视口手势防护（规范精简版）
 *
 * 设计原则：
 * 1. 连击防缩放：完全由 CSS `touch-action: manipulation` 声明式处理，避免在 JS 中用时间戳拦截造成连点丢事件。
 * 2. iOS 捏合缩放：拦截 WebKit 专有的 `gesturestart` / `gesturechange` / `gestureend` 事件，精准禁止二指缩放。
 * 3. 多指滑动防缩放：在 `touchmove` 阶段拦截多指滑动（touches.length > 1），保证多指点击与双手打字完全正常。
 * 4. 网页元素拖拽防误触：拦截 `dragstart` 事件，防止图片/链接长按产生幽灵拖拽框。
 */

export interface TouchGuardsOptions {
  target?: EventTarget
}

export function installTouchGuards(options: TouchGuardsOptions = {}): () => void {
  const targets: EventTarget[] = []
  if (options.target) {
    targets.push(options.target)
  } else if (typeof window !== 'undefined') {
    targets.push(window)
    if (typeof document !== 'undefined' && document !== (window as unknown)) {
      targets.push(document)
    }
  }

  if (targets.length === 0) {
    return () => {}
  }

  const preventDefaultHandler = (e: Event) => {
    if (e.cancelable) {
      e.preventDefault()
    }
  }

  // 多指手势判定（当屏幕上有超过 1 个触点时，拦截触摸与滑动，杜绝二指捏合缩放）
  const onMultiTouch = (e: Event) => {
    const touchEvent = e as TouchEvent
    if (touchEvent.touches && touchEvent.touches.length > 1 && touchEvent.cancelable) {
      touchEvent.preventDefault()
    }
  }

  const listenerOpts: AddEventListenerOptions = { passive: false, capture: true }

  for (const t of targets) {
    // 1. iOS WebKit 专有二指缩放/旋转手势拦截
    t.addEventListener('gesturestart', preventDefaultHandler, listenerOpts)
    t.addEventListener('gesturechange', preventDefaultHandler, listenerOpts)
    t.addEventListener('gestureend', preventDefaultHandler, listenerOpts)

    // 2. 多点触控拦截（touchstart 起手式 + touchmove 移动过程双重锁死）
    t.addEventListener('touchstart', onMultiTouch, listenerOpts)
    t.addEventListener('touchmove', onMultiTouch, listenerOpts)

    // 3. 阻止原生幽灵拖拽
    t.addEventListener('dragstart', preventDefaultHandler, listenerOpts)
  }

  return () => {
    const removeOpts: EventListenerOptions = { capture: true }
    for (const t of targets) {
      t.removeEventListener('gesturestart', preventDefaultHandler, removeOpts)
      t.removeEventListener('gesturechange', preventDefaultHandler, removeOpts)
      t.removeEventListener('gestureend', preventDefaultHandler, removeOpts)
      t.removeEventListener('touchstart', onMultiTouch, removeOpts)
      t.removeEventListener('touchmove', onMultiTouch, removeOpts)
      t.removeEventListener('dragstart', preventDefaultHandler, removeOpts)
    }
  }
}
