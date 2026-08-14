# 执行计划：一期业务功能 + Agent 工具接入

> 本计划是子代理驱动开发（SDD）的任务源。每个任务给出完整任务文本（brief）、验收标准与提交要求。
> 设计依据（implementer 必须先读，按需读）：
> - `docs/spec/business-p0p1.md`（一期业务功能实现设计）
> - `docs/spec/agent-tools.md`（Agent 工具与确认握手实现设计）
> - `docs/data-model.md`、`docs/sync-protocol.md`、`docs/error-codes.md`、`docs/spec/chat-agent.md`
> - `AGENTS.md`（项目约定、命名、测试、分层）
> - `backend/tests/README.md` 与现有测试文件（风格与 fixture）

## Global Constraints（对所有任务生效）

1. **分支**：所有提交落在当前分支 `feat/business-p0p1-agent-tools`，不允许切换到其他分支或动 main。
2. **文档纪律**：`docs/` 下任何新增/修改的文档不得提及外部笔记软件名或路径；只引用项目内文档。
3. **后端分层**：`data/` → `repositories/` → `deps.py` → `services/` → `routers/` → `main.py`；仓库层不 import FastAPI；依赖只能自上而下。
4. **后端命名**：类 PascalCase；方法“蛇形 + 名词大写”（如 `query_Orders`）；模块/文件 snake_case；变量允许缩写（`conn`）。
5. **测试纪律**：pytest + `tmp_path`（后端）、vitest + fake-indexeddb（前端）；只测公共接口；期望值来自设计文档/字面量，不复算实现逻辑；测试文件头说明“验证什么、为什么”；先写失败测试再实现（TDD 红绿循环）。
6. **精确值**：wire 格式 snake_case、前端 Dexie camelCase 一一对应；本计划与设计文档里的错误码、操作类型、字段名、默认值（limit 默认 50 封顶 100 等）必须原样使用，不得发明。
7. **类型门**：前端 typecheck 必须是 `npx vue-tsc -b`（或 `npm run build`），`--noEmit` 是假信号。
8. **验证命令**（提交前全部通过）：
   - 后端：`cd backend && .venv/bin/python -m pytest -q -m "not live"`
   - 前端：`cd frontend && npm run test && npm run build`
9. **提交粒度**：每任务 1–3 个语义化 commit（`feat(...)`/`fix(...)`/`test(...)`/`docs(...)`），commit message 说明改动。
10. **不越界**：只做任务规定内容；发现设计文档自相矛盾或必须改设计的点，先停下来报告，不自行发明。
11. **依赖顺序**：任务按编号顺序执行；后一个任务可以假定前一个任务已提交。
12. **pydantic-ai 工具坑**：所有工具函数与 validator 的 `RunContext[...]`、参数、返回值必须显式类型标注，否则 `requires_approval` 会失效（Pydantic AI 2.27.1 实测）。

---

## Task 1：后端业务校验缺口（G1–G4）

**范围**：只改 `backend/src/backend/` 以下文件与测试：

- `data/schema/business/04_work_orders.sql`：`service_item TEXT NOT NULL` → `service_item TEXT`。
- `repositories/work_orders.py`：`_validate_fields` 中 `service_item` 为 `None` 放行；非 `None` 且非 `str` → `invalid_service_item`。其余校验不变。
- `repositories/service_categories.py`：`subcategories_json`（JSON 字符串）逐项结构校验（`docs/spec/business-p0p1.md` §5.2）：解析失败/非数组 → `invalid_subcategories`；任一项不是合法对象（`name`、`default_unit` 均为非空字符串且 `is_active` 为 bool）→ `invalid_subcategories`；`name` 同数组内重复 → `subcategory_name_duplicate`。
- `services/business_command.py`：`_validate_cross` 改为「合并后校验」（§5.4）：
  - `base_version == 0`：校验 `change.fields`（同现状，但补小类 `is_active=false` → `service_option_disabled`）。
  - `base_version > 0`：读现记录，`merged = {**existing, **fields}`；仅当 patch 触及相关字段时校验：`service_category`/`service_item` → 大小类匹配 + 大类启用 + 小类启用；`work_order_date`/`customer_code` → 映射按合并后的日期与编号有效；`customer_id` → 客户存在且未归档。
  - 新增 `customer_code_mapping` 的 create/update 校验：`customer_id`（create 必查；update 仅当字段出现）→ `customer_not_found`；同账户同 `customer_code` 不同 `sync_id` 的重叠区间（含端点，`existing.valid_from <= new_valid_to AND (existing.valid_to IS NULL OR existing.valid_to >= new_valid_from)`）→ `mapping_period_overlap`。update 时 `valid_from`/`valid_to` 用合并后的值。
  - 工单 `service_item=null` 合法：仅当合并后 `service_item` 非空才做大小类校验。
