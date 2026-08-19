// 大类两区拖拽后的全局顺序重算纯函数。
// 输入当前全局顺序（syncId 数组）与要移动的项及目标位置，返回新全局顺序；
// 不修改入参，其余项相对顺序保持不变。

export function reorderGlobalOrder(
  orderedIds: string[],
  movedId: string,
  toIndex: number,
): string[] {
  if (!orderedIds.includes(movedId)) {
    throw new Error(`moved_id_not_found:${movedId}`)
  }
  const rest = orderedIds.filter((id) => id !== movedId)
  const clamped = Math.max(0, Math.min(toIndex, rest.length))
  return [...rest.slice(0, clamped), movedId, ...rest.slice(clamped)]
}

/** 把两区的新顺序合并回全局顺序：保持另一区在全局中的槽位不变，
 *  被拖拽区按新顺序填入自己的槽位。 */
export function mergeCategoryOrders(
  allIds: string[],
  activeIds: string[],
  inactiveIds: string[],
): string[] {
  const activeSet = new Set(activeIds)
  const inactiveSet = new Set(inactiveIds)
  if (activeSet.size + inactiveSet.size !== new Set(allIds).size) {
    throw new Error('category_order_mismatch')
  }
  const activeQueue = [...activeIds]
  const inactiveQueue = [...inactiveIds]
  return allIds.map((id) => {
    if (activeSet.has(id)) {
      const next = activeQueue.shift()
      if (next === undefined) throw new Error('category_order_mismatch')
      return next
    }
    const next = inactiveQueue.shift()
    if (next === undefined) throw new Error('category_order_mismatch')
    return next
  })
}
