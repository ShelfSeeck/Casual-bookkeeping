# 后端同步实现（MVP）spec

> 面向开发与前后端联调的接口设计。范围：后端同步三端点（Push / Pull / bootstrap）的可运行实现。
> 相关文档：`docs/sync-protocol.md`（端点契约与协议语义）、`docs/data-model.md`（业务表/操作历史结构）、`docs/error-codes.md`（错误码）、`docs/auth-structure.md`（鉴权接入）、`docs/api.md`（端点约定）。

## 1. 目的与范围

### 目标

实现后端同步三端点：客户端批量 Push 操作（幂等 + 版本校验 + 业务校验）、增量 Pull（`server_seq` 游标分页）、bootstrap（四表快照 + `snapshot_seq`），支撑离线优先 PWA 与多设备/多账户隔离。

### 范围

- 后端：四张业务表仓库、操作历史仓库、`BusinessCommandService`（单条操作处理链）、`routers/sync.py` 三端点、`deps.py` 组装。
- 测试：仓库层（缝 11/12）、命令服务（缝 13）、端点接口（缝 14），pytest + 临时 SQLite。
- 前端：**本次不搭建**，只按 `docs/sync-protocol.md` 定义后端可消费的契约。

### 不做（MVP 明确排除）

- 撤回（`reverts_operation_id`）的执行：仓库/表已预留，MVP 不实现反向操作命令。
- 图片、录音等大文件同步。
- 服务端只读快照：bootstrap 接受读时差，靠 Pull 收敛（见 `docs/sync-protocol.md` §4.3）。
- 单次 Pull 的响应字节压缩、流式传输。

## 2. 架构决策

| 决策 | 结论 |
| --- | --- |
| 分层 | `data/schema`（已建表）→ `repositories`（受控读写）→ `services/BusinessCommandService` → `deps` → `routers/sync`；依赖自上而下，仓库层不 import FastAPI |
| 业务校验归属 | **方案 A**：跨表规则（大小类匹配、客户存在、映射按日期有效）放 `BusinessCommandService`；本表字段校验（数量>0、单位非空、名称非空、单价>=0、JSON 格式）放各业务仓库 |
| 幂等 | `operation_id` 唯一 + `request_hash`（服务端对规范化命令计算）；已存在且 hash 相同返回首次 `result_json`，不同则拒绝（`operation_id_conflict`） |
| 版本 | `base_version`（create 为 0）与业务表当前 `row_version` 比对；不等 → conflict，返回 Theirs 快照 + 版本，不写任何表 |
| 原子性 | 一条操作内多个 changes 在**同一个 SQLite 事务**执行；任一冲突/校验失败整条不写，全部回滚 |
| 操作间 | Push 请求内多条操作**相互独立**：逐条处理，各自成功/失败，互不阻塞 |
| 账户隔离 | 所有仓库查询/写入强制带 `account_phone`；操作历史按 `account_phone` 过滤 |
| 软删 | delete = 置 `deleted_at` / `archived_at` 时间戳，不物理删除；`row_version` 照常递增 |
| 时间 | 统一 ISO 8601 UTC（由仓库生成，调用方不关心） |

## 3. 分层与依赖

```text
routers/sync.py ──► deps.get_SyncService（组装）
                        │
services/business_command.py ──► 四张业务仓库 + 操作历史仓库
repositories/{work_orders,customers,customer_code_mappings,
              service_categories,operations}.py
data/schema/business/* + operations/*（已建表）
```

- `get_Connection`（deps.py）每请求一个连接，正常 commit、异常 rollback，事务边界统一。
- Push 端点对**一条操作**开启一个 SQLite 事务（原子性），多条操作顺序循环各自事务。
- 端点经 `get_CurrentAccount` 拿 `account_phone` / `device_id`，不信任请求体里的账户参数。

## 4. 业务仓库(缝 11)

四张表各一个仓库文件，接口同构（表字段不同）。本表字段校验放这里。

| 方法 | 行为 |
| --- | --- |
| `get_BySyncId(account_phone, sync_id) -> Record \| None` | 按 sync_id 查一条（含 row_version）；查无 → None |
| `apply_Write(account_phone, sync_id, fields, base_version) -> ApplyResult` | 见下，含版本比对 + row_version 递增 |
| `list_Active(account_phone) -> list[Record]` | 当前在用（未软删）记录，bootstrap 用 |

`apply_Write` 行为：
- **create**（`base_version == 0`）：记录不存在则插入，`row_version = 1`；已存在 → 冲突。
- **update**（`base_version > 0`）：记录存在且 `base_version == row_version` → 更新字段 + `row_version + 1`；版本不等 → 冲突；记录不存在 → `entity_not_found`。
- **delete/restore**：同 update，只是 `fields` 含 `deleted_at` / `archived_at`（置时间戳或置空）。
- 返回 `ApplyResult(status, new_row_version)`；status ∈ `applied` / `conflict` / `rejected` / `not_found`。

每表本表校验（触发 rejected）：
| 表 | 校验 |
| --- | --- |
| `work_orders` | quantity>0、unit 非空、unit_price_cents>=0 或 NULL |
| `customers` | canonical_name 非空 |
| `customer_code_mappings` | valid_to 为空或 >= valid_from |
| `service_categories` | subcategories_json 可解析为数组、category_name 同账户内不重复（UNIQUE 兜底） |

