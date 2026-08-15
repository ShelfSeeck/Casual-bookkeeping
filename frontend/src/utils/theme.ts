// theme：外观主题偏好（浅色 / 深色 / 跟随系统）。
// - 偏好持久化在 localStorage（cb_theme），HTML 根节点 data-theme 同步更新。
// - CSS 侧规则：data-theme="dark" 强制深色；data-theme="light" 强制浅色；
//   data-theme="system"（或缺失）时由 prefers-color-scheme 媒体查询决定。
// - index.html 有同逻辑的内联引导脚本，避免首屏闪烁（FOUC）；这里保持
//   应用内状态与 DOM 一致，并供设置页读写。

export const THEME_STORAGE_KEY = 'cb_theme'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  return 'system'
}

export function getThemePreference(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'system'
  return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY))
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'light') return 'light'
  if (preference === 'dark') return 'dark'
  return systemDark ? 'dark' : 'light'
}

export function applyTheme(preference: ThemePreference): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = preference
    const meta = document.querySelector?.('meta[name="theme-color"]')
    if (meta) {
      const systemDark =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
      const dark = resolveTheme(preference, systemDark) === 'dark'
      meta.setAttribute('content', dark ? '#0f172a' : '#2563eb')
    }
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // 隐私模式等场景下 localStorage 不可写：仅本次会话内生效，不阻断页面。
  }
}

/** 应用启动时调用：把持久化偏好同步到 DOM（index.html 引导脚本已先行设置）。 */
export function initTheme(): ThemePreference {
  const preference = getThemePreference()
  applyTheme(preference)
  return preference
}
