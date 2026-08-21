import { computed, reactive, ref } from 'vue'
import type { CbDatabase } from '../db/schema'
import {
  type ServiceCategoryUi,
  type CustomerUi,
  type CustomerEntityUi,
  type CustomerMappingUi,
  type WorkOrderUi,
} from '../types/ui'
import { CustomersRepository } from '../repositories/customers'
import { CustomerCodeMappingsRepository } from '../repositories/customerCodeMappings'
import { ServiceCategoriesRepository } from '../repositories/serviceCategories'
import { WorkOrdersRepository } from '../repositories/workOrders'
import {
  addCustomerCodeMapping as addCustomerCodeMappingCommand,
  archiveCustomerWithMappings as archiveCustomerWithMappingsCommand,
  batchPriceWorkOrders,
  buildCustomerWithMapping,
  createCustomer as createCustomerCommand,
  createWorkOrder as createWorkOrderCommand,
  createServiceCategory,
  deleteCustomerCodeMapping as deleteCustomerCodeMappingCommand,
  deleteWorkOrder as deleteWorkOrderCommand,
  reorderServiceCategories,
  revertOperation,
  updateCustomer as updateCustomerCommand,
  updateCustomerCodeMapping as updateCustomerCodeMappingCommand,
  updateServiceCategory,
  updateWorkOrder as updateWorkOrderCommand,
} from '../services/businessCommands'
import { MutationService } from '../services/mutation'
import { getRecordSyncStatus, getSyncCounts } from '../services/syncStatus'
import {
  analyzeConflict,
  stripWireMetaFields,
  type ConflictAnalysis,
  type ConflictResolution,
} from '../services/conflictResolver'
import type { SyncManager } from '../services/syncManager'
import type { Subcategory, ServiceCategory } from '../db/schema/business/serviceCategories'
import { ChatApi, type ChatSession, type ChatSseEvent, type ToolDecision } from '../services/chatApi'
import {
  buildAiBatchOperation,
  prepareAiDraftBatch,
  type AiDraftCall,
  type PreparedAiDraft,
} from '../services/chatApprovalBatch'
import { newId } from '../utils/id'
import { toErrorMessage } from '../services/errorMessages'
import { showFailToast, showSuccessToast } from 'vant'

// appState：正式前端的全局视图状态。
// 数据来自真实 Dexie 业务库 + businessCommands / SyncManager / syncStatus，
// 组件只消费这里组装好的 UI 视图模型。

export type TabKey = 'desk' | 'ledger' | 'chat' | 'settings'

import { getOrCreateDeviceId } from '../db/device'
import {
  buildHistoryItemViewModel,
  type HistoryItemViewModel,
  type HistoryDiffItem,
} from '../utils/historyFormatter'

export interface UndoItem {
  undoId: string
  operationId: string
  message: string
  actionType: 'create' | 'update' | 'delete'
  previousSnapshot?: WorkOrderUi
  createdOrderId?: string
  expiresAt: number
}

/** 工单历史条目（appState.loadOrderHistory 组装，供查账本历史面板展示）。 */
export type HistoryItem = HistoryItemViewModel
export type { HistoryDiffItem }

/** 冲突队列条目（appState.refreshConflicts 组装，供冲突解决 UI 逐项显式决策）。 */
export interface ConflictEntry {
  queueId: number
  operationId: string
  operationType: string
  actorType: 'user' | 'ai' | 'system'
  createdAt: string
  conflictJson: unknown
  base: Record<string, unknown>
  ours: Record<string, unknown>
  theirs: Record<string, unknown>
  diffs: ConflictAnalysis['diffs']
}

export interface ProcessedDraftItem {
  kind: 'create' | 'update'
  customerText: string
  serviceText: string
  quantityText: string
  priceText: string
  statusText: string
  decision: 'approve' | 'regenerate' | 'reject'
  decisionText: string
  reason?: string
}

export interface ProcessedDraftSummary {
  total: number
  approvedCount: number
  regeneratedCount: number
  rejectedCount: number
  items: ProcessedDraftItem[]
}

export interface ChatMessage {
  id: string
  sender: 'user' | 'assistant'
  content: string
  timestamp: string
  draftResult?: ProcessedDraftSummary
  suggestedDraft?: {
    action: 'create_order'
    data: {
      customerName: string
      category: string
      subcategory: string
      quantity: number
      unit: string
      price: number | null
    }
  }
}

export type AiDraftDecisionAction = 'approve' | 'reject' | 'regenerate'

export interface AiDraftDecisionState {
  action: AiDraftDecisionAction
  reasonCode: string
  note: string
}

export interface PendingAiApproval {
  requestId: string
  sessionId: string
  turnId: string
  calls: AiDraftCall[]
  drafts: PreparedAiDraft[]
  decisions: Record<string, AiDraftDecisionState>
  localOperationId: string | null
  resumeError: string | null
}

const WELCOME_MESSAGE: ChatMessage = {
  id: 'm1',
  sender: 'assistant',
  content: '你好！我是你的记账助手。可以直接问我“今日记账汇总”，或让我帮你记一张工单草稿。',
  timestamp: '09:00',
}

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function toUiSyncStatus(status: string): WorkOrderUi['syncStatus'] {
  if (status === 'saved') return 'pending'
  if (status === 'conflict' || status === 'rejected') return 'conflict'
  return 'synced'
}

class AppState {
  currentTab = ref<TabKey>('desk')

  // 真实数据组装出的 UI 列表
  customers = reactive<CustomerUi[]>([])
  customerEntities = reactive<CustomerEntityUi[]>([])
  customerMappings = reactive<CustomerMappingUi[]>([])
  categories = reactive<ServiceCategoryUi[]>([])
  workOrders = reactive<WorkOrderUi[]>([])

