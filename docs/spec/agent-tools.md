---
status: current
as_of: 2026-08-17
---

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

- 后端直接写业务库（`docs/data-model.md` 已定边界）。
- 客户 / 映射 / 服务选项的写草案工具：一期 AI 只帮改工单，配置维护留给页面（工具注册表后续按同一模式加）。
- approve 后由 agent 汇报同步结果（当前回合在握手后收尾，不 resume 汇报，登记在 `docs/spec/chat-agent.md` §11）。

## 2. 核心原则

1. **后端工具永不落库**：写工具的执行业务只是校验回执（`draft_acknowledged`）；权威写入只经前端 outbox → Push。
2. **预校验材料即确认内容**：工具参数先经过封闭 schema 和后端只读业务校验；`tool_confirm_request.calls[].draft` 携带补齐客户快照后的最终材料，前端再按本地数据复验，展示与提交使用同一份规范化结果。
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
  → SSE: tool_confirm_request { request_id, calls[] }（最多 20 条）
  → 部分回合落库（messages_json = all_messages）
  → 前端全屏审核：逐条批准 / 拒绝 / 重新生成并填写原因
  → 批准项合并为一个原子操作，写本地 Dexie + outbox → Push
  → POST /chat/sessions/{sid}/turns { approval_request_id, decisions[] }
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

一期只做工单。两个工具都使用 `extra="forbid"` 的 Pydantic 封闭模型；未知字段以及账户、同步、版本、删除等元字段会在进入工具前被拒绝。

| 工具名 | 参数 | 模型可控字段 |
| --- | --- | --- |
| `create_work_order` | `fields` | 必填：`work_order_date`、`customer_id`、`service_category`、`service_item`、`quantity`、`unit`；可选：`unit_price_cents` |
| `update_work_order` | `entity_sync_id`、`base_version`、`fields` | `fields` 只允许上述业务字段与 `is_completed`，且至少显式提供一项 |

关键规则：

- create 不接收 `entity_sync_id`，由前端确认提交时生成。
- 模型只指定稳定身份 `customer_id`。后端按最终 `work_order_date` 查唯一有效编号映射，派生 `customer_code` / `customer_name` 后再发送确认事件。
- create 未显式提供 `is_completed` 时派生为 `0`；用户明确要求“已完成/未完成”时允许传 `0/1`。update 也只有用户明确要求时才携带该字段。
- update 未提价格或完成状态时，相应字段不进入 patch；明确传 `unit_price_cents: null` 才表示改为未定价。
- 工具确认后只返回 `draft_acknowledged`，永不写业务库。

写工具的 `args_validator` 在人工确认前执行只读预校验：客户和日期映射、服务选项、数值、修改目标、`base_version`。失败用 `ModelRetry` 返回模型修正，不把无效草案交给用户。正式 Push 仍执行权威复验。

### 4.4 注册表扩展

`tools/registry.py`：

```python
def register_tool(func=None, *, requires_approval=False, args_validator=None) -> Any
# 存储函数、确认元数据和确认前参数校验器
def build_tools(allowed=None) -> list[Tool[Any]]
# Tool(func, requires_approval=meta) 包装；保持白名单语义
def is_registered(tool_name) -> bool          # 供恢复待确认调用时判断工具性质
def requires_approval_for(tool_name) -> bool
```

新增 `tools/business_tools.py` 注册 §4.2/§4.3 的全部工具。`build_Agent` 改为：

```python
Agent(model, name=AGENT_NAME, instructions=render_Instructions(),
      deps_type=BusinessToolDeps,
      output_type=[str, DeferredToolRequests],   # 文本正常输出；写草案暂停时输出 DeferredToolRequests
      tools=build_tools(allowed_tools))
```

`render_Instructions()` 每次构建 Agent 时把动态上下文注入指令模板，MVP 注入当前日期（用户说“今天/本周”时按该日期推算，不再反问日期）；后续动态内容挂同一入口。

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

