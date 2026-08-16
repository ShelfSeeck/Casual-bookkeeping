import { computed, reactive, ref } from 'vue'
import type { CbDatabase } from '../db/schema'
import {
  type ServiceCategoryUi,
  type CustomerUi,
  type WorkOrderUi,
} from '../types/ui'
import { CustomersRepository } from '../repositories/customers'
import { CustomerCodeMappingsRepository } from '../repositories/customerCodeMappings'
import { ServiceCategoriesRepository } from '../repositories/serviceCategories'
import { WorkOrdersRepository } from '../repositories/workOrders'
import {
  batchPriceWorkOrders,
  buildCustomerWithMapping,
  createWorkOrder as createWorkOrderCommand,
  createServiceCategory,
  deleteWorkOrder as deleteWorkOrderCommand,
  revertOperation,
  updateServiceCategory,
  updateWorkOrder as updateWorkOrderCommand,
} from '../services/businessCommands'
import { MutationService } from '../services/mutation'
import { getRecordSyncStatus, getSyncCounts } from '../services/syncStatus'
import {
  WIRE_META_FIELDS,
  analyzeConflict,
  stripWireMetaFields,
  type ConflictAnalysis,
  type ConflictResolution,
} from '../services/conflictResolver'
import type { SyncManager } from '../services/syncManager'
import type { Subcategory } from '../db/schema/business/serviceCategories'
import { ChatApi, type ChatSession, type ChatSseEvent } from '../services/chatApi'
import { buildAiOperationFromDraft } from '../services/chatApproval'
import { newId } from '../utils/id'
import { toErrorMessage } from '../services/errorMessages'
import { showFailToast, showSuccessToast } from 'vant'

// appState：正式前端的全局视图状态。
// 数据来自真实 Dexie 业务库 + businessCommands / SyncManager / syncStatus，
// 组件只消费这里组装好的 UI 视图模型。

export type TabKey = 'desk' | 'ledger' | 'chat' | 'settings'

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
export interface HistoryItem {
  operationId: string
  summary: string
  timestamp: string
  device: string | null
  actorType: 'user' | 'ai' | 'system'
  operationType: string
  canRevert: boolean
}

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

export interface ChatMessage {
  id: string
  sender: 'user' | 'assistant'
  content: string
  timestamp: string
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

export interface PendingAiApproval {
  requestId: string
  toolName: string
  draft: unknown
  summary: string
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
  categories = reactive<ServiceCategoryUi[]>([])
  workOrders = reactive<WorkOrderUi[]>([])

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
  }

  async reload(): Promise<void> {
    const db = this.db
    if (!db) return
    const [customers, mappings, categories, orders] = await Promise.all([
      new CustomersRepository(db).list(),
      new CustomerCodeMappingsRepository(db).list(),
      new ServiceCategoriesRepository(db).list(),
      new WorkOrdersRepository(db).query(),
    ])

    const uiCustomers: CustomerUi[] = []
    for (const m of mappings) {
      const c = customers.find((x) => x.customerId === m.customerId)
      uiCustomers.push({
        customerId: m.customerId,
        syncId: m.syncId,
        customerName: c?.canonicalName ?? m.customerName,
        code: m.customerCode,
        displayName: m.customerName,
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
          isActive: c.isActive,
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
        history: [],
      })
    }
    this.workOrders.splice(0, this.workOrders.length, ...uiOrders)
    await this.refreshConflicts()
  }

