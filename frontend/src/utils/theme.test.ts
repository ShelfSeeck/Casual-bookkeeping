/** 主题工具测试：深浅色偏好解析、解析与持久化。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyTheme,
  getThemePreference,
  parseThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
} from './theme'

describe('parseThemePreference', () => {
  it('识别三种合法偏好，未知值回退 system', () => {
    expect(parseThemePreference('light')).toBe('light')
    expect(parseThemePreference('dark')).toBe('dark')
    expect(parseThemePreference('system')).toBe('system')
    expect(parseThemePreference('blue')).toBe('system')
    expect(parseThemePreference(null)).toBe('system')
  })
})

describe('resolveTheme', () => {
  it('跟随系统时按系统深浅解析', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('手动偏好优先于系统', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('applyTheme / getThemePreference', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('写入 localStorage 与 html data-theme', () => {
    const store = new Map<string, string>()
    const dataset: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    })
    vi.stubGlobal('document', { documentElement: { dataset } })

    applyTheme('dark')
    expect(store.get(THEME_STORAGE_KEY)).toBe('dark')
    expect(dataset.theme).toBe('dark')
    expect(getThemePreference()).toBe('dark')
  })
})
