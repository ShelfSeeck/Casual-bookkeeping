---
status: archived
as_of: 2026-08-16
reason: 二期交互已实现并通过验收；仅作历史存档，不再作为执行依据
---

# 执行计划：二期业务交互（软删 / 撤回 / 冲突 / 批量定价）

> 子代理驱动开发（SDD）任务源。每个任务给出完整 brief、验收与提交要求。
> 设计依据（implementer 先读，按需读）：
> - `docs/data-model.md`（§5.2 operations 镜像、§6.3 命令、§6.4 冲突、§6.5 撤回）
> - `docs/sync-protocol.md`（§7 冲突、§10 本地历史）
> - `docs/spec/business-p0p1.md`（一期边界：编辑/软删/完成标记/批量定价/撤回 UI/冲突 UI 属二期）
> - `docs/error-codes.md`（错误码唯一登记处）
> - `AGENTS.md`（项目约定、命名、测试、分层）
> - `backend/tests/README.md` 与现有测试文件（风格与 fixture）

## 背景

一期已完成：后端业务校验、同步三端点、前端数据层与 MD3 页面（工单台/查账本/AI/设置）。一期 spec 明确把以下交互列为二期：工单编辑、软删、完成标记切换、批量定价、历史记录与撤回 UI、冲突三方对比 UI。当前分支上「工单编辑、完成标记切换」已实现，软删入口被禁用占位，历史轨迹 UI 有壳但数据恒为空，撤回/冲突解决无 UI，批量定价无实现。

用户已确认的交互决策（2026-08-16）：

1. 批量定价 = 查账本筛选结果进入多选模式，勾选工单后统一设价（数量/单价二选一或都可填）。
2. 冲突解决中心：不做不同字段的自动合并；给操作者足够信息回顾当时记录场景（完整 Base/Ours/Theirs 三方对比 + 原操作上下文）；允许暂存不解决、先去查账本核实；所有差异字段由用户逐项显式决策后才可重推。
3. 其余交互沿用已落地的 MD3 页面风格与现有组件（Bottom Sheet、列表就地刷新、撤回浮条）。

浏览器 UI 调试：本会话无 browsermcp 工具，且 DSH 会话工具在启动时固定、无法在会话中动态挂载；实现阶段用测试 + typecheck/build + curl API 冒烟自检，UI 冒烟留待用户挂载 browsermcp 的新会话或用户手测。

## Global Constraints（对所有任务生效）

1. **分支**：所有提交落在当前分支 `feat/business-p0p1-agent-tools`。
2. **文档纪律**：`docs/` 下文档不得提及外部笔记软件名或路径；只引用项目内文档。
3. **后端分层**：`data/` → `repositories/` → `deps.py` → `services/` → `routers/` → `main.py`；仓库层不 import FastAPI；依赖只能自上而下。
4. **后端命名**：类 PascalCase；方法“蛇形 + 名词大写”（如 `get_ByOperationId`）；模块/文件 snake_case。
5. **测试纪律**：pytest + `tmp_path`（后端）、vitest + fake-indexeddb（前端）；只测公共接口；期望值来自文档/已知字面量，不复算实现逻辑；先写失败测试再实现（红绿循环）；测试文件头说明“验证什么、为什么”。
6. **精确值**：wire 格式 snake_case、前端 Dexie camelCase 一一对应；错误码、操作类型、字段名、默认值必须原样使用，不得发明。
7. **类型门**：前端 typecheck 是 `npx vue-tsc -b`（或 `npm run build`），`--noEmit` 是假信号。
8. **验证命令**（提交前全部通过，按任务范围跑对应子集 + 最后全量）：
   - 后端：`cd backend && .venv/bin/python -m pytest -q -m "not live"`
   - 前端：`cd frontend && npm run test && npm run build`
9. **提交粒度**：每任务 1–3 个语义化 commit（`feat(...)`/`fix(...)`/`test(...)`/`docs(...)`）；并行任务只允许 `git add` 自己任务涉及的文件路径，禁止 `git add -A` 与 `git commit -am`。
10. **不越界**：只做任务规定内容；发现设计文档自相矛盾或必须改设计的点，先停下来在报告中说明，不自行发明。
11. **并行约束**：Task 1 与 Task 2 并行（backend/ 与 frontend/ 无文件交集，Task 1 改 `docs/error-codes.md` §4.2，Task 2 不动该文件）；Task 3 与 Task 4 并行（SettingsView/新组件 vs LedgerView/OrderActionSheet/WorkOrderDetailEdit/UndoSnackbar，无文件交集）；Task 5 在全部完成后串行。

