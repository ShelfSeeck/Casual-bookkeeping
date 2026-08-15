# Agent 业务工具与确认握手实现设计

> 面向开发的实现设计。范围：把一期业务功能接入 Pydantic AI Agent——只读查询工具直接执行，写操作以「草案 + 用户确认」形式生成，后端工具永不写库。
> 相关文档：`docs/spec/chat-agent.md`（对话编排契约）、`docs/data-model.md` §6.3（AI 操作草案）、`docs/spec/business-p0p1.md`（业务功能）、`docs/error-codes.md` §4.3。

## 1. 目的与范围

### 1.1 解决什么问题

`docs/spec/chat-agent.md` 的 MVP 把工具注册表留空，AI 助手只能空谈。本设计把「查账」与「帮改单」接入 Agent：

1. **只读工具**：查询工单 / 汇总 / 客户 / 编号映射 / 服务选项，数据来自后端权威 SQLite（不是前端 Dexie）。
2. **写草案工具**：模型生成与用户操作同构的受控业务命令草案；工具带 `requires_approval`，运行在 SSE 中暂停并发出 `tool_confirm_request`，等待前端确认。
3. **确认握手**：前端确认后把草案写进本地 Dexie（businessCommands 管线）→ Push；后端 approve 让握手工具执行（只回执、不写库），agent 收尾本回合。

### 1.2 明确不做

- 前端确认 UI：只提供接口与类型（§8），不实现可视化确认组件。
- 后端直接写业务库（`docs/data-model.md` 已定边界）。
- 客户 / 映射 / 服务选项的写草案工具：一期 AI 只帮改工单，配置维护留给页面（工具注册表后续按同一模式加）。
- approve 后由 agent 汇报同步结果（当前回合在握手后收尾，不 resume 汇报，登记在 `docs/spec/chat-agent.md` §11）。

## 2. 核心原则

1. **后端工具永不落库**：写工具的执行业务只是校验回执（`draft_acknowledged`）；权威写入只经前端 outbox → Push。
2. **工具参数即草案**：`tool_confirm_request.draft` 原样携带工具参数；前端展示与提交的是同一份数据（`docs/spec/chat-agent.md` §6.2）。
3. **运行时来源字段不进工具 schema**：`operation_id`、`actor_type=ai`、`source_turn_id` 由前端确认时补齐（工具参数不含它们，避免模型编 ID）。
4. **读工具只读**：所有读工具只调 `BusinessQueryService`，签名不含任何写入口。
5. **白名单过滤**：`allowed_tools` 继续生效（读工具与写草案工具都受控）。
6. **确认暂停时保存部分回合**：以 `turn_id` 落部分 `messages_json`，approve 时加载续跑；成功完成后整体覆盖（`docs/spec/chat-agent.md` §3.3）。

## 3. 最小模型

```text
用户发消息
  → ChatService 构建 Agent（读工具 + 写草案工具，deps=BusinessToolDeps）
  → 模型可能调读工具：立即执行，结果回模型，继续输出文本
  → 模型调写草案工具：run 暂停，run.result.output = DeferredToolRequests
  → SSE: tool_confirm_request { request_id, tool_call_id, tool_name, draft }
  → 部分回合落库（messages_json = all_messages）
  → 前端确认（UI 接口）→ 本地 Dexie 写业务 + outbox（operationId 新生成）→ Push
  → POST /chat/sessions/{sid}/turns { approval_request_id, approved }
  → ChatService 加载部分回合 + DeferredToolResults → 续跑
  → 握手工具执行（只回执）→ 模型收尾文本 → done + 回合覆盖落库
```

## 4. 工具契约

### 4.1 依赖对象

```python
@dataclass(frozen=True)
class BusinessToolDeps:
    account_phone: str          # 当前账户（从 JWT 注入，工具不得信任模型参数）
    query: BusinessQueryService # 只读查询门面
```

`build_Agent` 用 `deps_type=BusinessToolDeps`；ChatService 每次 run 时传 `deps=BusinessToolDeps(account_phone, query_service)`。

### 4.2 只读工具