- 错误码常量沿用现有业务码的内联字符串风格（与 `invalid_quantity` 等一致），**不改 `errors.py`**；只更新 `docs/error-codes.md` §4.2 工单表新增 `invalid_service_item`（“小类既不是字符串也不是空值”）。

**测试（新增，沿用 `tmp_path` 与现有 fixture）**：`backend/tests/repositories/test_business_repositories.py` 或新增 `test_business_validation.py` 覆盖：
1. 工单 create/update 时 `service_item=null` 通过；`service_item=123` rejected `invalid_service_item`。
2. 小类 JSON 三种坏结构 → `invalid_subcategories`；重名 → `subcategory_name_duplicate`；合法结构通过。
3. 映射 create 重叠 → rejected `mapping_period_overlap`；相邻不重叠（`valid_to == 次日 valid_from`？按含端点语义用 `2026-06-30` / `2026-07-01`）通过；update 只改 `valid_from` 造成重叠 → rejected。
4. 工单 update 改 `service_item` 为不属于大类的值 → `service_item_mismatch`；改到停用小类 → `service_option_disabled`；改 `work_order_date` 到无映射日期 → `customer_mapping_invalid`；update 只改 `quantity` 不触发跨表校验。
5. 映射 create 引用不存在客户 → `customer_not_found`。

**验收**：`cd backend && .venv/bin/python -m pytest -q -m "not live"` 全绿；新增测试数与上面 5 组对应；文件头注释说明验证什么、为什么。

---

## Task 2：后端查询服务与 Agent 工具（只读 + 写草案）

**范围**：

1. **仓库查询方法**（`docs/spec/agent-tools.md` §6，方法名照抄）：
   - `WorkOrdersRepository.query_Orders` / `summarize_Orders`
   - `CustomersRepository.list_Customers`
   - `CustomerCodeMappingsRepository.list_Mappings`
   - `ServiceCategoriesRepository.list_Categories`
   - 全部强制 `account_phone` 过滤；`query_Orders` 排除 `deleted_at IS NOT NULL`；`summarize_Orders` 的金额只算已定价、未定价单独计数；limit 防御性收窄。
2. **`services/business_query.py`**：`BusinessQueryService(work_orders, customers, mappings, categories)` 门面，方法名 `query_WorkOrders` / `summarize_WorkOrders` / `query_Customers` / `query_CustomerCodeMappings` / `query_ServiceCategories`；只编排，不写 SQL。
3. **`tools/registry.py`**：`register_tool(func=None, *, requires_approval=False)` 兼容旧的无参装饰器用法；存储 `(func, requires_approval)`；`build_tools(allowed=None) -> list[Tool]` 用 `Tool(func, requires_approval=...)`；新增 `get_registered_tool_names()`（保留）、`requires_approval_for(name) -> bool`、`is_registered(name) -> bool`。
4. **`tools/business_tools.py`**：注册 `docs/spec/agent-tools.md` §4.2 五个读工具与 §4.3 两个写草案工具。签名必须显式标注 `RunContext[BusinessToolDeps]`；写工具 `requires_approval=True`，函数体只回执不写库；写工具参数即草案形状（`entity_sync_id`/`base_version`/`fields`），不含 operation_id / actor_type / source_turn_id。
5. **`services/agent.py`**：`BusinessToolDeps` dataclass（`account_phone: str`、`query: BusinessQueryService | None`——测试 fake 可传 None，真实运行由 ChatService 注入）；`build_Agent(model_config=None, *, allowed_tools=None)`——新增 `allowed_tools` 可选参数透传给 `build_tools`（缺省全部工具），与 ChatService 未来调用 `agent_factory(allowed_tools)` 对齐；`Agent(..., deps_type=BusinessToolDeps, output_type=[str, DeferredToolRequests], tools=build_tools(allowed_tools))`。同时更新 `tests/services/test_agent.py`：`function_tools == []` 的旧断言改为「工具名集合 == 注册表 7 个工具名」；`TestModel` 跑通断言保留。
6. **`services/prompts.py`**：改写为工具可用版指令：说明可查账（五个读工具）、改数据必须先查、只能通过 `create_work_order`/`update_work_order` 提草案、必须等用户确认、不得声称已修改；金额单位为分。
7. **`deps.py`**：新增 `get_BusinessQueryService`（依赖四个仓库）。

