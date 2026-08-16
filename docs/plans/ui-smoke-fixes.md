---
status: archived
as_of: 2026-08-16
reason: headless 冒烟修复已全部落地（前端测试与构建全绿）；仅作历史存档
---

# 执行计划：UI 冒烟问题修复（2026-08-16 headless 冒烟）

> 任务源。背景：二期 UI 冒烟（headless Chromium + CDP）暴露 9 个真实问题，已逐条核实。
> 依据：`docs/data-model.md`、`docs/sync-protocol.md`、`AGENTS.md`、`docs/plans/phase2-business-interactions.md`。

## Global Constraints

1. 分支：当前分支 `feat/business-p0p1-agent-tools`。
2. TDD：先失败测试再实现；只测公共接口；期望值字面量。
3. 验证：`cd frontend && npm run test && npm run build` 全绿（后端无改动，不跑）。
4. 并行任务只 git add 自己范围文件，禁止 `git add -A` / `commit -am`；英文 commit，`fix:`/`test:`/`docs:` 前缀。
5. 文档纪律：docs/ 不提及外部笔记软件名或路径。

## Task 1：数据/同步层修复（frontend/src/services + appState + docs）

问题与修复（编号对应冒烟报告）：

- **问题 4（Pull 阻塞）**：`syncManager.runOnce` 第 2 步 `outbox.count() === 0` 才 Pull，仅剩 conflict/rejected 时本地永远不收敛。改为：`await db.outbox.where('status').anyOf('pending','sending').count()` 为 0 即允许 Pull（conflict/rejected 材料保留在 outbox，Pull 覆盖业务表不丢材料）。更新 `docs/sync-protocol.md` 相应条文（原“outbox 未清空不 Pull”改为“存在 pending/sending 不 Pull；仅剩 conflict/rejected 允许 Pull”）与 `AGENTS.md` 已定 2026-08-08 同步条目（AGENTS.md 本地不入库，直接改工作区文件）。测试：syncManager.test.ts 补两个用例——仅剩 conflict 时 runOnce 仍调 pull；存在 pending 时不调 pull。
- **问题 5（布尔归一化）**：`toCamelRecord` 不转换 SQLite 的 `is_completed: 0/1`。在 syncManager 增加 `normalizeWorkOrder(record)`（`isCompleted = Boolean(record.isCompleted)`，其余字段原样），应用于 Pull `putToTable` 的 work_order 分支与 bootstrap workOrders put。测试：现有 pull/bootstrap 测试补断言（after_json `is_completed:1` → 本地 `isCompleted === true`）。
- **问题 6（内部主键进冲突决策）**：`WIRE_META_FIELDS` 增加 `work_order_id`；同时核对四表快照里其他内部主键（如 `mapping_id` / `service_category_id`，若存在一并加入；`customer_id` 是业务身份，**保留**）。更新 conflictResolver.test.ts 字面量。
- **问题 7（record_gated 翻译）**：`errorMessages.ts` 增加 `record_gated: '该记录有未解决的冲突，请先到冲突解决中心处理'`；`toErrorMessage` 对 message 形如 `code:detail` 的字符串先取 `code` 查表命中则返回文案（否则回退原 message）。测试：errorMessages.test.ts 补 `new Error('record_gated:sync-abc')` → 中文文案。docs/error-codes.md §4.4 登记该前端本地码。
- **问题 8（摘要 deleted_at 噪音）**：appState 的 `changedFieldNames` 排除集合在 `WIRE_META_FIELDS` 之外追加 `deleted_at`、`archived_at`（只用于摘要，不加入冲突 strip 集合）。
- **问题 3 状态层部分**：`appState.reload` 组装 `uiOrders` 时 `history` 保留旧元素已有值——`history: previous?.history ?? []`（previous 为 reload 前 `this.workOrders` 中同 syncId 元素）。这样自动 reload 不再清空已加载的历史。
- 提交范围：`frontend/src/services/`、`frontend/src/state/appState.ts` 及相关测试、`docs/sync-protocol.md`、`docs/error-codes.md`、`AGENTS.md`（本地）。不碰任何 `.vue`、不碰 `utils/`。

## Task 2：UI 组件修复（frontend/src/components + utils/localDate.ts）

- **问题 1（日期写死）**：`utils/localDate.ts` 增加 `shiftLocalDate(base: string, days: number): string`——用本地时区 `new Date(y, m-1, d + days)` 重新拼 YYYY-MM-DD（零填充），不接受非法 base。`localDate.test.ts` 补字面量用例（如 `shiftLocalDate('2026-08-15', -1) === '2026-08-14'`、跨月 `shiftLocalDate('2026-08-01', -1) === '2026-07-31'`）。
  - `WorkOrderDesk.vue`：删除全部 `2026-08-13/14/15` 字面量；用 computed `today`（`localDateToday()`）、`yesterday`、`dayBefore`（`shiftLocalDate`）；日期标签（今天/昨天）与日期选择 sheet 的三个快捷项全部走 computed；确认 `orderDate` 初始值为动态 today（若当前写死则修）。
  - `WorkOrderDetailEdit.vue`：同样删除硬编码，标签与快捷项走 computed。
  - `LedgerFilterBar.vue`：快捷区间对象改为 computed（近3天 = [shift(-2), today]，近7天 = [shift(-6), today]，近30天 = [shift(-29), today]）；“今天”默认日期与自选日期默认值改为动态 today。
- **问题 2（详情面板不刷新）**：`LedgerView.vue` 的 `activeOrder = ref<WorkOrderUi|null>` 改为存 `activeOrderId`（syncId）+ `activeOrder = computed(() => appState.workOrders.find(o => o.orderId === activeOrderId.value) ?? null)`；打开/关闭函数只操作 id；检查模板与其他引用全部改从 computed 读。效果：`appState.reload()` 替换数组后面板自动显示最新对象。
- **问题 9（死代码）**：`git rm frontend/src/components/ledger/OrderActionSheet.vue`（全仓库确认无 import；LedgerView 使用 WorkOrderDetailEdit）。若 AGENTS.md/docs 提到该文件按现状描述补一句删除说明，不重构历史记录。
- 提交范围：上述 3 个 `.vue`、`utils/localDate.ts` 与其测试、删除 OrderActionSheet.vue。不碰 services/、state/。

## 验收

1. `cd frontend && npm run test && npm run build` 全绿。
2. 修复点与问题编号一一对应；无新增依赖。
3. 后端不跑（无后端改动）。