统一约定：所有工具为 async 函数，首参 `ctx: RunContext[BusinessToolDeps]`，返回 `dict`；`limit` 默认 50、封顶 100（防止模型要无限数据）；日期一律 `YYYY-MM-DD`；只返回未软删的工单与未归档客户（`include_archived` 除外）。

| 工具名 | 参数 | 返回 |
| --- | --- | --- |
| `query_work_orders` | `date_from?`, `date_to?`, `customer_code?`, `customer_name?`, `service_category?`, `service_item?`, `is_completed?`, `unpriced_only?`, `limit?` | `{ "items": [工单快照...], "total": n }`；工单快照含 `sync_id`、`work_order_date`、客户三项快照、服务两项、`quantity`、`unit`、`unit_price_cents`、`is_completed`、`row_version` |
| `summarize_work_orders` | 同 `query_work_orders` 的过滤参数（无 limit） | `{ "work_order_count", "total_quantity", "priced_count", "priced_amount_cents", "unpriced_count" }`；金额只算已定价，`NULL` 单价为未定价 |
| `query_customers` | `keyword?`, `include_archived?`, `limit?` | `{ "items": [{customer_id, sync_id, canonical_name, archived_at}], "total" }` |
| `query_customer_code_mappings` | `customer_code?`, `on_date?`, `limit?` | `{ "items": [{mapping_id, sync_id, customer_id, customer_code, customer_name, valid_from, valid_to}], "total" }` |
| `query_service_categories` | `include_inactive?` | `{ "items": [{sync_id, category_name, subcategories:[{name,default_unit,is_active}], is_active}] }` |

实现要点：工具函数只做参数收窄 + 调 `BusinessQueryService` 同名方法；SQL 过滤在 §6.1 的仓库查询方法里完成。

### 4.3 写草案工具

一期只做工单（配置类写工具后续按同一模式注册）。工具参数形状与 `docs/data-model.md` §6.3 草案一致，**不含** `operation_id / actor_type / source_turn_id`：

| 工具名 | 参数 | 说明 |
| --- | --- | --- |
| `create_work_order` | `entity_sync_id: str \| None`, `fields: dict` | `entity_sync_id` 可空（前端确认时生成 `sync-<12hex>`）；`fields` 为工单业务字段（`work_order_date`, `customer_id`, `customer_code`, `customer_name`, `service_category`, `service_item\|null`, `quantity`, `unit`, `unit_price_cents\|null`）。模型先用读工具拿到映射快照再填 |
| `update_work_order` | `entity_sync_id: str`, `base_version: int`, `fields: dict` | `base_version` 来自读工具返回的 `row_version`；`fields` 只含要改的字段 |

两工具注册时 `requires_approval=True`。工具函数（确认后才会执行）只做回执：

```python
return {"status": "draft_acknowledged",
        "operation_type": "create_work_order",  # 或 update_work_order
        "changes": [{"entity_type": "work_order",
                     "entity_sync_id": entity_sync_id,
                     "base_version": 0,           # update 工具取参数值
                     "fields": fields}]}
```

模型系统指令（`prompts.py`）必须明确：修改数据前必须先查询、只能通过这两个工具提草案、等用户确认，不得声称已修改。

### 4.4 注册表扩展

`tools/registry.py`：

```python
def register_tool(func=None, *, requires_approval: bool = False) -> Any
# 装饰器用法不变（@register_tool）；存储 {name: (func, requires_approval)}
def build_tools(allowed=None) -> list[Tool[Any]]
# Tool(func, requires_approval=meta) 包装；保持白名单语义
def is_registered(tool_name) -> bool          # 供恢复待确认调用时判断工具性质
def requires_approval_for(tool_name) -> bool
```

新增 `tools/business_tools.py` 注册 §4.2/§4.3 的全部工具。`build_Agent` 改为：

```python
Agent(model, name=AGENT_NAME, instructions=INSTRUCTIONS,
      deps_type=BusinessToolDeps,
      output_type=[str, DeferredToolRequests],   # 文本正常输出；写草案暂停时输出 DeferredToolRequests
      tools=build_tools(allowed_tools))
```

> 版本注意（Pydantic AI 2.27.1 实测）：工具函数与 `RunContext` 必须显式类型标注，否则 `requires_approval` 不会暂停而会直接执行工具。所有工具实现按 §4 签名写全注解。

