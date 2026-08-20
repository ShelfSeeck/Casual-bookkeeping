import type { CbDatabase } from '../db/schema'
import type { ServiceCategory } from '../db/schema/business/serviceCategories'

/**
 * 自愈清理本地因历史并发误写产生的重复同名大类：
 * 优先保留服务端权威版本（rowVersion 更高 > 小类更全 > 更新时间最新），
 * 彻底清理冗余副本及 outbox / operations 中的残留。
 */
export async function autoDeduplicateCategories(db: CbDatabase): Promise<void> {
  const rawCategories = await db.serviceCategories.toArray()
  const groups = new Map<string, ServiceCategory[]>()
  for (const cat of rawCategories) {
    const list = groups.get(cat.categoryName) ?? []
    list.push(cat)
    groups.set(cat.categoryName, list)
  }

  const duplicatesToRemove: string[] = []

  for (const [, cats] of groups) {
    if (cats.length <= 1) continue

    // 排序选择最佳项：rowVersion DESC > subcategories 数量 DESC > updatedAt DESC
    cats.sort((a, b) => {
      const rvA = a.rowVersion ?? 0
      const rvB = b.rowVersion ?? 0
      if (rvA !== rvB) return rvB - rvA

      const subsA = Array.isArray(a.subcategoriesJson) ? a.subcategoriesJson.length : 0
      const subsB = Array.isArray(b.subcategoriesJson) ? b.subcategoriesJson.length : 0
      if (subsA !== subsB) return subsB - subsA

      return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
    })

    // 保留 cats[0]，其余标记为重复冗余项
    for (let i = 1; i < cats.length; i++) {
      duplicatesToRemove.push(cats[i].syncId)
    }
  }

  if (duplicatesToRemove.length > 0) {
    const removeSet = new Set(duplicatesToRemove)
    await db.transaction('rw', [db.serviceCategories, db.outbox, db.operations], async () => {
      for (const syncId of duplicatesToRemove) {
        await db.serviceCategories.delete(syncId)
      }
      // 清理 outbox 中引用了被删重复记录的全部条目（无论是 pending、sending 还是 rejected）
      const outboxItems = await db.outbox.toArray()
      for (const item of outboxItems) {
        if (item.entitySyncIds.some((id) => removeSet.has(id))) {
          await db.outbox.delete(item.queueId)
        }
      }
      // 清理 operations 中引用了被删重复记录的全部条目，防止残留历史引发同步冲突或 Gate 锁定
      const ops = await db.operations.toArray()
      for (const op of ops) {
        try {
          const parsed = JSON.parse(op.changesJson ?? '{}')
          const directIds: string[] = parsed.entitySyncIds ?? []
          const changeIds: string[] = Array.isArray(parsed.changes)
            ? parsed.changes.map((c: { entitySyncId?: string }) => c.entitySyncId).filter(Boolean)
            : []
          const allIds = new Set([...directIds, ...changeIds])
          if ([...allIds].some((id) => removeSet.has(id))) {
            await db.operations.delete(op.operationId)
          }
        } catch {
          // changesJson 解析失败则跳过
        }
      }
    })
  }
}
