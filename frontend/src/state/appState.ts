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
  buildCustomerWithMapping,
  createWorkOrder as createWorkOrderCommand,
  createServiceCategory,
  updateServiceCategory,
  updateWorkOrder as updateWorkOrderCommand,
} from '../services/businessCommands'
import { MutationService } from '../services/mutation'
import { getRecordSyncStatus, getSyncCounts } from '../services/syncStatus'
import type { SyncManager } from '../services/syncManager'
import type { Subcategory } from '../db/schema/business/serviceCategories'
import { ChatApi, type ChatSession, type ChatSseEvent } from '../services/chatApi'
import { buildAiOperationFromDraft } from '../services/chatApproval'
import { newId } from '../utils/id'
import { showFailToast } from 'vant'

// appState：正式前端的全局视图状态。
// 数据来自真实 Dexie 业务库 + businessCommands / SyncManager / syncStatus，
// 组件只消费这里组装好的 UI 视图模型。

export type TabKey = 'desk' | 'ledger' | 'chat' | 'settings'

export interface UndoItem {
  undoId: string
  message: string
  actionType: 'create' | 'update' | 'delete'
  previousSnapshot?: WorkOrderUi
  createdOrderId?: string
  expiresAt: number
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

  // ---------- 撤销（真实撤回链路未接 UI，保留占位） ----------

  triggerUndo(_item: Omit<UndoItem, 'expiresAt'>) {
    // 真实撤回需要生成 reverts_operation_id 命令，UI 未接，暂不触发
  }

  performUndo() {
    // 占位
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
  }): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    const customer = this.customers.find((c) => c.customerId === params.customerId)
    if (!customer) throw new Error('customer_not_found')

    await createWorkOrderCommand(db, {
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
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
  }

  async updateWorkOrder(orderId: string, updates: Partial<WorkOrderUi>): Promise<void> {
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
    await updateWorkOrderCommand(db, orderId, patch as never)
    await this.reload()
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
  }

  async toggleComplete(orderId: string, isCompleted: boolean): Promise<void> {
    await this.updateWorkOrder(orderId, { isCompleted })
  }

  deleteWorkOrder(_orderId: string): void {
    // 软删是二期功能（docs/spec/business-p0p1.md §1.2），UI 已禁用入口
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
    const assistant: ChatMessage = {
      id: `m_resp_${Date.now()}`,
      sender: 'assistant',
      content: '',
      timestamp: time,
    }
    this.chatMessages.push(assistant)
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
            assistant.content += e.content
          } else if (e.type === 'tool_confirm_request') {
            this.pendingApproval.value = {
              requestId: e.request_id,
              toolName: e.tool_name,
              draft: e.draft,
              summary: this.draftSummary(e.tool_name, e.draft),
            }
          } else if (e.type === 'done') {
            if (assistant.content === '') assistant.content = e.error ? `出错：${e.error.error_code}` : '(无文本)'
          }
        },
      )
    } catch (e) {
      assistant.content = `请求失败：${(e as Error).message}`
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
    const assistant: ChatMessage = {
      id: `m_appr_${Date.now()}`,
      sender: 'assistant',
      content: '',
      timestamp: new Date().toTimeString().slice(0, 5),
    }
    this.chatMessages.push(assistant)
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
          if (e.type === 'text_delta') assistant.content += e.content
          else if (e.type === 'done') {
            if (assistant.content === '') assistant.content = e.error ? `出错：${e.error.error_code}` : approved ? '✅ 已确认写入' : '已拒绝'
          }
        },
      )
    } catch (e) {
      assistant.content = `确认处理失败：${(e as Error).message}`
    } finally {
      this.pendingApproval.value = null
      this.chatBusy.value = false
    }
  }

  private async commitAiDraft(toolName: string, draft: unknown): Promise<void> {
    const db = this.db
    if (!db) throw new Error('业务库未打开')
    const input = buildAiOperationFromDraft(this.chatSessionId ?? '', toolName, draft)
    if (!input) throw new Error('ai_draft_invalid')
    await new MutationService(db).commit(input)
    if (this.syncManager) {
      void this.syncManager.sync().then(() => this.reload())
    }
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

export const appState = new AppState()