## 5. ChatService 确认握手状态机

### 5.1 共享状态

单飞锁与待确认请求必须在**跨请求进程级共享**（FastAPI 每请求新建 `ChatService`，实例字段锁不住并发）。实现为模块级字典 + 显式测试复位口：

```python
_LOCKS: dict[str, asyncio.Lock] = {}        # 按 account_phone
_PENDING: dict[str, PendingApproval] = {}   # 每账户至多一个未处理确认

@dataclass
class PendingApproval:
    request_id: str          # ar-<uuid4().hex[:12]>
    account_phone: str
    session_id: str
    turn_id: str
    requests: DeferredToolRequests
    calls: list[PendingCall] # [{request_id, tool_call_id, tool_name, args(dict)}]

def reset_SharedState() -> None   # 测试缝；清空两字典
```

### 5.2 send 模式（run_Turn）

```
1. 会话归属校验（同现状）
2. 该账户存在 _PENDING → AppError(tool_approval_required, 409)（先于锁检查，语义准确）
3. 获取/检查账户锁（同现状；锁冲突 session_busy）
4. agent = factory(allowed_tools)；run_stream_events(message, deps=...)
5. 流内：只转发 PartDeltaEvent+TextPartDelta → text_delta（同现状）
6. 流结束后看 run.result.output：
   a. isinstance(output, DeferredToolRequests) 且 approvals 非空：
      - 生成 request_id 与 PendingCall 列表（args 为 str 时 json.loads 转 dict）
      - 写入 _PENDING[account_phone]
      - upsert_Turn(turn_id, session_id, dump_json(run.result.all_messages()))  ← 部分回合
      - 逐条 yield tool_confirm_request 事件（draft = args dict 原样）
      - 不 yield done（回合暂停）
   b. 否则：upsert_Turn(... new_messages_json()) + done（同现状）
7. 异常映射同现状；锁 finally 释放
```

### 5.3 approve 模式（approve_Turn）

```
1. pending = _PENDING.get(account_phone)
   - None → AppError(approval_not_found, 404)
   - pending.request_id != approval_request_id → AppError(tool_approval_required, 409)
2. 账户锁：占用 → session_busy（409）
3. 从 chat_turns 读 pending.turn_id 的 messages_json；不存在 → turn_not_found
   ModelMessagesTypeAdapter.validate_json 还原消息列表
4. DeferredToolResults = pending.requests.build_results(
       approvals={pending 每个 tool_call_id: approved})
   approved=True → 握手工具执行（只回执）；False → ToolDenied 回传模型
5. agent.run_stream_events(None, message_history=messages, deferred_tool_results=results, deps=...)
6. 流内转发 text_delta；结束后 upsert_Turn(最终 new_messages_json) + done
7. 成功后清除 _PENDING[account_phone]；模型异常时保留 pending（允许前端重发 approve）；锁 finally 释放
```

### 5.4 进程重启后的恢复

部分回合已落库（步骤 6a）。approve 时若内存 pending 丢失但回合存在且「最后响应里有未回执的 requires_approval 工具调用」，从消息历史重建 `DeferredToolRequests`：

```python
recover_PendingApprovals(messages: list[ModelMessage]) -> DeferredToolRequests | None
# 遍历：记录每个 tool_call_id 的 ToolCallPart 与 ToolReturnPart 回执集合
# 取「无回执」的 ToolCallPart，且工具名在注册表 requires_approval → approvals
# 有结果则配合回合记录重建 pending（request_id 重新生成，返回新 request_id 由事件带给前端）
```

实现为 `services/chat.py` 内部函数，供 `approve_Turn` 在内存 pending 缺失时使用。

### 5.5 路由（routers/chat.py）

`POST /chat/sessions/{sid}/turns` 一个模型、两种模式：

```python
class TurnRequest(BaseModel):
    turn_id: str | None = None
    message: str | None = None
    allowed_tools: list[str] | None = None
    approval_request_id: str | None = None
    approved: bool | None = None
```

