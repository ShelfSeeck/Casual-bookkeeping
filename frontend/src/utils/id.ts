// 统一 ID 生成：业务前缀 + uuid4().hex[:12]（docs/auth-structure.md §2.7）。
// 前缀对应：dev-（device_id）、op-（operation_id）、sync-（sync_id）、turn-（turn_id）。

export function newId(prefix: string): string {
  const rand = crypto.randomUUID().replace(/-/g, '')
  return `${prefix}-${rand.slice(0, 12)}`
}