**测试**：
- `tests/services/test_business_query.py`：造数据后经 `BusinessQueryService` 断言过滤、排序、汇总、软删排除、账户隔离。
- `tests/services/test_agent_tools.py`：
  - 注册表元数据：5 读工具 `requires_approval=False`、2 写工具 `True`；`build_tools(allowed)` 白名单。
  - 读工具直接调函数（构造 `RunContext` + 真实 query service）：返回结构字段名与设计文档一致。
  - 写草案暂停：`FunctionModel`（`stream_function` 第一轮 emit `DeltaToolCall` 调 `update_work_order`，第二轮 emit 文本）驱动 `build_Agent`（`model_config` 注入）→ `run_stream_events` 跑完后 `run.result.output` 是 `DeferredToolRequests`、`approvals` 恰一条、工具函数**未执行**（用可观测副作用断言）；approve 续跑（`message_history=all_messages()` + `build_results(approvals={id: True})`）后工具执行、最终输出为文本、业务表无任何写入。
  - 注意：所有工具/测试里 `RunContext` 显式标注（Global Constraint 12）。

**验收**：全部后端测试绿；`tools/business_tools.py` 里的工具名、参数名与 `docs/spec/agent-tools.md` §4 逐字一致。

---

## Task 3：ChatService 确认握手 + approve 端点

**范围**：

1. **`services/chat.py`** 按 `docs/spec/agent-tools.md` §5 重构：
   - 模块级 `_LOCKS` / `_PENDING` + `PendingApproval` / `PendingCall` dataclass + `reset_SharedState()`。
   - `ChatService.__init__` 新增 `business_query: BusinessQueryService | None = None` 与 `agent_factory` 调用签名改为 `agent_factory(allowed_tools=None)`；run 时 `deps=BusinessToolDeps(account_phone, business_query or 空实现?)`——设计：`business_query` 为 None 时用真实仓库不可行，因此 **测试注入的 agent_factory 必须接受 deps**；对测试 FakeAgent 用 `deps_type=object`。ChatService 不直接构造 query service；`deps` 值为 `BusinessToolDeps(account_phone, self._business_query)`，`_business_query` 允许 None（真实运行由 deps.py 注入，测试 fake agent 的 deps_type 兼容任意值）。
   - `run_Turn(account_phone, session_id, turn_id, message, allowed_tools=None)`：按 §5.2 顺序；写草案暂停时部分落库 + `tool_confirm_request` 事件 + 不产 done；`tool_call.args` 为 str 时 `json.loads` 成 dict。
   - `approve_Turn(account_phone, approval_request_id, approved)`：按 §5.3；内存 pending 缺失时调 `recover_PendingApprovals`（§5.4，从 `chat_turns.messages_json` 恢复，工具名经 `registry.requires_approval_for` 判定；request_id 重新生成并随 `tool_confirm_request` 事件先行发出）。
   - 保留 send 正常路径的 `text_delta` → `done` 与异常映射（`done.error`）。
2. **`routers/chat.py`**：`TurnRequest` 单模型双模式（§5.5）；send 模式缺字段 → `invalid_request` 400；approve 模式缺 `approved` → `invalid_approval` 400；`allowed_tools` 透传；approve 前用 pending.session_id 做归属校验。`_flatten_messages` 对含工具消息的回合继续只摊平文本段（不崩）。
3. **`deps.py`**：`get_ChatService` 注入 `business_query: BusinessQueryService = Depends(get_BusinessQueryService)`。
4. **`main.py`** 无改动。