## Task 1：后端撤回执行 + Pull 历史载荷（backend/）

**范围**：只改 `backend/src/backend/`、`backend/tests/`、`docs/error-codes.md` §4.2。

### 1.1 设计：撤回执行（Push 展开）

现状：`routers/sync.py` 收 `reverts_operation_id`，`BusinessCommandService.execute_Operation` 只把它写进 `database_operations`，没有实际回滚。`OperationsRepository` 已有 `get_ByOperationId` / `get_ChangesByOperationId`。

在 `execute_Operation` 内、幂等检查之后、changes 循环之前加入撤回展开（先读现有代码确认幂等检查位置与 OperationResult 形状）：

1. `operation["reverts_operation_id"]` 非空时：
   - `target = operations_repo.get_ByOperationId(reverts_operation_id)`
   - 目标不存在，或 `target["account_phone"] != account_phone` → 返回 rejected，errors 为 `[{"entity_sync_id": "", "error_code": "revert_target_not_found", "message": ""}]`。
   - `target["reverts_operation_id"]` 非空（目标本身是撤回操作）→ rejected `revert_target_invalid`（errors 同上形状）。
   - 新增仓库方法 `find_RevertOfOperation(account_phone, operation_id) -> dict | None`：查 `database_operations WHERE account_phone = ? AND reverts_operation_id = ?`，若查到任何行（已被撤回）→ rejected `revert_target_invalid`。
   - 展开 changes：`rows = operations_repo.get_ChangesByOperationId(reverts_operation_id)`，按 `change_id` 升序。每行生成：
     - `before_json` 为 NULL（目标是一次 create）：
       - `entity_type == "work_order"` → `fields = {"deleted_at": <now>}`（now 用与 `OperationsRepository._now_factory` 一致的 UTC ISO8601），`base_version = after_version`。
       - 其他实体 → rejected `revert_target_invalid`（MVP 只支持工单 create 的撤回，等价软删）。
     - `before_json` 非 NULL → `fields = json.loads(before_json)`（服务端行快照，snake_case，直接作为 wire `fields`），`base_version = after_version`。
     - 生成 `{"entity_type": row["entity_type"], "entity_sync_id": row["entity_sync_id"], "base_version": ..., "fields": ...}`。
   - 把展开后的 changes 替换原 `operation["changes"]` 继续走现有循环（版本比对自动实现 data-model §6.5：目标后来又被改则返回 conflict，theirs 为服务端当前状态）。
2. `operation_type` 保持前端传入的 `revert_operation`；幂等行为不变（同 operation_id 重试返回已处理结果）。

### 1.2 设计：Pull 下发历史载荷

`routers/sync.py` 的 `pull` 响应扩展（旧客户端忽略未知字段，兼容）：

- operation 级新增 `"device_id": op["device_id"]`。
- change 级新增 `"before_json": c["before_json"]` 与 `"changed_fields_json": c["changed_fields_json"]`（均为 str | None）。

### 1.3 错误码登记

`docs/error-codes.md` §4.2 “通用（跨表）”表新增：

| error_code | 触发 |
| --- | --- |
| `revert_target_not_found` | 撤回目标 operation 不存在或不属于当前账户 |
| `revert_target_invalid` | 撤回目标本身是撤回操作、已被其他撤回指向，或含 MVP 不支持的实体 create 变更 |

### 1.4 测试（TDD，先红后绿）

`backend/tests/sync/test_sync.py` 追加“缝：撤回执行与 Pull 历史载荷”，用现有 `client` / `seed_account` fixture 风格：