  /**
   * 加载指定工单的历史操作（docs/data-model.md §5.2 operations 镜像）。
   * changesJson 新形状 {entitySyncIds, changes}；旧形状只有 serverSeq 时兼容跳过。
   * 结果写回 reactive workOrders 数组内对应 order 的 history。
   */
  async loadOrderHistory(orderId: string): Promise<void> {
    const db = this.db
    if (!db) return
    const rows = await db.operations.toArray()
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

      let summary = operationSummary(op.operationType)
      const fieldNames = changedFieldNames(parsed.changes).slice(0, 4)
      if (fieldNames.length > 0) {
        summary = `${summary}（${fieldNames.join(', ')}）`
      }
      const canRevert =
        op.operationType !== 'revert_operation' &&
        op.revertsOperationId === null &&
        !rows.some((other) => other.revertsOperationId === op.operationId)
      items.push({
        operationId: op.operationId,
        summary,
        timestamp: op.createdAt,
        device: op.deviceId,
        actorType: op.actorType,
        operationType: op.operationType,
        canRevert,
      })
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
    patch: { categoryName?: string; subcategories?: Subcategory[]; isActive?: boolean },
  ): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    await updateServiceCategory(db, syncId, patch)
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
    // 经 reactive 数组内的 proxy 更新内容；直接改局部原始对象不触发视图更新（Vue3 响应式陷阱）
    const assistantId = `m_resp_${Date.now()}`
    this.chatMessages.push({
      id: assistantId,
      sender: 'assistant',
      content: '',
      timestamp: time,
    })
    try {
      if (!this.chatSessionId) {
        const session = await api.createSession(text.slice(0, 20))
        this.chatSessionId = session.sessionId
        this.isNewChat.value = false
      }
      await api.streamTurn(
        this.chatSessionId,
        { turn_id: newId('turn'), message: text },
        (e: ChatSseEvent) => {
          if (e.type === 'text_delta') {
            this.appendToMessage(assistantId, e.content)
          } else if (e.type === 'tool_confirm_request') {
            this.pendingApproval.value = {
              requestId: e.request_id,
              toolName: e.tool_name,
              draft: e.draft,
              summary: this.draftSummary(e.tool_name, e.draft),
            }
          } else if (e.type === 'done') {
            const msg = this.chatMessages.find((m) => m.id === assistantId)
            if (msg && msg.content === '') {
              msg.content = e.error ? `出错：${e.error.error_code}` : '(无文本)'
            }
          }
        },
      )
    } catch (e) {
      this.setMessageContent(assistantId, `请求失败：${(e as Error).message}`)
    } finally {
      this.chatBusy.value = false
    }
  }

  /** 用户确认/拒绝 AI 草案后继续流；确认时先本地落盘（走 MutationService → outbox → 同步）。 */
  async resolveAiApproval(approved: boolean): Promise<void> {
    const api = this.chatApi
    const approval = this.pendingApproval.value
    if (!api || !approval || !this.chatSessionId) return
    this.chatBusy.value = true
    const assistantId = `m_appr_${Date.now()}`
    this.chatMessages.push({
      id: assistantId,
      sender: 'assistant',
      content: '',
      timestamp: new Date().toTimeString().slice(0, 5),
    })
    try {
      if (approved) {
        // draft 来自 Vue ref（reactive proxy），写 IndexedDB 前先转成 plain object
        const plainDraft = JSON.parse(JSON.stringify(approval.draft))
        await this.commitAiDraft(approval.toolName, plainDraft)
      }
      this.pendingApproval.value = null
      await api.approveTurn(
        this.chatSessionId,
        approval.requestId,
        approved,
        (e: ChatSseEvent) => {
          if (e.type === 'text_delta') {
            this.appendToMessage(assistantId, e.content)
          } else if (e.type === 'done') {
            const msg = this.chatMessages.find((m) => m.id === assistantId)
            if (msg && msg.content === '') {
              msg.content = e.error ? `出错：${e.error.error_code}` : approved ? '✅ 已确认写入' : '已拒绝'
            }
          }
        },
      )
    } catch (e) {
      this.setMessageContent(assistantId, `确认处理失败：${(e as Error).message}`)
    } finally {
      this.pendingApproval.value = null
      this.chatBusy.value = false
    }
  }

  private async commitAiDraft(toolName: string, draft: unknown): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    const input = await buildAiOperationFromDraft(db, this.chatSessionId ?? '', toolName, draft)
    if (!input) throw new Error('ai_draft_invalid')
    const opId = await new MutationService(db).commit(input)
    this.triggerUndo({
      undoId: newId('undo'),
      operationId: opId,
      message: 'AI 修改已保存',
      actionType: 'update',
    })
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
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

  private draftSummary(toolName: string, draft: unknown): string {
    if (typeof draft !== 'object' || draft === null) return 'AI 生成了一条业务修改草案'
    const d = draft as { fields?: Record<string, unknown> }
    const f = d.fields ?? {}
    if (toolName === 'create_work_order') {
      return `新建工单：${f.customer_name ?? f.customer_code ?? ''} ${f.service_item ?? ''} ${f.quantity ?? ''}${f.unit ?? ''}`
    }
    return `修改工单：${Object.keys(f).join(', ')}`
  }
}

function operationSummary(operationType: string): string {
  const map: Record<string, string> = {
    create_work_order: '新建工单',
    update_work_order: '修改工单',
    batch_price_work_orders: '批量定价',
    revert_operation: '撤回操作',
  }
  return map[operationType] ?? operationType
}

/** 从 Pull changes 里提取 changedFieldsJson 的字段名（snake_case 原样）。 */
function changedFieldNames(changes: unknown): string[] {
  if (!Array.isArray(changes)) return []
  const names: string[] = []
  for (const change of changes) {
    if (typeof change !== 'object' || change === null) continue
    const raw = (change as Record<string, unknown>).changedFieldsJson
    if (raw === null || raw === undefined) continue
    const parsed = normalizeFieldNames(raw)
    for (const name of parsed) {
      const meta = WIRE_META_FIELDS as readonly string[]
      if (!meta.includes(name) && !names.includes(name)) names.push(name)
    }
  }
  return names
}

function normalizeFieldNames(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string')
  }
  if (typeof raw === 'string') {
    try {
      return normalizeFieldNames(JSON.parse(raw))
    } catch {
      return []
    }
  }
  if (typeof raw === 'object' && raw !== null) {
    return Object.keys(raw as Record<string, unknown>)
  }
  return []
}

export const appState = new AppState()
