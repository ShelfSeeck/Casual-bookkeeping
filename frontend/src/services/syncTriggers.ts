// 同步触发器：前台恢复（visibilitychange）与网络恢复（online）时触发同步。
// 事件回调只负责“点火”：同步失败由 sync() 内部的 catch 吞掉，不产生未处理 rejection。
export function installSyncTriggers(sync: () => Promise<void>): () => void {
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      sync().catch(() => {})
    }
  }

  const onOnline = () => {
    sync().catch(() => {})
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('online', onOnline)

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('online', onOnline)
  }
}