1. create 工单（accepted）→ 再 Push 撤回操作（`reverts_operation_id=原op`，changes 为空数组 `[]`）→ accepted；随后业务层该工单 `deleted_at` 非空。
2. create 工单 → update 工单 → 撤回 update 操作 → accepted；工单字段恢复到 create 后的 after 状态（等于 update 操作的 `before_json`）。
3. 撤回不存在的 operation_id → rejected `revert_target_not_found`。
4. 撤回已经被撤回的操作 → rejected `revert_target_invalid`。
5. 撤回其他账户的操作 → rejected `revert_target_not_found`。
6. Pull 响应包含 operation 级 `device_id` 与 change 级 `before_json` / `changed_fields_json`。

### 1.5 提交

改动只限 `backend/src/backend/`、`backend/tests/`、`docs/error-codes.md`。提交前跑后端全量：`.venv/bin/python -m pytest -q -m "not live"`。

## Task 2：前端数据层补齐（frontend/src + tests）

**范围**：只改 `frontend/src/`、`frontend/` 下测试文件（`tests/` 或 `src/**/*.test.ts`）。不动任何 `.vue` 组件，不动 `docs/`。

### 2.1 本地日期修复（终审前置项①）

- 新增 `src/utils/localDate.ts`：导出 `localDateToday(): string`，返回本地时区 `YYYY-MM-DD`（用 `new Date()` 的本地 getFullYear/getMonth/getDate 拼，零填充）。
- `src/services/businessCommands.ts` 中归档收尾日期（`archiveCustomerWithMappings` 内 `new Date().toISOString().slice(0, 10)` 作为 `valid_to` 的 `today`）改用 `localDateToday()`。其余 `toISOString()`（createdAt/updatedAt 时间戳）不动。

### 2.2 MutationService.commit 返回 operationId

- `commit(input: MutationInput): Promise<string>`，返回值是生成的 `operationId`（现有调用忽略返回值即可；更新 `mutation.test.ts` 补一条“返回 operationId 且与 outbox 一致”的断言）。

### 2.3 业务命令层新增/修改（`src/services/businessCommands.ts`）

所有新命令都返回 `operationId`（string）；现有 `createWorkOrder` / `updateWorkOrder` 返回类型改为 `Promise<string>`（内部 `await commit(...)` 后 return）。

1. `deleteWorkOrder(db, syncId): Promise<string>`
   - 从 `db.workOrders.get(syncId)` 读记录；不存在 → 抛 `BusinessRuleError('entity_not_found')`。
   - change：`{ entitySyncId, entityType: 'work_order', baseVersion: row.rowVersion, baseSnapshot: toWireRecord(完整行), patch: { deleted_at: new Date().toISOString() } }`（outbox.command 的 patch/baseSnapshot 一律是 wire snake_case，与 buildPushOperation 直发 fields 的既有契约一致）；`operationType: 'update_work_order'`；apply 复用 `applyWorkOrderPatch`。
2. `revertOperation(db, targetOperationId): Promise<string>`
   - `target = await db.operations.get(targetOperationId)`；不存在 → `BusinessRuleError('revert_target_not_found')`。
   - 若 `db.operations` 中已存在 `revertsOperationId === targetOperationId` 的行 → `BusinessRuleError('revert_target_invalid')`。
   - `entitySyncIds`：解析 `target.changesJson`（JSON，形状 `{entitySyncIds: string[]}`；解析失败或空数组 → `BusinessRuleError('revert_target_invalid')`）。
   - `MutationInput = { operationType: 'revert_operation', entitySyncIds, changes: [], revertsOperationId: targetOperationId, apply: () => undefined, actorType: 'user' }`，commit 并返回 operationId。本地业务表不动（反向 patch 由服务端生成；同步后 Pull 覆盖生效）。
3. `batchPriceWorkOrders(db, targets: Array<{ syncId: string; quantity?: number; unitPriceCents?: number | null }>): Promise<string>`
   - targets 为空 → `BusinessRuleError('invalid_batch_input')`。
   - 每条：`quantity` 若提供必须正整数 → `invalid_quantity`；`unitPriceCents` 若提供必须 `null` 或 `>= 0` → `invalid_unit_price`；至少提供二者之一 → 否则 `invalid_batch_input`。
   - 读本地行（不存在 → `entity_not_found`）；change：`{ entitySyncId, entityType: 'work_order', baseVersion: row.rowVersion, baseSnapshot: toWireRecord(完整行), patch: { quantity?, unit_price_cents? } }`（wire snake_case）。
   - `operationType: 'batch_price_work_orders'`；`entitySyncIds` 为 targets 顺序；apply 按顺序对每条调 `applyWorkOrderPatch`；返回 operationId。