  get activeCategories(): ServiceCategoryUi[] {
    return this.categories.filter((c) => c.isActive)
  }

  private db: CbDatabase | null = null
  private syncManager: SyncManager | null = null
  private chatApi: ChatApi | null = null
  private chatSessionId: string | null = null
  chatBusy = ref(false)
  pendingApproval = ref<PendingAiApproval | null>(null)
  chatSessions = reactive<ChatSession[]>([])
  isNewChat = ref(false)
  private chatDrafts = new Map<string, string>()

  ledgerFilters = reactive({
    datePreset: 'today' as 'today' | 'yesterday' | 'this_week' | 'this_month' | 'custom' | 'all',
    customStartDate: localToday(),
    customEndDate: localToday(),
    customerId: null as number | null,
    categoryName: null as string | null,
    searchKeyword: '',
  })

  activeUndo = ref<UndoItem | null>(null)
  conflictEntries = ref<ConflictEntry[]>([])
  private undoTimer: ReturnType<typeof setTimeout> | null = null

  chatMessages = reactive<ChatMessage[]>([{ ...WELCOME_MESSAGE }])

  // ---------- 初始化与数据加载 ----------

  async init(db: CbDatabase, syncManager: SyncManager | null = null): Promise<void> {
    this.db = db
    this.syncManager = syncManager
    await this.reload()
    await this.restorePendingAiApproval()
  }

  async reload(): Promise<void> {
    const db = this.db
    if (!db) return
    await this.autoDeduplicateCategories(db)
    const [customers, mappings, categories, orders] = await Promise.all([
      new CustomersRepository(db).list(),
      new CustomerCodeMappingsRepository(db).list(),
      new ServiceCategoriesRepository(db).list(true),
      new WorkOrdersRepository(db).query(),
    ])

    const uiCustomers: CustomerUi[] = []
    const uiMappings: CustomerMappingUi[] = []

    for (const m of mappings) {
      const c = customers.find((x) => x.customerId === m.customerId)
      const canonicalName = c?.canonicalName ?? m.customerName
      uiCustomers.push({
        customerId: m.customerId,
        syncId: m.syncId,
        customerName: canonicalName,
        code: m.customerCode,
        displayName: m.customerName,
        validFrom: m.validFrom,
        validTo: m.validTo,
      })
      uiMappings.push({
        syncId: m.syncId,
        customerId: m.customerId,
        customerCode: m.customerCode,
        customerName: m.customerName,
        canonicalName,
        validFrom: m.validFrom,
        validTo: m.validTo,
      })
    }
    for (const c of customers) {
      if (!uiCustomers.some((x) => x.customerId === c.customerId)) {
        uiCustomers.push({
          customerId: c.customerId,
          customerName: c.canonicalName,
          code: '',
          displayName: c.canonicalName,
          validFrom: '',
          validTo: null,
        })
      }
    }
    this.customers.splice(0, this.customers.length, ...uiCustomers)
    this.customerMappings.splice(0, this.customerMappings.length, ...uiMappings)

    const uiEntities: CustomerEntityUi[] = customers.map((c) => {
      const relatedMappings = uiMappings.filter((m) => m.customerId === c.customerId)
      const activeCodes = relatedMappings
        .filter((m) => m.validTo === null)
        .map((m) => m.customerCode)
      return {
        customerId: c.customerId,
        syncId: c.syncId,
        canonicalName: c.canonicalName,
        archivedAt: c.archivedAt,
        activeCodes,
        mappings: relatedMappings,
      }
    })
    this.customerEntities.splice(0, this.customerEntities.length, ...uiEntities)

    this.categories.splice(
      0,
      this.categories.length,
      ...categories.map((c) => {
        const subs =
          typeof c.subcategoriesJson === 'string'
            ? (JSON.parse(c.subcategoriesJson) as Subcategory[])
            : c.subcategoriesJson
        return {
          categoryId: Number.parseInt(c.syncId.slice(5), 16),
          syncId: c.syncId,
          name: c.categoryName,
          isActive: Boolean(c.isActive),
          sortOrder: c.sortOrder,
          subcategories: subs.map((s) => {
            const raw = s as unknown as Record<string, unknown>
            return {
              name: s.name,
              defaultUnit: String(raw.default_unit ?? s.defaultUnit ?? ''),
              isActive: Boolean(raw.is_active ?? s.isActive ?? true),
            }
          }),
        }
      }),
    )

    const uiOrders: WorkOrderUi[] = []
    // reload 前同 syncId 的旧元素：自动 reload 不清空已加载的 history（只保留该字段）
    const previousBySyncId = new Map(this.workOrders.map((o) => [o.syncId, o]))
    for (const o of orders) {
      const st = await getRecordSyncStatus(db, o.syncId)
      uiOrders.push({
        orderId: o.syncId,
        syncId: o.syncId,
        orderDate: o.workOrderDate,
        customerId: o.customerId,
        customerCode: o.customerCode,
        customerDisplayName: o.customerName,
        customerOfficialName: o.customerName,
        categoryName: o.serviceCategory,
        subcategoryName: o.serviceItem ?? '',
        quantity: o.quantity,
        unit: o.unit,
        unitPriceCents: o.unitPriceCents,
        syncStatus: toUiSyncStatus(st),
        isCompleted: o.isCompleted,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        history: previousBySyncId.get(o.syncId)?.history ?? [],
      })
    }
    this.workOrders.splice(0, this.workOrders.length, ...uiOrders)
    await this.refreshConflicts()
  }