1. 完成会话归属、pending 与单飞锁检查。
2. Agent 产生 `DeferredToolRequests` 后，要求本批写调用数量为 `1..20`。
3. 每条调用再次通过 `BusinessQueryService.prepare_WorkOrderDraft` 做防御性预校验和快照派生。
4. 整批部分回合落库，并只发送一个 `tool_confirm_request`，其中 `calls[]` 包含全部待确认调用；不发送 `done`。
5. 无效草案不进入 `_PENDING`，流以 `done.error=draft_validation_failed` 结束。

### 5.3 approve 模式（approve_Turn）

确认请求按 `tool_call_id` 为本批每条调用提供一个决策：

- `approve`：转换为 `ToolApproved()`。
- `reject`：必须带非空 `reason`，转换为明确要求“不再生成”的 `ToolDenied(message)`。
- `regenerate`：必须带非空 `reason`，转换为明确要求按原因重做的 `ToolDenied(message)`。

决策必须完整覆盖当前批次，未知、重复、缺失调用或缺少原因均返回 `invalid_approval`。批准项的业务写入由前端合并成一个原子操作；后端工具仍只回执。

续跑结束后：

- 若模型正常收尾，整体覆盖回合、清 pending、发送 `done`。
- 若模型再次产生写草案，重新预校验并建立新的 pending，发送新的批量确认事件，不发送 `done`，绝不自动批准第二批。
- 模型调用失败保留当前 pending，前端可只重试 AI 续接，不重复本地业务写入。

### 5.4 进程重启后的恢复

内存 pending 丢失时，从已落库的部分回合恢复所有未回执写调用，重新执行同一预校验并生成新的批次 `request_id`。已存在 `ToolReturnPart` 的调用不会恢复。

### 5.5 路由（routers/chat.py）

approve 请求：

```json
{
  "approval_request_id": "ar-...",
  "decisions": [
    {"tool_call_id": "call-1", "decision": "approve"},
    {"tool_call_id": "call-2", "decision": "regenerate", "reason": "数量应为 12"},
    {"tool_call_id": "call-3", "decision": "reject", "reason": "重复工单"}
  ]
}
```

### 5.6 SSE 事件

```json
{
  "type": "tool_confirm_request",
  "request_id": "ar-...",
  "calls": [
    {
      "tool_call_id": "call-1",
      "tool_name": "create_work_order",
      "draft": {"fields": {"work_order_date": "2026-08-17", "customer_id": 1, "customer_code": "001", "customer_name": "甲", "is_completed": 0}}
    }
  ]
}
```

`draft` 是经过预校验和派生后的最终展示/提交材料；一批最多 20 条。`done` 只在回合真正结束时发送。

## 6. BusinessQueryService（`services/business_query.py`）

门面只做编排与防御（账户过滤、limit 收窄、日期字符串透传），具体 SQL 放仓库：

- `WorkOrdersRepository.query_Orders(account_phone, *, date_from=None, date_to=None, customer_code=None, customer_name=None, service_category=None, service_item=None, is_completed=None, unpriced_only=False, limit=50, offset=0)` → `(rows, total)`；`deleted_at IS NULL`；`work_order_date DESC, created_at DESC`。
- `WorkOrdersRepository.summarize_Orders(account_phone, 同过滤参数)` → dict；`SUM(quantity)`、`SUM(quantity*unit_price_cents)` 只对已定价、`COUNT(unit_price_cents IS NULL)`。
- `CustomersRepository.list_Customers(account_phone, *, keyword=None, include_archived=False, limit=50, offset=0)`。
- `CustomerCodeMappingsRepository.list_Mappings(account_phone, *, customer_code=None, on_date=None, limit=100, offset=0)`。
- `ServiceCategoriesRepository.list_Categories(account_phone, *, include_inactive=False)`。

参数校验在仓库层：`limit` 超界收窄到上限；`on_date`/`date_from` 等格式非法 → 返回空结果而非抛错（读工具容错）。`prepare_WorkOrderDraft` 只读校验工单草案，并按 `customer_id + work_order_date` 派生编号与名称快照。

## 7. 错误与安全