4. `updateWorkOrder` 现有实现：改返回 operationId，逻辑不变。

### 2.4 AI 草案补 baseSnapshot（终审前置项②）

`src/services/chatApproval.ts`：

- `buildAiOperationFromDraft` 改为 `async (db, turnId, toolName, draft): Promise<MutationInput | null>`（参数顺序：`db` 在最前）。
- `update_work_order` 分支：从 `db.workOrders.get(entitySyncId)` 读本地行；存在则 `change.baseSnapshot = toWireRecord(完整行)`（wire snake_case）；不存在返回 null。
- `create_work_order` 分支 `baseSnapshot = {}` 不变。
- 更新 `src/state/appState.ts` 中唯一调用点（`commitAiDraft`）与 `src/services/chatApproval.test.ts`（fake-indexeddb 建库补测试：update 草案生成的 change 带完整 baseSnapshot）。

### 2.5 Pull 镜像与历史载荷（`src/services/syncApi.ts` + `src/services/syncManager.ts` + schema）

- `syncApi.ts`：`pull()` 的返回类型与解析补 `deviceId`（operation 级）、`beforeJson` / `changedFieldsJson`（change 级，snake→camel：`before_json`→`beforeJson`，`changed_fields_json`→`changedFieldsJson`）。
- `src/db/schema/operations/operations.ts`：`Operation` 增加 `deviceId: string | null`（非索引字段）。
- `syncManager.ts`：
  - `applyPullPage` 写镜像时：`deviceId: op.deviceId`；`changesJson: JSON.stringify({ entitySyncIds: changes 去重收集的 entitySyncId 数组, changes: op.changes })`（`op.changes` 为解析后的数组，含 afterJson 等）。推进 appliedServerSeq 逻辑不变。
  - `MutationService.commit` 写本地 operations 时：`deviceId` 用 `getOrCreateDeviceId()` 的结果（commit 内先 await，再开事务）；`changesJson` 保持 `{entitySyncIds}` 形状。
- `resolveConflict` 现有实现不动（原冲突操作移除、生成新 operation 重推）。

### 2.6 冲突解析支持逐字段显式决策（`src/services/conflictResolver.ts`）

扩展 `buildMergedPatch`（不改变 `ConflictAnalysis`/`FieldResolution`/`ConflictResolution` 类型，不删 `autoMergePatch`）：

- `ours-only`：若 `resolution[field]` 存在且 `{source:'theirs'}` → 不写该字段（保持 Theirs）；否则照旧写 Ours。
- `theirs-only`：若 `resolution[field]` 存在且 `{source:'ours'}` → 写 `diff.oursValue`；否则照旧跳过。
- `both`：行为不变（必须有决策，Ours/Theirs/手填）。
- 更新 `conflictResolver.test.ts`：新增“用户可显式决定 ours-only / theirs-only 字段去向”的断言（期望值按上述规则字面量给出）。

### 2.7 appState 状态层（`src/state/appState.ts`，只加方法，不改 UI）

- `HistoryItem` 接口（新增导出）：`{ operationId: string; summary: string; timestamp: string; device: string | null; actorType: 'user'|'ai'|'system'; operationType: string; canRevert: boolean }`。
- `async loadOrderHistory(orderId: string): Promise<void>`：
  - 从 `db.operations.toArray()` 过滤出 changesJson（JSON.parse，兼容旧形状只有 serverSeq 时跳过）的 `entitySyncIds` 包含 orderId 的行，按 `createdAt` 升序。
  - `summary`：按 operationType 映射——`create_work_order`→`新建工单`，`update_work_order`→`修改工单`，`batch_price_work_orders`→`批量定价`，`revert_operation`→`撤回操作`，未知→`operationType` 原文；若该行 changes 里有 `changedFieldsJson`（数组或 JSON 字符串均可）则追加字段名（snake_case 原样，逗号连接，最多 4 个字段）。
  - `canRevert`：`operationType !== 'revert_operation'` 且 `revertsOperationId === null` 且不存在其他镜像行 `revertsOperationId === 该行 operationId`。
  - 结果写回 `appState.workOrders` 中对应 order 的 `history`（通过 reactive 数组 proxy 更新，注意 Vue 响应式）。
