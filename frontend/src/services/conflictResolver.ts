// 冲突解析（docs/sync-protocol.md §7）：Base / Ours / Theirs 三方比对。
//
// - Base     outbox.command 里的 base_snapshot（修改前快照）
// - Ours     Base 应用 patch 后的本地目标结果
// - Theirs   冲突响应 conflict_json.theirs（服务端当前状态）
//
// 规则：双方改不同字段 → 可自动合并；改同一字段 → 需用户选 Ours / Theirs / 手填。
// 合并结果生成新 patch（相对 Theirs），以 Theirs 的 row_version 作为新 base_version 重推。

export interface FieldDiff {
  field: string
  state: 'ours-only' | 'theirs-only' | 'both'
  baseValue: unknown
  oursValue: unknown
  theirsValue: unknown
}

export interface ConflictAnalysis {
  diffs: FieldDiff[]
  /** 没有双方都改的字段 → 可自动合并；否则需用户逐字段决策 */
  autoMergable: boolean
}

/** 单个冲突字段的取值来源：Ours / Theirs / 手填自定义值。 */
export type FieldResolution = { source: 'ours' | 'theirs' } | { value: unknown }

export type ConflictResolution = Record<string, FieldResolution>

/** 冲突比对时排除的账本元字段（docs/data-model.md §5.3 的“非业务字段”）。
 *  work_order_id / mapping_id / service_category_id 是各表内部主键，不应进入冲突决策；
 *  customer_id 是业务身份，保留。 */
export const WIRE_META_FIELDS = [
  'row_version',
  'updated_at',
  'created_at',
  'account_phone',
  'sync_id',
  'work_order_id',
  'mapping_id',
  'service_category_id',
] as const

/** 浅拷贝剔除账本元字段，不修改入参（供冲突中心与合并 patch 使用）。 */
export function stripWireMetaFields(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const meta = WIRE_META_FIELDS as readonly string[]
  for (const [key, value] of Object.entries(record)) {
    if (meta.includes(key)) continue
    out[key] = value
  }
  return out
}

/** 三方比对：输出字段级差异（docs/sync-protocol.md §7）。 */
export function analyzeConflict(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
): ConflictAnalysis {
  const keys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])
  const diffs: FieldDiff[] = []
  for (const field of keys) {
    const oursChanged =
      Object.hasOwn(ours, field) && !deepEqual(base[field], ours[field])
    const theirsChanged =
      Object.hasOwn(theirs, field) && !deepEqual(base[field], theirs[field])
    if (!oursChanged && !theirsChanged) continue
    diffs.push({
      field,
      state: oursChanged && theirsChanged ? 'both' : oursChanged ? 'ours-only' : 'theirs-only',
      baseValue: base[field],
      oursValue: ours[field],
      theirsValue: theirs[field],
    })
  }
  return { diffs, autoMergable: diffs.every((d) => d.state !== 'both') }
}

/**
 * 生成合并 patch（相对 Theirs）：ours-only 字段取 Ours，theirs-only 不写
 * （Theirs 已包含），both 字段按 resolution 决策。both 字段缺决策 → 抛错。
 * 逐字段显式决策（docs/sync-protocol.md §7）：
 * - ours-only：resolution 显式选 Theirs → 不写（保持 Theirs）；{value} 手填 → 写手填值；
 *   缺省或 {source:'ours'} → 照旧写 oursValue。
 * - theirs-only：resolution 显式选 Ours → 写 oursValue（覆盖 Theirs）；{value} 手填 → 写手填值；
 *   缺省或 {source:'theirs'} → 照旧跳过。
 */
export function buildMergedPatch(
  analysis: ConflictAnalysis,
  resolution: ConflictResolution,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const diff of analysis.diffs) {
    const pick = resolution[diff.field]
    if (diff.state === 'theirs-only') {
      if (pick && 'source' in pick) {
        if (pick.source === 'ours') patch[diff.field] = diff.oursValue
      } else if (pick) {
        patch[diff.field] = pick.value
      }
      continue
    }
    if (diff.state === 'ours-only') {
      if (pick && 'source' in pick) {
        if (pick.source === 'theirs') continue
      } else if (pick) {
        patch[diff.field] = pick.value
        continue
      }
      patch[diff.field] = diff.oursValue
      continue
    }
    // both：必须由调用方决策（UI 用户选择或手填）
    if (!pick) throw new Error(`conflict_field_unresolved:${diff.field}`)
    if ('source' in pick) {
      patch[diff.field] = pick.source === 'ours' ? diff.oursValue : diff.theirsValue
    } else {
      patch[diff.field] = pick.value
    }
  }
  return patch
}

/** 自动合并（仅 autoMergable 时可用）：both 字段缺省按 Ours 优先。 */
export function autoMergePatch(analysis: ConflictAnalysis): Record<string, unknown> {
  const both: ConflictResolution = {}
  for (const diff of analysis.diffs) {
    if (diff.state === 'both') both[diff.field] = { source: 'ours' }
  }
  return buildMergedPatch(analysis, both)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>)
    const bKeys = Object.keys(b as Record<string, unknown>)
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    )
  }
  return false
}