  /**
   * 自愈清理本地因历史并发误写产生的重复同名大类：
   * 保留子项目更丰富或最新的一条，清理冗余副本及 outbox / operations 中的多余提交。
   */
  private async autoDeduplicateCategories(db: CbDatabase): Promise<void> {
    const rawCategories = await db.serviceCategories.toArray()
    const seenNames = new Map<string, ServiceCategory>()
    const duplicatesToRemove: string[] = []

    for (const cat of rawCategories) {
      const existing = seenNames.get(cat.categoryName)
      if (!existing) {
        seenNames.set(cat.categoryName, cat)
      } else {
        const existingSubCount = Array.isArray(existing.subcategoriesJson)
          ? existing.subcategoriesJson.length
          : 0
        const currentSubCount = Array.isArray(cat.subcategoriesJson)
          ? cat.subcategoriesJson.length
          : 0

        if (currentSubCount > existingSubCount) {
          duplicatesToRemove.push(existing.syncId)
          seenNames.set(cat.categoryName, cat)
        } else {
          duplicatesToRemove.push(cat.syncId)
        }
      }
    }

    if (duplicatesToRemove.length > 0) {
      const removeSet = new Set(duplicatesToRemove)
      await db.transaction('rw', [db.serviceCategories, db.outbox, db.operations], async () => {
        for (const syncId of duplicatesToRemove) {
          await db.serviceCategories.delete(syncId)
        }
        // 清理 outbox 中引用了被删重复记录的条目
        const outboxItems = await db.outbox.toArray()
        for (const item of outboxItems) {
          if (item.entitySyncIds.some((id) => removeSet.has(id))) {
            await db.outbox.delete(item.queueId)
          }
        }
        // 清理 operations 中引用了被删重复记录的条目，防止残留历史引发同步冲突
        const ops = await db.operations.toArray()
        for (const op of ops) {
          try {
            const parsed = JSON.parse(op.changesJson ?? '{}')
            const ids: string[] = parsed.entitySyncIds ?? []
            if (ids.some((id) => removeSet.has(id))) {
              await db.operations.delete(op.operationId)
            }
          } catch {
            // changesJson 解析失败则跳过
          }
        }
      })
    }
  }

  /**
   * 加载指定工单的历史操作（docs/data-model.md §5.2 operations 镜像）。
   * changesJson 新形状 {entitySyncIds, changes}；旧形状只有 serverSeq 时兼容跳过。
   * 结果写回 reactive workOrders 数组内对应 order 的 history。
   */
  async loadOrderHistory(orderId: string): Promise<void> {
    const db = this.db
    if (!db) return
    const [rows, outboxEntries, currentDeviceId] = await Promise.all([
      db.operations.toArray(),
      db.outbox.toArray(),
      getOrCreateDeviceId().catch(() => null),
    ])

    const outboxMap = new Map<string, Array<Record<string, unknown>>>()
    for (const entry of outboxEntries) {
      const cmd = entry.command as { changes?: Array<Record<string, unknown>> } | null
      if (cmd && Array.isArray(cmd.changes)) {
        outboxMap.set(entry.operationId, cmd.changes)
      }
    }

    const items: HistoryItem[] = []
    for (const op of rows) {
      let parsed: { entitySyncIds?: unknown; changes?: unknown }
      try {
        parsed = JSON.parse(op.changesJson) as { entitySyncIds?: unknown; changes?: unknown }
      } catch {
        continue
      }
      // 兼容旧形状（如 {serverSeq} 无 entitySyncIds）→ 跳过，不抛错
      if (!Array.isArray(parsed.entitySyncIds) || !parsed.entitySyncIds.includes(orderId)) {
        continue
      }

      const isReverted = rows.some((other) => other.revertsOperationId === op.operationId)
      const canRevert =
        op.operationType !== 'revert_operation' &&
        op.revertsOperationId === null &&
        !isReverted

      const outboxChanges = outboxMap.get(op.operationId)

      const vm = buildHistoryItemViewModel({
        operationId: op.operationId,
        operationType: op.operationType,
        actorType: op.actorType,
        deviceId: op.deviceId,
        createdAt: op.createdAt,
        changesJson: op.changesJson,
        currentDeviceId,
        canRevert,
        isReverted,
        revertsOperationId: op.revertsOperationId,
        customers: this.customers,
        outboxChanges,
      })

      items.push(vm)
    }
    items.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    // 经 reactive 数组内的 proxy 更新，避免直接改局部原始对象不触发视图更新
    const order = this.workOrders.find((o) => o.orderId === orderId)
    if (order) order.history = items
  }

  /** 遍历 outbox 中 conflict 条目，组装冲突分析结果供 UI 逐字段显式决策。 */
  private async refreshConflicts(): Promise<void> {
    const db = this.db
    if (!db) {
      this.conflictEntries.value = []
      return
    }
    const entries = await db.outbox.where('status').equals('conflict').sortBy('queueId')
    const result: ConflictEntry[] = []
    for (const entry of entries) {
      const conflictJson = entry.conflictJson as {
        entity_sync_id?: string
        theirs?: Record<string, unknown>
      } | null
      const command = entry.command as {
        changes?: Array<{
          entitySyncId: string
          entityType?: string
          baseVersion: number
          baseSnapshot?: Record<string, unknown>
          patch?: Record<string, unknown>
        }>
      }
      const changes = command.changes ?? []
      const change =
        changes.find((c) => c.entitySyncId === conflictJson?.entity_sync_id) ?? changes[0]
      if (!conflictJson?.theirs) continue
      // 撤回冲突：command.changes 为空，无三方合并路径，但仍要在冲突中心可见（只读提示）
      if (!change) {
        if (entry.operationType === 'revert_operation') {
          result.push({
            queueId: entry.queueId,
            operationId: entry.operationId,
            operationType: entry.operationType,
            actorType: entry.actorType,
            createdAt: entry.createdAt,
            conflictJson: entry.conflictJson,
            base: {},
            ours: {},
            theirs: stripWireMetaFields(conflictJson.theirs),
            diffs: [],
          })
        }
        continue
      }
      // 三方比对前先剔除账本元字段，避免 row_version/updated_at 被当成业务差异
      const base = stripWireMetaFields(change.baseSnapshot ?? {})
      const ours = stripWireMetaFields({ ...(change.baseSnapshot ?? {}), ...(change.patch ?? {}) })
      const theirs = stripWireMetaFields(conflictJson.theirs)
      result.push({
        queueId: entry.queueId,
        operationId: entry.operationId,
        operationType: entry.operationType,
        actorType: entry.actorType,
        createdAt: entry.createdAt,
        conflictJson: entry.conflictJson,
        base,
        ours,
        theirs,
        diffs: analyzeConflict(base, ours, theirs).diffs,
      })
    }
    this.conflictEntries.value = result
  }