- `UndoItem` 增加 `operationId: string`（必填）。
- `triggerUndo(item: Omit<UndoItem,'expiresAt'>)`：设 `activeUndo`（expiresAt 默认 now+5s），并在过期后自动清空（保留最后一个 timer 引用，避免重复 set 泄漏）。
- 即时撤回条接入点（创建/修改/删除任一提交后 5 秒浮条）：`createWorkOrder` 成功（消息 `已保存 <客户displayName> <quantity><unit>`）、`updateWorkOrder` 成功（消息 `已保存修改`）、`deleteWorkOrder` 成功（消息 `已删除 <客户displayName> 工单`）、AI 草案确认落盘成功（消息 `AI 修改已保存`）均调用 `triggerUndo`；`createWorkOrder` / `updateWorkOrder` 的返回值改为 `Promise<string>`（透传 operationId）。`revertOrderOperation` 除外（见下）。
- `performUndo()`：`await revertOperation(db, activeUndo.operationId)`；成功后清空 activeUndo、`reload()`、触发同步；失败用现有 `showFailToast` 展示 `errorMessages` 文案。
- `async revertOrderOperation(operationId: string)`：调 `revertOperation`；成功后**不触发 UndoSnackbar**（撤回后的防手滑语义留待后续“取消撤回”设计），改用 `showSuccessToast('撤回已提交，待同步生效')`、`reload()`、触发同步；失败抛给调用方展示（文案经 `errorMessages`）。
- `async deleteWorkOrder(orderId)`：调 2.3 的 `deleteWorkOrder`，reload + 同步，triggerUndo 消息 `已删除 <客户名> 工单`。
- `async batchPrice(targets)`：调 2.3 命令，reload + 同步，失败抛出由调用方展示。
- `async resolveConflict(queueId: number, resolution: ConflictResolution)`：调 `syncManager.resolveConflict(queueId, resolution)` → `reload()` → 触发同步。
- `conflictEntries = ref<ConflictEntry[]>([])`（返回给 UI）+ `private async refreshConflicts()`：遍历 `db.outbox` 中 `status === 'conflict'` 的条目按 queueId 升序，每条组装 `{ queueId, operationId, operationType, actorType, createdAt, conflictJson, base, ours, theirs, diffs }`——用 `conflictResolver.analyzeConflict` 对 `base=change.baseSnapshot??{}`、`ours={...base,...patch}`、`theirs=conflictJson.theirs` 计算；diffs 全量给 UI（含 ours-only/theirs-only，供逐项显式决策）。`reload()` 末尾调用 `refreshConflicts()`。
- 错误文案：`src/services/errorMessages.ts` 增加 `revert_target_not_found`→`未找到可撤回的操作`、`revert_target_invalid`→`该操作不能撤回（可能已被撤回）`、`invalid_batch_input`→`请至少选择一条工单并填写一个修改项`。

### 2.8 测试

- 新/改测试文件：`businessCommands.test.ts`（删除/撤回/批量定价/operationId 返回）、`chatApproval.test.ts`（baseSnapshot）、`mutation.test.ts`（commit 返回）、`syncApi.test.ts`（Pull 新字段解析）、`conflictResolver.test.ts`（显式决策）、`utils/localDate.test.ts`（跨时区？环境 TZ 固定东八区，至少断言格式与“本地日期非 UTC”语义：构造在本地凌晨 00:30 的场景可用 `new Date(2026,0,1,0,30)` 的 fake? localDateToday 不接受参数——测试只断言格式 YYYY-MM-DD 与当前本地日期一致，期望值来自 `new Date()` 本地 getFullYear 拼出，这是字面量构造而非复算）。
- 提交前跑 `npm run test && npm run build`。

### 2.9 提交

只 add `frontend/src/`、`frontend/` 下的测试文件。**不改 `docs/`、不改 `.vue`。**

## Task 3：冲突解决中心 UI（frontend 组件）

**范围**：`src/components/settings/ConflictCenter.vue`（新建）+ `src/components/settings/SettingsView.vue`（接入）。只读 `appState.conflictEntries` / `resolveConflict`，不改其他组件。

