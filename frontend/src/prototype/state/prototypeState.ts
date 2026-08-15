import { computed, reactive, ref } from 'vue'
import {
  INITIAL_CATEGORIES,
  INITIAL_CUSTOMERS,
  INITIAL_WORK_ORDERS,
  type MockCategory,
  type MockCustomer,
  type MockWorkOrder,
} from '../mock/mockData'

export type TabKey = 'desk' | 'ledger' | 'chat' | 'settings'

export interface UndoItem {
  undoId: string
  message: string
  actionType: 'create' | 'update' | 'delete'
  previousSnapshot?: MockWorkOrder
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

class PrototypeState {
  // 顶层导航
  currentTab = ref<TabKey>('desk')

  // 基础数据
  customers = reactive<MockCustomer[]>([...INITIAL_CUSTOMERS])
  categories = reactive<MockCategory[]>([...INITIAL_CATEGORIES])
  workOrders = reactive<MockWorkOrder[]>([...INITIAL_WORK_ORDERS])

  // 查账本筛选条件
  ledgerFilters = reactive({
    datePreset: 'today' as 'today' | 'yesterday' | 'this_week' | 'this_month' | 'custom' | 'all',
    customStartDate: '2026-08-01',
    customEndDate: '2026-08-15',
    customerId: null as number | null,
    categoryName: null as string | null,
    searchKeyword: '',
  })

  // 即时撤回
  activeUndo = ref<UndoItem | null>(null)
  private undoTimer: number | null = null

  // AI 聊天
  chatMessages = reactive<ChatMessage[]>([
    {
      id: 'm1',
      sender: 'assistant',
      content: '你好！我是你的记账助手。你可以直接对我说：“帮我记张老板3000件单洗”，或者问我“今天一共洗了多少件？”',
      timestamp: '09:00',
    },
  ])

  // 查账本计算属性
  filteredOrders = computed(() => {
    return this.workOrders.filter((order) => {
      // 日期过滤
      if (this.ledgerFilters.datePreset === 'today' && order.orderDate !== '2026-08-15') {
        return false
      }
      if (this.ledgerFilters.datePreset === 'yesterday' && order.orderDate !== '2026-08-14') {
        return false
      }
      if (this.ledgerFilters.datePreset === 'this_week' && !order.orderDate.startsWith('2026-08-1')) {
        return false
      }
      if (this.ledgerFilters.datePreset === 'this_month' && !order.orderDate.startsWith('2026-08')) {
        return false
      }
      if (this.ledgerFilters.datePreset === 'custom') {
        if (this.ledgerFilters.customStartDate && order.orderDate < this.ledgerFilters.customStartDate) {
          return false
        }
        if (this.ledgerFilters.customEndDate && order.orderDate > this.ledgerFilters.customEndDate) {
          return false
        }
      }

      // 客户过滤
      if (this.ledgerFilters.customerId !== null && order.customerId !== this.ledgerFilters.customerId) {
        return false
      }

      // 品类过滤
      if (this.ledgerFilters.categoryName && order.categoryName !== this.ledgerFilters.categoryName) {
        return false
      }

      // 关键字搜索
      if (this.ledgerFilters.searchKeyword) {
        const kw = this.ledgerFilters.searchKeyword.trim().toLowerCase()
        const matchCode = order.customerCode.toLowerCase().includes(kw)
        const matchName = order.customerDisplayName.toLowerCase().includes(kw)
        const matchCat = order.categoryName.toLowerCase().includes(kw)
        const matchSub = order.subcategoryName.toLowerCase().includes(kw)
        if (!matchCode && !matchName && !matchCat && !matchSub) {
          return false
        }
      }

      return true
    })
  })

  // 统计汇总计算
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

  // 今日流水计算
  todayOrders = computed(() => {
    return this.workOrders.filter((o) => o.orderDate === '2026-08-15')
  })

  // 切换 Tab
  setTab(tab: TabKey) {
    this.currentTab.value = tab
  }

  // 触发 5 秒撤销条
  triggerUndo(item: Omit<UndoItem, 'expiresAt'>) {
    if (this.undoTimer) {
      clearTimeout(this.undoTimer)
    }
    this.activeUndo.value = {
      ...item,
      expiresAt: Date.now() + 5000,
    }
    this.undoTimer = window.setTimeout(() => {
      this.activeUndo.value = null
      this.undoTimer = null
    }, 5000)
  }

  // 执行撤销
  performUndo() {
    const undo = this.activeUndo.value
    if (!undo) return

    if (undo.actionType === 'create' && undo.createdOrderId) {
      const idx = this.workOrders.findIndex((o) => o.orderId === undo.createdOrderId)
      if (idx !== -1) {
        this.workOrders.splice(idx, 1)
      }
    } else if (undo.actionType === 'update' && undo.previousSnapshot) {
      const idx = this.workOrders.findIndex((o) => o.orderId === undo.previousSnapshot!.orderId)
      if (idx !== -1) {
        this.workOrders[idx] = { ...undo.previousSnapshot }
      }
    } else if (undo.actionType === 'delete' && undo.previousSnapshot) {
      this.workOrders.unshift({ ...undo.previousSnapshot })
    }

    if (this.undoTimer) {
      clearTimeout(this.undoTimer)
      this.undoTimer = null
    }
    this.activeUndo.value = null
  }