  // ---------- 查账本计算属性 ----------

  filteredOrders = computed(() => {
    const today = localToday()
    return this.workOrders.filter((order) => {
      const f = this.ledgerFilters
      if (f.datePreset === 'today' && order.orderDate !== today) return false
      if (f.datePreset === 'yesterday') {
        const d = new Date()
        d.setDate(d.getDate() - 1)
        const y = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        if (order.orderDate !== y) return false
      }
      if (f.datePreset === 'this_week') {
        const now = new Date()
        const day = now.getDay() || 7
        const monday = new Date(now)
        monday.setDate(now.getDate() - day + 1)
        const mon = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`
        if (order.orderDate < mon) return false
      }
      if (f.datePreset === 'this_month' && order.orderDate.slice(0, 7) !== today.slice(0, 7)) return false
      if (f.datePreset === 'custom') {
        if (f.customStartDate && order.orderDate < f.customStartDate) return false
        if (f.customEndDate && order.orderDate > f.customEndDate) return false
      }
      if (f.customerId !== null && order.customerId !== f.customerId) return false
      if (f.categoryName && order.categoryName !== f.categoryName) return false
      if (f.searchKeyword) {
        const kw = f.searchKeyword.trim().toLowerCase()
        const hit =
          order.customerCode.toLowerCase().includes(kw) ||
          order.customerDisplayName.toLowerCase().includes(kw) ||
          order.categoryName.toLowerCase().includes(kw) ||
          order.subcategoryName.toLowerCase().includes(kw)
        if (!hit) return false
      }
      return true
    })
  })

  ledgerSummary = computed(() => {
    const orders = this.filteredOrders.value
    let totalPieces = 0
    let totalAmountCents = 0
    let unpricedCount = 0
    for (const o of orders) {
      totalPieces += o.quantity
      if (o.unitPriceCents != null) {
        totalAmountCents += Math.round(o.quantity * o.unitPriceCents)
      } else {
        unpricedCount++
      }
    }
    return {
      totalCount: orders.length,
      totalPieces,
      totalAmountYuan: (totalAmountCents / 100).toFixed(2),
      unpricedCount,
    }
  })

  todayOrders = computed(() => {
    const today = localToday()
    return this.workOrders.filter((o) => o.orderDate === today)
  })

  setTab(tab: TabKey) {
    if (tab === 'chat' && this.currentTab.value !== 'chat') {
      if (!this.pendingApproval.value && !this.chatBusy.value && !this.isNewChat.value) {
        this.startNewChat()
      }
    }
    this.currentTab.value = tab
  }

  // ---------- 同步 ----------

  async syncNow(): Promise<void> {
    if (!this.syncManager) return
    await this.syncManager.sync()
    await this.reload()
  }

  async syncCounts(): Promise<{ pending: number; conflict: number; rejected: number }> {
    if (!this.db) return { pending: 0, conflict: 0, rejected: 0 }
    return getSyncCounts(this.db)
  }

  /** 修正错误后重试被拒操作：重建品类 wire 补丁（camelCase→snake_case）→ pending → 同步。 */
  async retryRejected(): Promise<void> {
    const db = this.db
    if (!db) return
    await db.transaction('rw', [db.outbox, db.serviceCategories], async () => {
      const all = await db.outbox.toArray()
      const rejected = all.filter((e) => e.status === 'rejected')
      for (const entry of rejected) {
        const command = entry.command as {
          changes?: Array<{
            entitySyncId: string
            entityType?: string
            baseVersion: number
            baseSnapshot?: Record<string, unknown>
            patch?: Record<string, unknown>
          }>
          reverts_operation_id?: string
        }
        const change = command.changes?.[0]
        if (entry.operationType === 'update_service_category' && change) {
          const local = await db.serviceCategories.get(change.entitySyncId)
          if (local) {
            change.baseVersion = local.rowVersion
            change.patch = {
              ...(change.patch ?? {}),
              subcategories_json: JSON.stringify(
                local.subcategoriesJson.map((s) => ({
                  name: s.name,
                  default_unit: s.defaultUnit,
                  is_active: s.isActive,
                })),
              ),
            }
            entry.command = { ...command, changes: [change] }
          }
        }
        await db.outbox.update(entry.queueId, {
          status: 'pending',
          command: entry.command,
          attempts: 0,
          lastErrorJson: null,
        })
      }
    })
    await this.reload()
    if (this.syncManager) {
      await this.syncManager.sync()
      await this.reload()
    }
  }

  // ---------- 撤销（真实撤回链路） ----------

  triggerUndo(item: Omit<UndoItem, 'expiresAt'>) {
    if (this.undoTimer !== null) clearTimeout(this.undoTimer)
    this.activeUndo.value = { ...item, expiresAt: Date.now() + 5000 }
    // 保留最后一个 timer 引用，过期自动清空，避免重复 set 泄漏
    this.undoTimer = setTimeout(() => {
      this.activeUndo.value = null
      this.undoTimer = null
    }, 5000)
  }

  async performUndo(): Promise<void> {
    const db = this.db
    const undo = this.activeUndo.value
    if (!db || !undo) return
    try {
      await revertOperation(db, undo.operationId)
      if (this.undoTimer !== null) {
        clearTimeout(this.undoTimer)
        this.undoTimer = null
      }
      this.activeUndo.value = null
      await this.reload()
      if (this.syncManager) {
        void this.syncManager.sync().then(() => this.reload()).catch((e) => showFailToast(toErrorMessage(e)))
      }
    } catch (e) {
      showFailToast(toErrorMessage(e))
    }
  }

  /** 从历史面板撤回指定操作：成功后只提示结果，不弹 UndoSnackbar（同一目标不可重复撤回，
   *  撤销条会再次 revertOperation 被已撤回守卫抛 revert_target_invalid）。失败抛给调用方展示。 */
  async revertOrderOperation(operationId: string): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    await revertOperation(db, operationId)
    showSuccessToast('撤回已提交，待同步生效')
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload()).catch((e) => showFailToast(toErrorMessage(e)))
    }
  }

  // ---------- 工单写操作（真实业务命令） ----------

  async createWorkOrder(params: {
    customerId: number
    categoryName: string
    subcategoryName: string | null
    quantity: number
    unit: string
    unitPriceCents: number | null
    orderDate?: string
  }): Promise<string> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    const customer = this.customers.find((c) => c.customerId === params.customerId)
    if (!customer) throw new Error('customer_not_found')

    const opId = await createWorkOrderCommand(db, {
      workOrderDate: params.orderDate || localToday(),
      customerId: params.customerId,
      customerCode: customer.code,
      customerName: customer.displayName || customer.customerName,
      serviceCategory: params.categoryName,
      serviceItem: params.subcategoryName,
      quantity: params.quantity,
      unit: params.unit,
      unitPriceCents: params.unitPriceCents,
    })
    this.triggerUndo({
      undoId: newId('undo'),
      operationId: opId,
      message: `已保存 ${customer.displayName} ${params.quantity}${params.unit}`,
      actionType: 'create',
    })
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
    return opId
  }

  async updateWorkOrder(orderId: string, updates: Partial<WorkOrderUi>): Promise<string> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    const patch: Record<string, unknown> = {}
    if (updates.quantity !== undefined) patch.quantity = updates.quantity
    if (updates.unitPriceCents !== undefined) patch.unitPriceCents = updates.unitPriceCents
    if (updates.isCompleted !== undefined) patch.isCompleted = updates.isCompleted
    if (updates.orderDate !== undefined) patch.workOrderDate = updates.orderDate
    if (updates.customerId !== undefined) {
      const customer = this.customers.find((c) => c.customerId === updates.customerId)
      if (!customer) throw new Error('customer_not_found')
      patch.customerId = updates.customerId
      patch.customerCode = customer.code
      patch.customerName = customer.displayName || customer.customerName
    }
    if (updates.categoryName !== undefined) patch.serviceCategory = updates.categoryName
    if (updates.subcategoryName !== undefined) patch.serviceItem = updates.subcategoryName
    if (updates.unit !== undefined) patch.unit = updates.unit
    const opId = await updateWorkOrderCommand(db, orderId, patch as never)
    this.triggerUndo({
      undoId: newId('undo'),
      operationId: opId,
      message: '已保存修改',
      actionType: 'update',
    })
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
    return opId
  }

  async toggleComplete(orderId: string, isCompleted: boolean): Promise<void> {
    await this.updateWorkOrder(orderId, { isCompleted })
  }

  async deleteWorkOrder(orderId: string): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    const order = this.workOrders.find((o) => o.orderId === orderId)
    const operationId = await deleteWorkOrderCommand(db, orderId)
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
    this.triggerUndo({
      undoId: newId('undo'),
      operationId,
      message: `已删除 ${order?.customerDisplayName ?? ''} 工单`,
      actionType: 'delete',
    })
  }

  /** 批量定价：一条操作改多条工单；失败抛出由调用方展示。 */
  async batchPrice(
    targets: Array<{ syncId: string; quantity?: number; unitPriceCents?: number | null }>,
  ): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    await batchPriceWorkOrders(db, targets)
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
  }

  /** 解决冲突：合并操作重推后刷新本地视图并触发同步。 */
  async resolveConflict(queueId: number, resolution: ConflictResolution): Promise<void> {
    if (!this.syncManager) throw new Error('同步未初始化')
    await this.syncManager.resolveConflict(queueId, resolution)
    await this.reload()
    void this.syncManager.sync().then(() => this.reload())
  }

  /** 丢弃整条冲突：放弃本机修改、保留服务端版本，随后刷新并触发同步。 */
  async discardConflict(queueId: number): Promise<void> {
    if (!this.syncManager) throw new Error('同步未初始化')
    await this.syncManager.discardConflict(queueId)
    await this.reload()
    void this.syncManager.sync().then(() => this.reload())
  }

  // ---------- 客户 / 编号映射（真实业务命令） ----------

  async addCustomerWithMapping(input: {
    canonicalName: string
    customerCode: string
    customerName: string
    validFrom: string
    validTo?: string | null
  }): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    const built = await buildCustomerWithMapping(db, input)
    await new MutationService(db).commit({
      operationType: built.operationType,
      entitySyncIds: built.entitySyncIds,
      changes: built.changes,
      apply: built.apply,
      actorType: 'user',
    })
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
  }

  async addCustomer(canonicalName: string): Promise<{ customerSyncId: string; customerId: number }> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    const res = await createCustomerCommand(db, { canonicalName })
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
    return res
  }

  async updateCustomerName(customerSyncId: string, canonicalName: string): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    await updateCustomerCommand(db, customerSyncId, { canonicalName })
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
  }

  async archiveCustomer(customerSyncId: string): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    await archiveCustomerWithMappingsCommand(db, customerSyncId)
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
  }

  async addMapping(fields: {
    customerId: number
    customerCode: string
    customerName: string
    validFrom: string
    validTo?: string | null
  }): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    await addCustomerCodeMappingCommand(db, fields)
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
  }

  async updateMapping(
    syncId: string,
    patch: Partial<{
      customerId: number
      customerCode: string
      customerName: string
      validFrom: string
      validTo: string | null
    }>,
  ): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    await updateCustomerCodeMappingCommand(db, syncId, patch)
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
  }

  async deleteMapping(syncId: string): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    await deleteCustomerCodeMappingCommand(db, syncId)
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
  }

  // ---------- 服务品类（真实业务命令） ----------

  async addCategory(name: string): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    await createServiceCategory(db, { categoryName: name, subcategories: [] })
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
  }

  async updateCategory(
    syncId: string,
    patch: { categoryName?: string; subcategories?: Subcategory[]; isActive?: boolean; sortOrder?: number },
  ): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    await updateServiceCategory(db, syncId, patch)
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
  }

  async reorderCategories(orderedSyncIds: string[]): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    await reorderServiceCategories(db, orderedSyncIds)
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
  }

  async deleteCategory(syncId: string): Promise<void> {
    await this.updateCategory(syncId, { isActive: false })
  }

  // ---------- AI 聊天（真实 chatApi：会话 + SSE 流 + 确认握手） ----------

  initChat(api: ChatApi): void {
    this.chatApi = api
  }

  async loadChatHistory(): Promise<void> {
    const api = this.chatApi
    if (!api || !this.chatSessionId) return
    try {
      const page = await api.listTurns(this.chatSessionId)
      const messages: ChatMessage[] = []
      for (const turn of page.turns) {
        for (const m of turn.messages) {
          if (m.role === 'user' || m.role === 'assistant') {
            messages.push({
              id: `${turn.turnId}-${messages.length}`,
              sender: m.role,
              content: m.content,
              timestamp: turn.createdAt.slice(11, 16),
            })
          }
        }
      }
      if (messages.length > 0) {
        this.chatMessages.splice(0, this.chatMessages.length, ...messages)
      }
    } catch {
      // 历史加载失败不阻塞页面
    }
  }

  get currentChatSessionId(): string | null {
    return this.chatSessionId
  }

  async loadChatSessions(): Promise<void> {
    const api = this.chatApi
    if (!api) return
    try {
      const sessions = await api.listSessions()
      this.chatSessions.splice(0, this.chatSessions.length, ...sessions)
    } catch (e) {
      showFailToast(`历史会话加载失败：${(e as Error).message}`)
    }
  }

  async openChatSession(sessionId: string): Promise<void> {
    const api = this.chatApi
    if (!api || this.chatBusy.value || this.pendingApproval.value) return
    this.chatSessionId = sessionId
    this.isNewChat.value = false
    this.chatMessages.splice(0, this.chatMessages.length)
    try {
      const page = await api.listTurns(sessionId, { limit: 50 })
      const messages: ChatMessage[] = []
      let index = 0
      for (const turn of page.turns) {
        for (const m of turn.messages) {
          if (m.role === 'user' || m.role === 'assistant') {
            messages.push({
              id: `${turn.turnId}-${index}`,
              sender: m.role,
              content: m.content,
              timestamp: turn.createdAt.slice(11, 16),
            })
            index += 1
          }
        }
      }
      if (messages.length > 0) {
        const localMsgs = this.loadLocalChatMessages(sessionId)
        if (localMsgs && localMsgs.length > 0) {
          for (const lm of localMsgs) {
            if (lm.draftResult) {
              let target = messages.find(
                (m) =>
                  m.content === lm.content ||
                  (m.content &&
                    lm.content &&
                    (m.content.includes(lm.content) || lm.content.includes(m.content))),
              )
              if (!target) {
                target = [...messages].reverse().find((m) => m.sender === 'assistant')
              }
              if (target) {
                target.draftResult = lm.draftResult
              }
            }
          }
        }
        this.chatMessages.splice(0, this.chatMessages.length, ...messages)
      } else {
        this.chatMessages.push({ ...WELCOME_MESSAGE })
      }
    } catch (e) {
      this.chatMessages.push({ ...WELCOME_MESSAGE })
      showFailToast(`会话加载失败：${(e as Error).message}`)
    }
  }

  startNewChat(): void {
    this.chatSessionId = null
    this.isNewChat.value = true
    this.chatMessages.splice(0, this.chatMessages.length, { ...WELCOME_MESSAGE })
    this.pendingApproval.value = null
  }

  saveChatDraft(sessionId: string | null, text: string): void {
    if (sessionId !== null) this.chatDrafts.set(sessionId, text)
  }

  getChatDraft(sessionId: string | null): string {
    return sessionId !== null ? (this.chatDrafts.get(sessionId) ?? '') : ''
  }

  async sendAiMessage(text: string): Promise<void> {
    const api = this.chatApi
    if (!api || this.chatBusy.value || this.pendingApproval.value) return
    this.chatBusy.value = true
    const now = new Date()
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    this.chatMessages.push({ id: `m_${Date.now()}`, sender: 'user', content: text, timestamp: time })
    const assistantId = `m_resp_${Date.now()}`
    this.chatMessages.push({ id: assistantId, sender: 'assistant', content: '', timestamp: time })
    let approvalEvent: Extract<ChatSseEvent, { type: 'tool_confirm_request' }> | null = null
    const turnId = newId('turn')
    try {
      if (!this.chatSessionId) {
        const session = await api.createSession(text.slice(0, 20))
        this.chatSessionId = session.sessionId
        this.isNewChat.value = false
      }
      await api.streamTurn(
        this.chatSessionId,
        { turn_id: turnId, message: text },
        (event: ChatSseEvent) => {
          if (event.type === 'text_delta') {
            this.appendToMessage(assistantId, event.content)
          } else if (event.type === 'tool_confirm_request') {
            approvalEvent = event
          } else if (event.type === 'done') {
            const msg = this.chatMessages.find((m) => m.id === assistantId)
            if (msg && msg.content === '') {
              msg.content = event.error ? `出错：${event.error.error_code}` : '(无文本)'
            }
          }
        },
      )
      if (approvalEvent) await this.installAiApproval(turnId, approvalEvent)
    } catch (error) {
      this.setMessageContent(assistantId, `请求失败：${(error as Error).message}`)
    } finally {
      this.chatBusy.value = false
    }
  }

  setAiDraftDecision(
    toolCallId: string,
    action: AiDraftDecisionAction,
    reasonCode = '',
    note = '',
  ): void {
    const approval = this.pendingApproval.value
    if (!approval || !approval.decisions[toolCallId]) return
    approval.decisions = {
      ...approval.decisions,
      [toolCallId]: { action, reasonCode, note },
    }
    approval.resumeError = null
    this.pendingApproval.value = { ...approval }
    this.persistPendingAiApproval()
  }

  /** 提交逐条审核结果：批准项先组成一个本地原子操作，随后续接 AI 工具回合。 */
  async submitAiApproval(): Promise<void> {
    const approval = this.pendingApproval.value
    if (!approval) return
    const decisions = this.buildAiToolDecisions(approval)
    if (approval.localOperationId === null) {
      const approvedIds = new Set(
        decisions.filter((item) => item.decision === 'approve').map((item) => item.tool_call_id),
      )
      const approvedDrafts = approval.drafts.filter((draft) => approvedIds.has(draft.toolCallId))
      if (approvedDrafts.length > 0) {
        const db = this.db
        if (!db) throw new Error('业务库未打开')
        const input = buildAiBatchOperation(approval.turnId, approvedDrafts)
        approval.localOperationId = await new MutationService(db).commit(input)
        this.triggerUndo({
          undoId: newId('undo'),
          operationId: approval.localOperationId,
          message: `AI 工单已保存（${approvedDrafts.length} 张）`,
          actionType: 'update',
        })
        this.persistPendingAiApproval()
        if (this.syncManager) void this.syncManager.sync().then(() => this.reload())
      }
    }
    await this.resumeAiApproval(decisions)
  }

  /** 本地已经写入后续接失败：只重发工具决策，绝不再次写入工单。 */
  async retryAiApproval(): Promise<void> {
    const approval = this.pendingApproval.value
    if (!approval) return
    await this.resumeAiApproval(this.buildAiToolDecisions(approval))
  }

  private async resumeAiApproval(decisions: ToolDecision[]): Promise<void> {
    const api = this.chatApi
    const approval = this.pendingApproval.value
    if (!api || !approval || this.chatBusy.value) return
    this.chatBusy.value = true
    const assistantId = `m_appr_${Date.now()}`
    this.chatMessages.push({
      id: assistantId,
      sender: 'assistant',
      content: '',
      timestamp: new Date().toTimeString().slice(0, 5),
    })
    let nextApproval: Extract<ChatSseEvent, { type: 'tool_confirm_request' }> | null = null
    let doneError: string | null = null
    try {
      await api.approveTurn(
        approval.sessionId,
        approval.requestId,
        decisions,
        (event: ChatSseEvent) => {
          if (event.type === 'text_delta') {
            this.appendToMessage(assistantId, event.content)
          } else if (event.type === 'tool_confirm_request') {
            nextApproval = event
          } else if (event.type === 'done' && event.error) {
            doneError = event.error.error_code
          }
        },
      )
      if (nextApproval) {
        const summary = this.buildProcessedDraftSummary(approval)
        const msg = this.chatMessages.find((item) => item.id === assistantId)
        if (msg) msg.draftResult = summary
        if (approval.sessionId) this.saveLocalChatMessages(approval.sessionId)
        await this.installAiApproval(approval.turnId, nextApproval)
        return
      }
      if (doneError) throw new Error(doneError)
      const summary = this.buildProcessedDraftSummary(approval)
      const msg = this.chatMessages.find((item) => item.id === assistantId)
      if (msg) {
        msg.draftResult = summary
        if (msg.content === '') {
          msg.content = summary.approvedCount > 0 ? `已保存 ${summary.approvedCount} 张工单` : '审核结果已提交'
        }
      }
      if (approval.sessionId) this.saveLocalChatMessages(approval.sessionId)
      this.clearPendingAiApproval()
    } catch (error) {
      approval.resumeError = (error as Error).message
      this.persistPendingAiApproval()
      const saved = approval.localOperationId !== null
      this.setMessageContent(
        assistantId,
        saved
          ? `工单已经保存；AI 对话续接失败：${approval.resumeError}`
          : `审核结果提交失败：${approval.resumeError}`,
      )
    } finally {
      this.chatBusy.value = false
    }
  }

  private buildAiToolDecisions(approval: PendingAiApproval): ToolDecision[] {
    return approval.drafts.map((draft) => {
      const state = approval.decisions[draft.toolCallId]
      if (!state) throw new Error('ai_approval_decision_missing')
      if (state.action === 'approve') {
        return { tool_call_id: draft.toolCallId, decision: 'approve' as const }
      }
      const reason = [state.reasonCode, state.note.trim()].filter(Boolean).join('：')
      if (!reason) throw new Error('ai_approval_reason_required')
      if (state.action === 'regenerate' && !state.note.trim()) {
        throw new Error('ai_regenerate_note_required')
      }
      if (state.reasonCode === '其他' && !state.note.trim()) {
        throw new Error('ai_approval_other_note_required')
      }
      return { tool_call_id: draft.toolCallId, decision: state.action, reason }
    })
  }

  private buildProcessedDraftSummary(approval: PendingAiApproval): ProcessedDraftSummary {
    let approvedCount = 0
    let regeneratedCount = 0
    let rejectedCount = 0

    const items: ProcessedDraftItem[] = approval.drafts.map((draft) => {
      const state = approval.decisions[draft.toolCallId]
      const decision = state?.action ?? 'approve'
      if (decision === 'approve') approvedCount += 1
      else if (decision === 'regenerate') regeneratedCount += 1
      else if (decision === 'reject') rejectedCount += 1

      const decisionText =
        decision === 'approve' ? '已入库' : decision === 'regenerate' ? '已重生成' : '已拒绝'

      const merged = { ...(draft.before ?? {}), ...draft.fields }
      const customerCode = merged.customer_code ? String(merged.customer_code) : ''
      const customerName = merged.customer_name ? String(merged.customer_name) : ''
      const customerText =
        [customerCode, customerName].filter(Boolean).join(' · ') ||
        (draft.kind === 'create' ? '新建工单' : '修改工单')

      const category = merged.service_category ? String(merged.service_category) : ''
      const item = merged.service_item ? String(merged.service_item) : ''
      const serviceText = [category, item].filter(Boolean).join(' / ')

      const quantity =
        merged.quantity !== undefined && merged.quantity !== null ? String(merged.quantity) : ''
      const unit = merged.unit ? String(merged.unit) : '件'
      const quantityText = quantity ? `${quantity} ${unit}` : ''

      const priceCents = merged.unit_price_cents
      const priceText =
        typeof priceCents === 'number' ? `¥${(priceCents / 100).toFixed(2)}` : '待定价'

      const isCompleted = merged.is_completed === 1 || merged.is_completed === true
      const statusText = isCompleted ? '已完成' : '未完成'

      const reason =
        state && decision !== 'approve'
          ? [state.reasonCode, state.note.trim()].filter(Boolean).join('：')
          : undefined

      return {
        kind: draft.kind,
        customerText,
        serviceText,
        quantityText,
        priceText,
        statusText,
        decision,
        decisionText,
        reason,
      }
    })

    return {
      total: approval.drafts.length,
      approvedCount,
      regeneratedCount,
      rejectedCount,
      items,
    }
  }

  private chatMessagesStorageKey(sessionId: string): string | null {
    return this.db ? `cb_chat_msgs:${this.db.name}:${sessionId}` : null
  }

  private saveLocalChatMessages(sessionId: string): void {
    const key = this.chatMessagesStorageKey(sessionId)
    if (!key || typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(key, JSON.stringify(this.chatMessages))
    } catch {}
  }

  private loadLocalChatMessages(sessionId: string): ChatMessage[] | null {
    const key = this.chatMessagesStorageKey(sessionId)
    if (!key || typeof localStorage === 'undefined') return null
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as ChatMessage[]) : null
    } catch {
      return null
    }
  }

  private async installAiApproval(
    turnId: string,
    event: Extract<ChatSseEvent, { type: 'tool_confirm_request' }>,
  ): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    const calls: AiDraftCall[] = event.calls.map((call) => ({
      toolCallId: call.tool_call_id,
      toolName: call.tool_name,
      draft: call.draft,
    }))
    const drafts = await prepareAiDraftBatch(db, calls)
    const decisions = Object.fromEntries(
      drafts.map((draft) => [
        draft.toolCallId,
        { action: 'approve', reasonCode: '', note: '' } satisfies AiDraftDecisionState,
      ]),
    )
    if (!this.chatSessionId) throw new Error('聊天会话不存在')
    this.pendingApproval.value = {
      requestId: event.request_id,
      sessionId: this.chatSessionId,
      turnId,
      calls,
      drafts,
      decisions,
      localOperationId: null,
      resumeError: null,
    }
    this.persistPendingAiApproval()
  }

  private aiApprovalStorageKey(): string | null {
    return this.db ? `cb_ai_pending:${this.db.name}` : null
  }

  private persistPendingAiApproval(): void {
    const key = this.aiApprovalStorageKey()
    if (!key || typeof localStorage === 'undefined') return
    const value = this.pendingApproval.value
    if (value) localStorage.setItem(key, JSON.stringify(value))
    else localStorage.removeItem(key)
  }

  private async restorePendingAiApproval(): Promise<void> {
    const key = this.aiApprovalStorageKey()
    const db = this.db
    if (!key || !db || typeof localStorage === 'undefined') return
    const raw = localStorage.getItem(key)
    if (!raw) return
    try {
      const stored = JSON.parse(raw) as PendingAiApproval
      if (!stored.requestId || !stored.sessionId || !stored.turnId || !Array.isArray(stored.calls)) throw new Error('invalid')
      if (stored.localOperationId === null) {
        stored.drafts = await prepareAiDraftBatch(db, stored.calls)
      }
      this.pendingApproval.value = stored
      this.chatSessionId = stored.sessionId
      this.isNewChat.value = false
    } catch {
      localStorage.removeItem(key)
    }
  }

  private clearPendingAiApproval(): void {
    this.pendingApproval.value = null
    this.persistPendingAiApproval()
  }

  /** 追加消息内容：必须经 reactive 数组内的 proxy 修改，直接改局部原始对象不触发视图更新。 */
  private appendToMessage(id: string, delta: string): void {
    const msg = this.chatMessages.find((m) => m.id === id)
    if (msg) msg.content += delta
  }

  /** 覆盖消息内容：同上，经 proxy 触发更新。 */
  private setMessageContent(id: string, content: string): void {
    const msg = this.chatMessages.find((m) => m.id === id)
    if (msg) msg.content = content
  }

}

export const appState = new AppState()