### 3.1 交互规格（用户已确认）

1. `SettingsView` 同步组内新增行「冲突解决中心」，badge 显示冲突数（`appState.conflictEntries.length`），为 0 时禁用或点击提示“暂无冲突”。
2. `ConflictCenter.vue`：MD3 风格（复用现有 `cb-*`/`m3-*` 样式类与 token），列表每条冲突：
   - 摘要行：operationType 中文（`create_work_order`→新建工单、`update_work_order`→修改工单、`batch_price_work_orders`→批量定价、`revert_operation`→撤回）、时间（本地显示）、来源（本人/AI）、涉及的工单客户与日期（从 `appState.workOrders` 按 entitySyncId 查，查不到显示 `entitySyncId`）。
   - 展开详情：三方对比表逐字段展示 Base / Ours / Theirs；有差异的字段高亮并标记 `ours-only` / `theirs-only` / `both`；**不做任何自动合并**。
   - 每个差异字段一行提供决策：`本机(Ours)` / `服务端(Theirs)` / `手填`（数值字段 `inputmode="decimal"`，文本字段普通输入）。`both` 与 `ours-only`/`theirs-only` 同样必须显式选择后才计入 resolution。
   - 未做出全部决策前「确认并重推」禁用。
   - 「暂存，稍后处理」：收起详情、不做任何写入，条目保持 conflict（SyncManager 不会自动重试 conflict）。
   - 「去查账本核对」：`appState.setTab('ledger')`，并按该工单设置 `ledgerFilters = { datePreset:'all', customerId: 该工单 customerId }`，关闭冲突中心。
3. 确认并重推：组装 `ConflictResolution`（每个差异字段 `{source:'ours'|'theirs'}` 或 `{value}`），调 `appState.resolveConflict(queueId, resolution)`，成功提示“已生成合并操作并重新提交同步”，失败展示 `errorMessages` 文案。
4. 数值/文本比较显示：null 显示 `—`；金额分转元 `(cents/100).toFixed(2)` 显示（仅 `unit_price_cents` / `unitPriceCents` 字段）；布尔显示 是/否。
5. 不引入新依赖；不写组件测试（项目无组件测试设施），以 `npm run build` 类型门 + 手动冒烟为准。

### 3.2 验收

`npm run build` 零错误；不改数据层；提交只 add 这两个文件。

## Task 4：批量定价 / 软删 / 撤回 / Undo UI（frontend 组件）

**范围**：`src/components/ledger/LedgerView.vue`、`src/components/ledger/OrderActionSheet.vue`、`src/components/ledger/WorkOrderDetailEdit.vue`、`src/components/common/UndoSnackbar.vue`。只消费 appState 已有方法，不改状态层。

（更新：`OrderActionSheet.vue` 已于 ui-smoke-fixes Task 2 作为死代码删除，LedgerView 详情面板使用 `WorkOrderDetailEdit.vue`。）

### 4.1 批量定价（查账本多选）

- `LedgerView.vue`：
  - 工具栏加「批量」按钮，点击进入多选模式（`selectionMode` 局部 state）；卡片左侧显示圆形勾选；再次点击或「取消」退出并清空选择。
  - 底部批量条：`已选 N 单` + 「批量设价」+ 「取消」。
  - 「批量设价」打开 Bottom Sheet：数量输入（空 = 不改）、单价输入（空 = 不改，支持 0 与两位小数），至少填一项；确认调 `appState.batchPrice(targets)`，targets 元素只需 `{ syncId, quantity?, unitPriceCents? }`（rowVersion/baseSnapshot 由命令层现读本地行），成功后清空选择、关闭面板、Toast 提示，失败展示 `errorMessages`。
  - 进入多选模式时筛选条件不变（用户在筛选结果内勾选）。
- 数值输入复用现有 `utils/numericInput` 的校验风格（不新造）。

### 4.2 软删开放

- `OrderActionSheet.vue` 与 `WorkOrderDetailEdit.vue` 的「删除单据/工单」按钮接 `appState.deleteWorkOrder(order.syncId)`：
  - 先确认（用现有确认交互风格，如底部确认弹层或 Vant `showConfirmDialog`，读现有代码决定，不引入新依赖即可）。
  - 成功后关闭面板；删除记录从列表消失（Repository query 已排除 deletedAt，reload 后自然消失）；触发 Undo 浮条。