- 工具返回结构化 dict，不向模型抛业务异常；查询不到 → `items: []` / 计数字段为 0。
- `account_phone` 只来自 `BusinessToolDeps`（JWT 身份），工具参数里没有账户字段。
- 模型报出的 `base_version`/`sync_id` 以读工具返回值里的 `row_version`/`sync_id` 为准（指令约束）；前端确认时仍做本地即时校验，Push 时后端权威校验兜底，错版本走既有冲突管线。
- 聊天域错误码沿用 §4.3（`tool_approval_required` / `approval_not_found` / `invalid_approval` 从「预留」转为「真实触发」）。

## 8. 前端批量审核实现

前端实现位于：

- `services/chatApi.ts`：解析批量 `tool_confirm_request.calls[]`，提交逐工具 `decisions[]`。
- `services/chatApprovalBatch.ts`：最多 20 条；严格字段白名单；按 `customer_id + work_order_date` 复验客户快照；生成新建完整内容、修改前快照与实际差异；把批准项组装成一条原子 `MutationInput`。
- `services/chatApproval.ts`：单条兼容入口，同样复用批量严格校验，不保留旧的任意 `fields` 通道。
- `state/appState.ts`：保存审核状态与逐条决策；本地写入成功后单独续接 AI；续接失败只重试对话，不重复业务写入；页面刷新后恢复对应会话和审核材料。
- `components/chat/AiDraftReview.vue`：MD3 全屏审核页；默认逐条批准，可改为拒绝或重新生成；原因按条目保存；提交前显示批量汇总和二次确认。

批准项使用同一个 `operation_id`，任一 change 冲突或 rejected 时整批回滚。拒绝和重新生成通过 `ToolDenied(message)` 把原因返回模型；续跑再次产生写工具调用时建立新的 pending 批次，再次等待确认。

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
| `backend/src/backend/services/prompts.py` | 工具使用说明、「先查后改、必须确认」约束与纯文本说话方式约束 |
| `frontend/src/services/chatApi.ts` | 会话/回合/SSE 客户端 |
| `frontend/src/services/chatApprovalBatch.ts` | 批量草案复验、展示材料与原子 `MutationInput` |
| `frontend/src/services/chatApproval.ts` | 单条兼容入口，复用批量严格校验 |
| `frontend/src/state/appState.ts` | 审核状态、逐条决策、刷新恢复与续接重试 |
| `frontend/src/components/chat/AiChatView.vue` | 会话流与草案审核入口 |
| `frontend/src/components/chat/AiDraftReview.vue` | MD3 全屏批量审核页 |
| 测试 | `tests/services/test_business_query.py`、`tests/services/test_agent_tools.py`、扩展 `test_chat.py`、前端 `chatApi.test.ts` / `chatApproval.test.ts` |

## 10. 测试策略

- 读工具：真实 `tmp_path` SQLite 造数据 → 直接调工具函数（构造 `RunContext`）→ 断言返回结构与过滤/汇总正确。
- 写草案：注册表断言 `requires_approval` 元数据；用 `FunctionModel` 强制模型调写工具 → 断言 run 暂停、`run.result.output` 为 `DeferredToolRequests`、工具函数**未执行**；approve 续跑后工具执行且输出收尾文本（不落业务表）。
- ChatService：沿用 `agent_factory` 测试缝，注入 FakeAgent/FakeRun 分别模拟「文本直出」「写草案暂停」「approve 续跑」，断言事件序列、部分回合落库与覆盖、pending 清除、错误码（`approval_not_found` / `tool_approval_required` / `invalid_approval`）。
- 前端：`chatApi` 验证批量 SSE 与逐项 decisions；`chatApprovalBatch` 验证字段白名单、客户快照复验、修改差异、20 条上限和原子操作；`chatApproval` 验证单条兼容入口不能绕过严格校验。

## 11. 边界

- 写草案工具只覆盖工单；客户/映射/服务选项写工具后续按同一模式注册。
- 不做工具执行超时与并发工具调用的特殊处理（用 Pydantic AI 默认）。
- 不做真实模型的行为断言（`tests/live` 只冒烟链路，不保证模型一定按指令调工具）。
- approve 后同步结果不回传给 agent（登记在 `docs/spec/chat-agent.md` §11）。