**测试**：
- 扩展 `tests/services/test_chat.py`（沿用 FakeAgent/FakeRun 缝）：
  1. 写草案暂停：事件序列 `... → tool_confirm_request(draft=参数)`、无 done、`chat_turns` 有部分落库、`_PENDING` 有值。
  2. `approve_Turn` true：加载部分回合 → 续跑 → `text_delta` + `done(error=None)`、最终回合覆盖、pending 清除、工具（fake）执行且业务表无写入。
  3. `approve_Turn` false：同样收尾，fake 工具不被执行。
  4. 未知/过期 `approval_request_id` → `approval_not_found`；pending 存在时新 send → `tool_approval_required`；缺 `approved` 走 router 层测试或 service 层 `invalid_approval`。
  5. `reset_SharedState()` 在每个测试 fixture 调（新增 autouse fixture 或显式），避免进程级状态串测试。
- 扩展 `tests/chat/test_chat_endpoints.py`：POST /turns send 模式仍 SSE；approve 模式请求体 → 至少覆盖 `invalid_approval` 400 与 `approval_not_found` 404（用 FakeAgent 注入的 app/依赖覆盖方式沿用现有 conftest）。
- 恢复路径单测：构造部分回合 messages_json（含无回执的 `update_work_order` 调用）→ `recover_PendingApprovals` 还原，approve 可用。

**验收**：全后端测试绿；`docs/spec/chat-agent.md` 不动（T7 再同步文档）；现有 164 测试除因共享状态需 fixture 调整外语义不回退。

---

## Task 4：前端数据层（schema / Repository / 业务命令 / 同步修复）

**范围**：只改 `frontend/src` 数据与逻辑层，不做任何页面（页面在 T5/T6）。

1. **schema**：
   - `db/schema/business/workOrders.ts`：`serviceItem: string | null`。
   - `db/schema/business/customers.ts`：补 `customerId: number`。
   - `db/schema/operations/outbox.ts`：`OutboxCommand` 的 changes 数组元素补可选 `entityType?: string`（保留 `OutboxCommandChange` 现有字段）。
2. **Repository 查询**（`docs/spec/business-p0p1.md` §5.8.1，签名照抄）：
   - `workOrders.ts`：`query(filters?)`、`summarize(filters?)`；过滤条件用 `filter`（Dexie `.filter` + 排序用内存 sort 或 orderBy；数据量小，允许全表 `toArray` 后过滤排序，但索引主键不变）；排除 `deletedAt !== null`；`unpricedOnly` 与 `serviceItem: null` 的语义分开。
   - `customers.ts`：`list(includeArchived)`、`getByCustomerId`。
   - `customerCodeMappings.ts`：`list(filters?)`、`findValid(customerCode, date)`。
   - `serviceCategories.ts`：`list(includeInactive)`、`findByCategoryName`。
3. **`services/businessCommands.ts`**（新，§5.8.2）：
   - `BusinessRuleError`、字段类型、`validateWorkOrderInput`、`validateCustomerInput`、`validateMappingInput`、`validateServiceCategoryInput`（返回 void，抛 `BusinessRuleError(errorCode)`；错误码与 `docs/error-codes.md` 一致）。
   - `buildCreateWorkOrderChange` / `createWorkOrder`、`buildCustomerWithMapping`（生成 `syncId`、负 `customerId = -parseInt(syncId.slice(5), 16)`、映射快照、即时重叠检查）、`archiveCustomerWithMappings`、`addCustomerCodeMapping`、`updateCustomerCodeMapping`、`createServiceCategory`、`updateServiceCategory`；另导出 `applyWorkOrderPatch(tx: MutationTx, change)` 纯辅助函数（create：直接 put 新记录 `rowVersion=1`；update：读现记录 → `{...existing, ...patch, updatedAt}` put），供 T6 的 AI 草案复用。每条命令通过 `MutationService.commit` 提交：`changes` 逐条带 `entityType`（跨实体操作必带）、`baseVersion`、`baseSnapshot`、`patch`；`apply` 在 Dexie 事务内按顺序 put 本地记录（新记录 `rowVersion=1`，更新时间 ISO）。
   - **同时改 `services/mutation.ts`**：`MutationChange` 接口补可选 `entityType?: string`；`commit` 写 outbox.command 时原样保留 `entityType`（不丢字段）。这是 T6 AI 草案与跨实体命令共用的前提。
   - `subcategoriesJson` 前端为数组类型；push wire 需 JSON 字符串：`apply` 写 Dexie 时存数组，`patch`/`fields` 中放 `JSON.stringify` 后的字符串（后端 TEXT 列契约）。实现一个内部转换函数并加注释。