- `appState.deleteWorkOrder` 中 Undo 消息：`已删除 <customerDisplayName> 工单`。

### 4.3 真实撤回（历史轨迹 + 撤回入口）

- `OrderActionSheet.vue` / `WorkOrderDetailEdit.vue` 打开面板或展开历史时：`await appState.loadOrderHistory(order.syncId)`，历史行渲染 `appState.workOrders` 中该单 `history`：
  - 每行：`summary`、`timestamp`、`device`（null 显示 `本机`）、来源（AI/本人）。
  - `canRevert === true` 的行显示「撤回这次修改」按钮；点击确认后 `await appState.revertOrderOperation(operationId)`。`canRevert === false` 显示「已撤回」或对撤回操作行显示「撤回记录」标记。
- 撤回提交后本地列表不立即变（反向 patch 由服务端生成，Push→Pull 后生效），Toast 文案必须写「撤回已提交，待同步生效」。
- `UndoSnackbar.vue`：点击「撤回」调 `appState.performUndo()`（Task 2 已实现），倒计时条行为保持不变；`activeUndo` 过期自动消失。

### 4.4 验收

`npm run build` 零错误；提交只 add 四个组件文件。

## Task 5：文档同步 + 全量验收 + 收尾（串行）

**范围**：`docs/`、`AGENTS.md`、`README.md`（如需），不做功能代码。

1. 更新 `docs/data-model.md`：
   - §5.2 operations 镜像：`changesJson` 新增形状 `{ entitySyncIds, changes:[{entityType, entitySyncId, changeType, beforeJson, afterJson, afterVersion, changedFieldsJson}] }`；`Operation` 增 `deviceId`。
   - 新增已定：操作类型 `revert_operation`（前端提交撤回意图，changes 为空数组；服务端按 `database_operations.reverts_operation_id` 找到目标、用 `operation_changes` 的 `before_json`/`after_version` 展开反向 fields 后走普通写入管线）与 `batch_price_work_orders`（一条操作多 change，逐单 patch 数量/单价）。
   - §6.5 撤回：补 MVP 实现语义——create 的撤回仅支持工单（等价软删 `deleted_at`）；目标已被撤回/目标不存在/跨账户的错误码；本地不立即回滚，Push→Pull 后生效。
2. 更新 `docs/sync-protocol.md`：Push 撤回展开语义；Pull 响应 operation 级 `device_id` 与 change 级 `before_json` / `changed_fields_json`（均为新增可选字段）。
3. `docs/error-codes.md` §5：确认三个新码的前端中文文案（Task 2 已落 `errorMessages.ts`，此处登记对照）。
4. 更新 `AGENTS.md`「当前协作状态」与「未定事项」：二期交互已完成（软删、历史轨迹+撤回、冲突解决中心、批量定价、AI 草案 baseSnapshot、本地日期修复、Pull 历史载荷）；撤回 MVP 边界（本地不立即回滚、只支持工单 create 撤回）登记；浏览器 UI 冒烟待 browsermcp 会话执行；保留原有历史记录不删。
5. 跑全量验证：后端 `pytest -q -m "not live"`、前端 `npm run test && npm run build`；若有失败修复（本任务允许小修）。
6. 提交文档改动（1–2 个 `docs(...)` commit）。

## 验收标准（全部完成后）

1. 后端 `pytest -m "not live"` 全绿（在 235 之上新增 Task 1 测试）。
2. 前端 `npm run test` 全绿（在 183 之上新增 Task 2 测试）；`npm run build` 零错误。
3. 手动冒烟（接口层，无浏览器）：登录 → 录单 → 修改 → 删除（软删从列表消失）→ 撤回某次修改（outbox 出现 `revert_operation`）→ Push 后工单恢复 → 批量定价一条操作多 change 同步成功 → 制造冲突后冲突中心显示完整三方对比、暂存、去查账本、逐字段决策重推。
4. 文档同步如上。
5. 提交落在 `feat/business-p0p1-agent-tools`；并行任务无文件交叉提交。
