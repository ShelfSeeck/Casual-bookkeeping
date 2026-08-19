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
  const doc = options.target || (typeof document !== 'undefined' ? document : null)
  if (!doc) {
    return () => {}
  }

  const preventDefaultHandler = (e: Event) => {
    if (e.cancelable) {
      e.preventDefault()
    }
  }

  // 1. iOS WebKit 专有手势缩放拦截（二指捏合/旋转）
  doc.addEventListener('gesturestart', preventDefaultHandler, { passive: false })
  doc.addEventListener('gesturechange', preventDefaultHandler, { passive: false })
  doc.addEventListener('gestureend', preventDefaultHandler, { passive: false })

  // 2. 多指滑动防缩放（仅在 touchmove 阶段拦截多指缩放手势，不影响 touchstart 多指点击）
  const onTouchMove = (e: Event) => {
    const touchEvent = e as TouchEvent
    if (touchEvent.touches && touchEvent.touches.length > 1 && touchEvent.cancelable) {
      touchEvent.preventDefault()
    }
  }
  doc.addEventListener('touchmove', onTouchMove, { passive: false })

  // 3. 阻止全局网页原生拖拽（图片、链接、选中文本的幽灵拖拽）
  doc.addEventListener('dragstart', preventDefaultHandler, { passive: false })

  return () => {
    doc.removeEventListener('gesturestart', preventDefaultHandler)
    doc.removeEventListener('gesturechange', preventDefaultHandler)
    doc.removeEventListener('gestureend', preventDefaultHandler)
    doc.removeEventListener('touchmove', onTouchMove)
    doc.removeEventListener('dragstart', preventDefaultHandler)
  }
}