4. **`services/syncStatus.ts`**（新，§5.8.3）：`getRecordSyncStatus(db, syncId)`、`getSyncCounts(db)`。
5. **`services/errorMessages.ts`**（新）：`docs/error-codes.md` §5 要求的中文文案映射，覆盖 §4.2/§4.3 全部错误码；未命中返回 `message` 兜底函数 `toErrorMessage(err)`。
6. **`services/syncManager.ts`** 两处修复（§5.6/§5.7）：
   - `toPushOperation`：每条 change 用 `c.entityType ?? entityTypeFor(operationType)`；`create_customer_with_mapping`/`archive_customer_with_mappings` 若无逐条 entityType 抛 `unknown_operation_type`。为可测试性，把 outbox→PushOperation 的映射抽成模块级导出函数 `buildPushOperation(entry: OutboxEntry): PushOperation`，SyncManager 私有方法改为调用它（公共契约，可单测且不破坏封装）。
   - `applyPushResults` accepted 分支：同一事务把 `result.row_versions` 按 `syncId` 回写四张业务表对应记录的 `rowVersion`；事务表列表补四业务表；再删 outbox、operations 标 synced。
   - 不改变冲突/rejected 分支语义。
7. **`repositories/*` 与现有测试**：因 `serviceItem` 变可空、`Customer` 增字段，修正现有测试里构造的数据（保持 77 个测试全绿或等效更新）。

**测试（新增/更新，vitest + fake-indexeddb）**：
- 每个 Repository 的 query/list/summarize：过滤、排序、软删排除、金额（整数分）与未定价计数。
- `businessCommands`：即时校验错误码；`buildCustomerWithMapping` 的负 customerId 唯一性、两条 change 的 entityType 与顺序；`createServiceCategory` 的 `subcategoriesJson` 字符串化；`commit` 后业务表/operations/outbox 三者一致。
- `syncStatus`：pending/conflict/rejected/synced 四种推导。
- `syncManager`：`toPushOperation` 逐 change entityType（可直接测私有？——公共契约改为导出 `toPushOperation` 为模块级纯函数 `buildPushOperation(entry)`，SyncManager 内部调用，这样可公共测试且不破坏私有封装）；accepted 回写 rowVersion 用 `SyncManager.sync()` + mock SyncApi 断言。

**验收**：`cd frontend && npm run test && npm run build` 全绿；无页面改动（App.vue 仍只渲染 LoginView）。

---

## Task 5：前端 P0/P1 业务页面

**范围**：新增页面与组件（文件结构照 `docs/spec/business-p0p1.md` §6.3），使用 Vant 4 现有依赖，不引入 vue-router。

1. **全局样式 `style.css`**：黑白灰 design tokens（§6.3 视觉规范：`--color-bg-app:#F9FAFB`、`--color-surface:#FFFFFF`、`--color-border:#E5E7EB`、`--color-text-main:#111827`、`--color-text-sub:#4B5563`、`--color-text-muted:#9CA3AF`、`--color-accent:#2563EB`、状态色 success/warning/danger；`tabular-nums`；触控 ≥48px）。
2. **`App.vue` 壳**：`store.state.status === 'signed_in'` → 渲染 `AppShell`；否则 `LoginView`。`AppShell`（新组件）持有 `activeTab` 状态与四个 view；登录成功后打开业务库、创建 `SyncManager`（`HttpSyncApi` + `createBusinessDb(phone)`）并 `init()`；提交后/前台恢复（`visibilitychange` visible）/网络恢复（`online`）触发 `sync()`；提供 `syncManager`、`db`、`apiClient` 给子页面（provide/inject 或 props，二选一并在文件头注释说明）。
3. **组件**：
   - `components/navigation/AppTabBar.vue`：四 tab，当前页高亮，显示冲突/待同步红点（用 `getSyncCounts` 响应式轮询或事件回调，实现为每 2s 轻量刷新 + 同步状态回调）。
   - `components/common/StatusBadge.vue`：`saved`/`synced`/`conflict`/`rejected` 四种徽标与中文文案（已保存/已同步/冲突/被拒绝）。
