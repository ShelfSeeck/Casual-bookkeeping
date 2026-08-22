// 构建时由 vite.config.ts 的 define 注入
declare const __BUILD_TIME__: string

export function buildTime(): string {
  return __BUILD_TIME__
}
