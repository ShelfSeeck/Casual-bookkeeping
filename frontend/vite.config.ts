import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 开发代理目标，优先级：shell 环境变量 > .env.local / .env > 默认值。
  // 配置项登记在 frontend/.env.example；本机覆盖写在 frontend/.env.local（不入库）。
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.CB_API_TARGET || 'http://127.0.0.1:8000'

  return {
    plugins: [
      vue(),
      VitePWA({
        registerType: 'autoUpdate',
        // 手动在 main.ts 用 virtual:pwa-register 注册，便于监听 controllerchange 提示刷新。
        // favicon.png / apple-touch-icon.png 已在 public 下、被下方 globPatterns 命中，无需 includeAssets 重复声明。
        injectRegister: false,
        manifest: {
          id: '/',
          name: 'Casual-bookkeeping 记账',
          short_name: '记账',
          description: '衣物处理厂移动端离线记账',
          theme_color: '#2563eb',
          background_color: '#ffffff',
          display: 'standalone',
          orientation: 'portrait',
          lang: 'zh-CN',
          icons: [
            { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,txt}'],
          navigateFallbackDenylist: [/^\/(auth|sync|chat)(\/|$)/],
          runtimeCaching: [
            {
              // 业务数据走本地优先（IndexedDB），API 响应一律不缓存，
              // 避免 service worker 返回过期数据覆盖本地已确认状态。
              urlPattern: ({ url }) => /^\/(auth|sync|chat)(\/|$)/.test(url.pathname),
              handler: 'NetworkOnly',
            },
          ],
        },
      }),
    ],
    server: {
      // 开发环境前后端打通：相对路径 API 转发到 FastAPI（目标来自上面的 env 配置）。
      proxy: {
        '/auth': { target: apiTarget, changeOrigin: true },
        '/sync': { target: apiTarget, changeOrigin: true },
        '/chat': { target: apiTarget, changeOrigin: true },
      },
    },
    test: {
      environment: 'node',
      setupFiles: ['./vitest.setup.ts'],
    },
  }
})