4. **`views/WorkOrderDesk.vue`**：日期默认今天；映射按日期加载（`findValid` 列表）；客户快捷行（最近录入的映射/工单去重后前 8 个）；大类选择 → 小类药丸（含停用小类不展示）→ 自动带单位（可改）；数量正整数；单价可空（分为单位输入，展示 `¥` 换算）；提交 → `createWorkOrder` → 清数量/单价、保留客户与大类上下文 → 今日流水（`query({dateFrom: 今天, dateTo: 今天})`）立即刷新，每张卡带 `StatusBadge`。
5. **`views/LedgerView.vue`**：日期大胶囊（今天/昨天/本周/本月/自选区间，区间用 Vant Picker/Field 简化）；客户速选（最近 8 个）+ 品类/完成状态过滤；`summarize` 汇总条 `共 N 笔 · M 件 · 合计 ¥X.XX`，未定价显示 `N 笔未定价`；列表 `WorkOrderCard`（编号、客户、大类-小类、数量×单位、金额或“未定价”、日期、`StatusBadge`）；点击卡片只做只读详情弹层（编辑为二期，明确不实现）。
6. **`views/SettingsView.vue` + 三个子管理组件**：
   - `CustomerMappingMgr.vue`：客户列表（含归档标记）；「新建客户」一步建齐表单（正式名+编号+显示名+生效日，`buildCustomerWithMapping`）；加/改编号（即时重叠校验，错误用 `toErrorMessage`）；归档（确认后 `archiveCustomerWithMappings`）。
   - `ServiceCategoryMgr.vue`：大类列表 + 小类编辑（增/改名/改默认单位/停用启用），`createServiceCategory`/`updateServiceCategory`；结构校验即时反馈。
   - `SyncStatusPanel.vue`：`getSyncCounts` 计数、`syncState.lastSyncAt` 展示、手动同步按钮、冲突/被拒条目列表（只读，处理入口为二期）。
   - 「账户与登出」组：显示当前手机号，登出按钮调 `authStore.logout()`。
7. **反馈**：所有提交错误用 `showFailToast(toErrorMessage(err))`；成功用轻量 toast 或直接列表刷新。

**验收**：`npm run build` 零错误；`npm run test` 现有测试全绿（本任务无新组件单测）；`App.vue` 从 LoginView 单向切换逻辑正确；浏览器手测路径（由最终评审用 `npm run dev` 冒烟）可录单、可查、可维护配置、状态徽标随同步变化。

---

## Task 6：前端 AI 对话页 + chatApi + 确认接口桩

**范围**：

1. **`services/chatApi.ts`**（§8）：`ChatApi(apiClient)`；`createSession/listSessions/listTurns`；`streamTurn(sid, payload, onEvent, signal?)` 用 `fetch + ReadableStream` 解析 SSE（`data: ` 帧按 `\n\n` 分割；非 2xx 先 `toAppError` 语义抛 `AppErrorLike`；start 时 401 → `refreshNow()` 重试一次）；`approveTurn`。
2. **`services/chatApproval.ts`**（§8）：`ChatApprovalUi` 接口、`notConnectedApprovalUi`（`requestApproval` 返回 `Promise.resolve(false)` 且调用方据此**不提交草案**、不发 approve）、`buildAiOperationFromDraft(turnId, draft)`：校验 draft 形状（`operation_type ∈ {create_work_order, update_work_order}`、changes 数组单条、entity_type=work_order、fields 存在），补齐 `operationId = newId('op')`、`actorType='ai'`、`sourceTurnId=turnId`；`entity_sync_id` 为 null 时生成 `sync-<12hex>` 并 `baseVersion=0`；update 必须携带数字 `base_version`；返回 `MutationInput`，形状与 `services/businessCommands.ts` 的 commit 输入一致；不合法返回 null。
3. **`views/AiChatView.vue`**：会话列表（左/侧或顶部分区，Vant Cell/Field 创建会话）；消息流（user/assistant 气泡，assistant 渲染纯文本 + 换行，markdown 渲染本期不做）；输入框 + 快捷指令胶囊（`今日记账汇总`、`本月未定价有几单`、`查某客户本周工单`）；发送 → `ChatApi.streamTurn`：`text_delta` 增量追加到当前气泡；`tool_confirm_request` → 消息流占位文本（“AI 想执行 `tool_name`，参数：…；确认 UI 未接入”）并调 `ui.requestApproval(draft)`（默认 `notConnectedApprovalUi`，返回 false 则忽略，不提交不 approve——页面通过 prop 注入 `ChatApprovalUi`，默认 notConnected）；`done.error` 展示错误；`done` 后刷新回合列表。
4. **AppShell 接线**：构造 `ChatApi(apiClient)` 并注入 `AiChatView`；`ChatApprovalUi` 通过 `AppShell` prop 提供（默认 `notConnectedApprovalUi`），保证“UI 留接口不做”落地。

