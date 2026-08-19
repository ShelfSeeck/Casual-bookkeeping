import { createApp } from 'vue'
import Vant from 'vant'
import 'vant/lib/index.css'
import { registerSW } from 'virtual:pwa-register'
import './styles/design-tokens.css'
import './style.css'
import { initTheme } from './utils/theme'
import { installTouchGuards } from './utils/touchGuards'
import App from './App.vue'

// 主题：与 index.html 引导脚本同步，保证 DOM 状态与持久化偏好一致。
initTheme()

// 移动端/PWA 手势与视口防线：阻止二指捏合缩放、多点触控放大、双击放大误触及原生拖拽
installTouchGuards()

// PWA：注册 Service Worker（autoUpdate 模式，新版本自动 skipWaiting + clientsClaim）。
registerSW({ immediate: true })

// 新 SW 接管后提示刷新，避免用户一直停留在旧版本。
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  if (window.confirm('应用已更新，是否立即刷新？')) {
    window.location.reload()
  }
})

// 申请持久化存储（persistent）：降低 IndexedDB 业务数据被浏览器在
// 磁盘空间不足时自动清除的风险。best-effort 兜底，失败不阻塞启动；
// 最终兜底仍是同步到后端（本地库不是唯一一份）。
requestPersistentStorage()

createApp(App).use(Vant).mount('#app')

function requestPersistentStorage(): void {
  if (!navigator.storage?.persist) return
  void navigator.storage.persist().then((granted) => {
    if (granted) return
    // 未授予：仍处 best-effort 档。iOS Safari 基本不会授予，属已知限制（见 AGENTS.md 未定事项）。
  })
}