- `approval_request_id is not None` → approve 模式：`approved is None` → `AppError(invalid_approval, 400)`；调 `service.approve_Turn(account_phone, approval_request_id, approved)`。
- 否则 send 模式：`turn_id`/`message` 缺任一 → `AppError(invalid_request, 400)`；调 `run_Turn(..., allowed_tools=body.allowed_tools)`。
- 流开始前做会话归属校验（approve 模式用 pending.session_id 做同样校验，避免绕过）。

### 5.6 SSE 事件

`tool_confirm_request` 帧：

```json
{"type":"tool_confirm_request","request_id":"ar-...","tool_call_id":"pyd_ai_...","tool_name":"update_work_order","draft":{"entity_sync_id":"sync-...","base_version":4,"fields":{"quantity":12}}}
```

其余帧沿用 `docs/spec/chat-agent.md` §5；`done` 只在回合真正结束时发。

## 6. BusinessQueryService（`services/business_query.py`）

门面只做编排与防御（账户过滤、limit 收窄、日期字符串透传），具体 SQL 放仓库：

- `WorkOrdersRepository.query_Orders(account_phone, *, date_from=None, date_to=None, customer_code=None, customer_name=None, service_category=None, service_item=None, is_completed=None, unpriced_only=False, limit=50, offset=0)` → `(rows, total)`；`deleted_at IS NULL`；`work_order_date DESC, created_at DESC`。
- `WorkOrdersRepository.summarize_Orders(account_phone, 同过滤参数)` → dict；`SUM(quantity)`、`SUM(quantity*unit_price_cents)` 只对已定价、`COUNT(unit_price_cents IS NULL)`。
- `CustomersRepository.list_Customers(account_phone, *, keyword=None, include_archived=False, limit=50, offset=0)`。
- `CustomerCodeMappingsRepository.list_Mappings(account_phone, *, customer_code=None, on_date=None, limit=100, offset=0)`。
- `ServiceCategoriesRepository.list_Categories(account_phone, *, include_inactive=False)`。

参数校验在仓库层：`limit` 超界收窄到上限；`on_date`/`date_from` 等格式非法 → 返回空结果而非抛错（读工具容错）。

## 7. 错误与安全

- 工具返回结构化 dict，不向模型抛业务异常；查询不到 → `items: []` / 计数字段为 0。
- `account_phone` 只来自 `BusinessToolDeps`（JWT 身份），工具参数里没有账户字段。
- 模型报出的 `base_version`/`sync_id` 以读工具返回值里的 `row_version`/`sync_id` 为准（指令约束）；前端确认时仍做本地即时校验，Push 时后端权威校验兜底，错版本走既有冲突管线。
- 聊天域错误码沿用 §4.3（`tool_approval_required` / `approval_not_found` / `invalid_approval` 从「预留」转为「真实触发」）。

## 8. 前端接口（确认 UI 留接口，不实现界面）

新增 `frontend/src/services/chatApi.ts` 与 `frontend/src/services/chatApproval.ts`：

```ts
// chatApi：会话/回合/SSE 契约（docs/spec/chat-agent.md §4/§5）
export interface ChatSseEvent = { type:'text_delta'; content:string }
  | { type:'tool_confirm_request'; request_id:string; tool_call_id:string; tool_name:string; draft: unknown }
  | { type:'done'; turn_id:string; error:{error_code:string;message:string}|null }

export class ChatApi {
  createSession(title): Promise<ChatSession>
  listSessions(): Promise<ChatSession[]>
  listTurns(sid, afterTurnId?, limit?): Promise<{turns; nextCursor}>
  streamTurn(sid, payload: {turn_id?; message?; allowed_tools?; approval_request_id?; approved?},
             onEvent: (e: ChatSseEvent)=>void, signal?: AbortSignal): Promise<void>
  // approve 模式同样是 SSE（chat-agent.md §4.4 两种模式响应均为 text/event-stream）：
  approveTurn(sid, approvalRequestId, approved, onEvent, signal?): Promise<void>
}
// SSE 用 fetch + ReadableStream（POST 不支持 EventSource）；start 阶段 401 → refreshNow 后重试一次

// chatApproval：确认 UI 的接口契约（本期无实现组件）
export interface ChatApprovalUi {
  /** 收到写草案时调用；resolve true 才继续 approve+本地提交。默认实现始终 false。 */
  requestApproval(draft: unknown): Promise<boolean>
}
export const notConnectedApprovalUi: ChatApprovalUi
export function buildAiOperationFromDraft(
  turnId: string, toolName: string, draft: unknown
): MutationInput | null
// draft 即 tool_confirm_request.draft（工具原始参数，§5.6）：
//   create_work_order → {entity_sync_id: string|null, fields}
//   update_work_order → {entity_sync_id: string, base_version: number, fields}
// 适配器按 toolName 推导 operation_type/entity_type；填充 actorType='ai'、sourceTurnId=turnId；
// create 的 entity_sync_id 为 null 时生成 sync-<12hex>；update 要求 base_version 为正整数。
// MutationInput 本身不含 operationId —— 由 MutationService.commit 生成（docs/data-model.md §6.1）。
// 返回可直接喂给 MutationService.commit 的输入；形状不合法返回 null。
```