**测试**：
- `chatApi.test.ts`：mock global fetch 断言 JSON 端点路径/方法与 SSE 帧解析（多个 `data:` 帧、跨 chunk 拆分）；401 → refresh 重试一次。
- `chatApproval.test.ts`：`buildAiOperationFromDraft` 对 create/update/缺字段/错误 operation_type 的四种行为；`notConnectedApprovalUi.requestApproval` 恒 false。
- 现有 77+ 前端测试全绿。

**验收**：`npm run test && npm run build` 全绿；SSE 事件类型与 `docs/spec/agent-tools.md` §5.6 一致。

---

## Task 7：文档同步 + 全量验证

**范围**：

1. `docs/data-model.md`：
   - §4.5 `service_item` 改可空并注明「空大类先建、小类后补」；
   - §4.3 补「离线新建客户的 `customer_id` 由客户端按 `sync_id` 派生为负整数，跨设备唯一，后端接受为权威值」；
   - §6.3 outbox command 的 change 形状补可选 `entity_type`（跨实体原子操作逐 change 标注）；
   - §5.4/§6.1 补「Push accepted 后 row_versions 回写本地 rowVersion」一句话。
2. `docs/api.md`：chat `POST /chat/sessions/{sid}/turns` 补充 approve 模式请求体与错误（`invalid_approval` 400、`approval_not_found` 404、`tool_approval_required` 409）；`docs/error-codes.md` 已由 Task 1 更新，复查一致性。
3. `docs/spec/chat-agent.md`：§1/§2/§9/§10/§11 更新为「工具与确认握手已实现」的事实状态（保留原 MVP 历史描述要点，不整篇重写）；把「读工具/写工具为后续」改为指向 `docs/spec/agent-tools.md`；§6.2 补一句“运行时来源字段由前端确认时补齐”与实现现状。
4. `AGENTS.md`：
   - 「未定事项」删除/改写：`approve 模式 / 工具确认握手未实现（工具注册表为空）` → 改为已实现状态并保留已知近似（如 session_busy 流后抛出的近似是否仍成立，按 T3 实现实际情况改写）；「前端业务页面与交互界面未定」 → 更新为已按 `docs/spec/business-p0p1.md` 落地、确认 UI 仍留接口。
   - 「当前协作状态」末尾补一条：一期业务功能 + Agent 工具已实现（日期、测试数、主要文件）。
   - 不改动任何 Obsidian 相关描述的外部路径句法；不要新增 Obsidian 提及。
5. **全量验证**：后端 `pytest -m "not live"`、前端 `npm run test && npm run build`；如 Task 1 改了 SQL schema，`backend/data/` 下旧开发库若存在且测试未受影响则忽略（不入库）；检查 `git status` 无意外产物（`__pycache__`、`dist/` 等）后提交文档与必要清理。
6. **提交**：`docs(...)` 1–2 个 commit。

**验收**：三套命令全绿；`git status --short` 只剩有意文件（`demo/` 与旧 `docs/spec/frontend-ui.md` 保持未跟踪不动）；文档与实现一致（可逐条 grep 验证 `service_item`、`mapping_period_overlap`、`invalid_service_item`、`entity_type`、`tool_confirm_request`）。

---

## Final Review

全部任务完成后，以 `git merge-base main HEAD`..HEAD 的完整 diff 派最终评审（评审输入：本计划 Global Constraints + 两份设计文档 + diff 包 + 全部任务 ledger）。最终评审结论 clean 或非阻塞 minor 后，任务完成，由控制器向用户汇报。