账户隔离：所有方法第一个参数 `account_phone`，WHERE 强制带，测一条"同 sync_id 不同账户查不到"。

## 5. 操作历史仓库(缝 12)

`operations.py` 管 `database_operations` + `operation_changes` 两张表。

| 方法 | 行为 |
| --- | --- |
| `insert_Operation(account_phone, device_id, operation_id, request_hash, actor_type, operation_type, source_turn_id, result_json, changes) -> int` | 写主表（拿自增 `server_seq`）+ 写 changes 明细，同一事务 |
| `get_ByOperationId(operation_id) -> Operation \| None` | 幂等查：同 operation_id 是否已处理 |
| `list_AfterSeq(account_phone, after_seq, limit) -> (list[Operation], has_more)` | Pull：`server_seq > after` 升序分页；一条操作不拆分（按操作取整页） |
| `get_MaxSeq() -> int` | bootstrap：`snapshot_seq = max(server_seq)` |

- `Operation` 返回结构含 `server_seq`、`operation_id`、`operation_type`、`changes`（含 `after_json` / `after_version`），即 Pull 响应载荷的直接来源。
- `changes` 明细存 `before_json` / `after_json`（服务端生成完整快照，不信任客户端提交的历史快照）。

## 6. BusinessCommandService(缝 13)

`services/business_command.py`，处理一条 Push 操作。

```text
1. 幂等：get_ByOperationId
   ├─ 存在且 hash 相同 → 返回首次 result_json（accepted）
   ├─ 存在但 hash 不同 → rejected（operation_id_conflict）
   └─ 不存在 → 继续
2. 开启事务：对每个 change 调业务仓库 apply_Write
   ├─ 任一 conflict / rejected / not_found → 整条回滚
   └─ 全部 applied → 写操作历史（insert_Operation，含 after_json）
3. 提交，返回 accepted（server_seq + 新 row_versions）
```

跨表校验（放这里，调用对应仓库查询）：
| 规则 | 触发 rejected |
| --- | --- |
| 工单服务小类属于所选大类且可用 | `service_item_mismatch` / `service_option_disabled` |
| 工单客户存在且未归档 | `customer_not_found` |
| 工单编号映射按 `work_order_date` 有效 | `customer_mapping_invalid` |

接口：`execute_Operation(account_phone, device_id, operation) -> OperationResult`；`OperationResult` 含 `status`（accepted / conflict / rejected）与相应字段（`server_seq` / `row_versions` / `conflict_json` / `errors`）。

## 7. 同步端点(缝 14)

`routers/sync.py`，前缀 `/sync`，全部经 `get_CurrentAccount` 鉴权。契约详见 `docs/sync-protocol.md` §4；错误码见 `docs/error-codes.md`。

| 端点 | 行为 |
| --- | --- |
| `POST /sync/push` | 请求 `{operations: [...]}` 按队列顺序；批量上限 500 条 / 请求体 1MB（超出 400 `invalid_request`，见 `docs/sync-protocol.md` §5）；逐条调 `execute_Operation`；返回 `{results: [...]}`，与请求一一对应 |
| `GET /sync/pull?after=&limit=` | 调 `list_AfterSeq`，返回 `{operations, has_more}`；默认 limit=200、上限 500；MVP 以条数限流，不做响应字节截断 |
| `GET /sync/bootstrap?cursor=` | **MVP 不分页**：一次返回四表当前在用记录 + `snapshot_seq` + `has_more=false`；`cursor` 参数忽略，编码留待分页需求出现时再定（见 AGENTS.md 未定事项） |

错误映射：请求整体格式非法 → 400 `invalid_request`；缺字段/类型错 → 422（FastAPI 默认）；鉴权 → 401/403（复用 auth 语义）。

## 8. 测试计划

pytest + `tmp_path` 临时库；`conftest.py` 的 `database`/`connection` fixture 复用；先写失败测试再最小实现（红绿循环）；期望值来自文档字面量。

| 缝 | 文件 | 用例要点 |
| --- | --- | --- |
| 4 | `tests/repositories/test_business_repositories.py` | 每表：get_BySyncId（查无 None / 命中含 row_version / **账户隔离**）、create row_version=1、update 版本一致递增、版本不等 conflict、delete 置 deleted_at、本表校验 rejected |
| 5 | `tests/repositories/test_operation_repositories.py` | 插入取 server_seq、按 operation_id 幂等查、list_AfterSeq 升序/游标/分页不拆操作、get_MaxSeq |
| 6 | `tests/services/test_business_command.py` | 幂等（同 hash 返回首次 / 不同 hash 拒绝）、rejected（本表 + 跨表校验）、conflict（Theirs 返回）、原子性（多变更任一失败整条回滚、不留操作历史）、成功写业务表 + 历史 + 返回新版本 |
| 7 | `tests/sync/test_sync.py` | push 批量保序逐条结果、pull 分页游标、bootstrap 四表快照 + snapshot_seq、未认证 401、停用/被踢 403 |