  // 创建工单
  createWorkOrder(params: {
    customerId: number
    categoryName: string
    subcategoryName: string
    quantity: number
    unit: string
    unitPriceCents: number | null
    orderDate?: string
  }) {
    const cust = this.customers.find((c) => c.customerId === params.customerId)
    if (!cust) return

    const now = new Date()
    const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
    const orderId = `wo_${Date.now()}`

    const newOrder: MockWorkOrder = {
      orderId,
      orderDate: params.orderDate || '2026-08-15',
      customerId: cust.customerId,
      customerCode: cust.code,
      customerDisplayName: cust.displayName,
      customerOfficialName: cust.customerName,
      categoryName: params.categoryName,
      subcategoryName: params.subcategoryName,
      quantity: params.quantity,
      unit: params.unit,
      unitPriceCents: params.unitPriceCents,
      syncStatus: 'pending',
      createdAt: timeStr,
      updatedAt: timeStr,
      history: [
        {
          operationId: `op_${Date.now()}`,
          timestamp: timeStr,
          summary: `创建工单：${params.quantity}${params.unit} / ${params.subcategoryName}`,
          device: '当前设备 (手机PWA)',
        },
      ],
    }

    this.workOrders.unshift(newOrder)

    // 触发 5 秒撤销
    this.triggerUndo({
      undoId: `undo_${Date.now()}`,
      message: `已保存 (${cust.displayName} ${params.quantity}${params.unit})`,
      actionType: 'create',
      createdOrderId: orderId,
    })

    // 模拟 1.5 秒后同步成功
    setTimeout(() => {
      const target = this.workOrders.find((o) => o.orderId === orderId)
      if (target && target.syncStatus === 'pending') {
        target.syncStatus = 'synced'
      }
    }, 1500)

    return newOrder
  }

  // 更新工单
  updateWorkOrder(orderId: string, updates: Partial<MockWorkOrder>) {
    const idx = this.workOrders.findIndex((o) => o.orderId === orderId)
    if (idx === -1) return

    const previousSnapshot = { ...this.workOrders[idx] }
    const current = this.workOrders[idx]

    const now = new Date()
    const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`
    const updated = {
      ...current,
      ...updates,
      updatedAt: '2026-08-15 ' + timeStr,
      history: [
        ...(current.history || []),
        {
          operationId: `op_${Date.now()}`,
          timestamp: '2026-08-15 ' + timeStr,
          summary: `修改工单内容`,
          device: '当前设备 (手机PWA)',
        },
      ],
    }

    this.workOrders[idx] = updated

    this.triggerUndo({
      undoId: `undo_${Date.now()}`,
      message: `已更新工单 (${current.customerDisplayName})`,
      actionType: 'update',
      previousSnapshot,
    })
  }

  // 删除工单
  deleteWorkOrder(orderId: string) {
    const idx = this.workOrders.findIndex((o) => o.orderId === orderId)
    if (idx === -1) return
    const previousSnapshot = { ...this.workOrders[idx] }
    this.workOrders.splice(idx, 1)

    this.triggerUndo({
      undoId: `undo_${Date.now()}`,
      message: `已删除工单 (${previousSnapshot.customerDisplayName})`,
      actionType: 'delete',
      previousSnapshot,
    })
  }

  // 模拟发送 AI 消息
  sendAiMessage(text: string) {
    const timeStr = `${new Date().getHours()}:${String(new Date().getMinutes()).padStart(2, '0')}`
    this.chatMessages.push({
      id: `m_${Date.now()}`,
      sender: 'user',
      content: text,
      timestamp: timeStr,
    })

    // 智能模拟响应
    setTimeout(() => {
      const lower = text.toLowerCase()
      if (text.includes('张老板') && (text.includes('单洗') || text.includes('件'))) {
        this.chatMessages.push({
          id: `m_resp_${Date.now()}`,
          sender: 'assistant',
          content: '已为您解析到工单草案，请核对并确认：',
          timestamp: timeStr,
          suggestedDraft: {
            action: 'create_order',
            data: {
              customerName: '张老板 (001)',
              category: '洗水',
              subcategory: '单洗',
              quantity: 3000,
              unit: '件',
              price: 1.5,
            },
          },
        })
      } else if (text.includes('汇总') || text.includes('统计') || text.includes('洗了多少')) {
        const sum = this.ledgerSummary.value
        this.chatMessages.push({
          id: `m_resp_${Date.now()}`,
          sender: 'assistant',
          content: `📊 今日汇总数据：\n• 总笔数：${sum.totalCount} 笔\n• 洗衣总量：${sum.totalPieces} 件\n• 预计金额：¥${sum.totalAmountYuan}${sum.unpricedCount > 0 ? ` (另有 ${sum.unpricedCount} 笔未定价)` : ''}`,
          timestamp: timeStr,
        })
      } else {
        this.chatMessages.push({
          id: `m_resp_${Date.now()}`,
          sender: 'assistant',
          content: `收到：“${text}”。您可以直接点击下方预设指令，或发送“帮我记张老板3000件单洗”来快速录入！`,
          timestamp: timeStr,
        })
      }
    }, 400)
  }
}

export const prototypeState = new PrototypeState()