后续页面收到 `tool_confirm_request` 时：存在注入的 `ChatApprovalUi` → 调 `requestApproval(draft)`；确认后先 `buildAiOperationFromDraft(turnId, tool_name, draft)` + `MutationService.commit` + `SyncManager.sync()`，再 `approveTurn(sid, request_id, true, onEvent)`；拒绝则 `approveTurn(..., false, onEvent)`。**本期** `ChatApprovalUi` 使用 `notConnectedApprovalUi`（始终 false），没有确认 UI 就没有任何写操作。

## 9. 最终文件清单

| 文件 | 内容 |
| --- | --- |
| `backend/src/backend/services/business_query.py` | `BusinessQueryService` |
| `backend/src/backend/tools/business_tools.py` | 7 个工具（5 读 + 2 写草案） |
| `backend/src/backend/tools/registry.py` | `register_tool(requires_approval=)`、查询辅助、白名单过滤 |
| `backend/src/backend/services/agent.py` | `deps_type` / `output_type` / 工具接线 |
| `backend/src/backend/services/chat.py` | 共享锁/pending、send 暂停、approve 续跑、恢复函数 |
| `backend/src/backend/routers/chat.py` | approve 模式分支、allowed_tools 透传 |
| `backend/src/backend/deps.py` | `get_BusinessQueryService`；ChatService 注入 query service |
| `backend/src/backend/services/prompts.py` | 工具使用说明与「先查后改、必须确认」约束 |
| `frontend/src/services/chatApi.ts` | 会话/回合/SSE 客户端 |
| `frontend/src/services/chatApproval.ts` | 确认 UI 接口 + 草案转 MutationInput |
| `frontend/src/views/AiChatView.vue` | 会话流页面（确认 UI 仅接口） |
| 测试 | `tests/services/test_business_query.py`、`tests/services/test_agent_tools.py`、扩展 `test_chat.py`、前端 `chatApi.test.ts` / `chatApproval.test.ts` |

## 10. 测试策略

- 读工具：真实 `tmp_path` SQLite 造数据 → 直接调工具函数（构造 `RunContext`）→ 断言返回结构与过滤/汇总正确。
- 写草案：注册表断言 `requires_approval` 元数据；用 `FunctionModel` 强制模型调写工具 → 断言 run 暂停、`run.result.output` 为 `DeferredToolRequests`、工具函数**未执行**；approve 续跑后工具执行且输出收尾文本（不落业务表）。
- ChatService：沿用 `agent_factory` 测试缝，注入 FakeAgent/FakeRun 分别模拟「文本直出」「写草案暂停」「approve 续跑」，断言事件序列、部分回合落库与覆盖、pending 清除、错误码（`approval_not_found` / `tool_approval_required` / `invalid_approval`）。
- 前端：`chatApi` 用 mock fetch 验证 SSE 解析与 401 重试；`chatApproval` 验证草案形状校验、ID 补齐与 `notConnectedApprovalUi` 的拒绝行为。

## 11. 边界

- 写草案工具只覆盖工单；客户/映射/服务选项写工具后续按同一模式注册。
- 不做工具执行超时与并发工具调用的特殊处理（用 Pydantic AI 默认）。
- 不做真实模型的行为断言（`tests/live` 只冒烟链路，不保证模型一定按指令调工具）。
- approve 后同步结果不回传给 agent（登记在 `docs/spec/chat-agent.md` §11）。
