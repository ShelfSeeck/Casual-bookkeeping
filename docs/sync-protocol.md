# Casual-bookkeeping 远程同步协议

> 本文定义 bootstrap / Push / Pull 的端点契约、载荷、顺序与失败语义。
> 数据模型与术语见 `docs/data-model.md`；账户、设备、token 见 `docs/auth-structure.md`。
> 本文只收录已定内容；未定内容见文末与 `AGENTS.md` 的“未定事项”。

## 1. 目的与边界

- 定义前端（Dexie）与后端（FastAPI/SQLite）之间的同步协议：何时同步、推什么、拉什么、冲突怎么办。
- 服务端是业务数据的权威来源；前端本地库是离线可用的工作副本，靠 Pull 收敛到服务端状态。
- 认证只决定“能否连后端”，不控制本地记账（见 `docs/auth-structure.md`）。
- 图片、录音等大文件不进入同步。

## 2. 核心原则

1. **每轮先 Push、后 Pull**：先把本地待确认操作交给服务端检查版本，再拉取所有变更。
2. **存在 pending / sending 不 Pull**：只要 outbox 里还有 `pending` / `sending` 条目，这一轮只 Push、不 Pull；仅剩 `conflict` / `rejected` 时允许 Pull（见 §6）。
3. **先本地后同步**：本地写入立即生效进本地业务表；服务端确认才是最终权威。未决修改（尚未被服务端确认的本地更改）不因同步丢失——靠“存在 pending / sending 不 Pull”保证 Pull 不会覆盖它们；conflict / rejected 期间业务表可被 Pull 结果快照覆盖，冲突材料（Base / Ours / Theirs）只在 outbox，不进入业务表。
4. **Pull 应用的是结果快照，不是重放 patch**：客户端不需要理解每种 operation 的语义，只把记录的最终快照写进去（delete/restore 也只是带软删标记的快照）。
5. **幂等按 `operation_id`**：网络重试不重复写业务表。
6. **冲突的具体内容由前端算**：服务端只给“当前状态”（Theirs），前端用 Base / Ours / Theirs 三方对比出差异。

## 3. 前端会话与身份

### 3.1 活跃账户

- meta 库（`cb-meta`）存设备级数据，当前含 `device_id` 与**活跃账户身份 `account_phone`**（新增）。
- 一台设备同一时刻只有一个活跃账户；它决定离线时打开哪个业务库 `db_<phone>`。
- **失效是会话态，不持久化**：每次启动在线时调 `/auth/refresh` 实时判定能否连后端，401/403 则进入登录页；离线时仍打开本地业务库正常记账。

### 3.2 token 存取（沿用 auth-structure §2.6）

- access token 存 localStorage；refresh token 存 HttpOnly + Secure cookie；活跃账户身份存 meta 库。

### 3.3 API client 统一拦截

- 所有同步请求（以及将来 AI 请求）走同一个 API client。
- 收到 401 → 静默调 `/auth/refresh`（cookie 自带）→ 用新 access **重试原请求一次**。
- refresh 本身返回 401/403（失效 / 被踢 / 停用）→ 停止本轮同步，进入登录页，本地数据保留。
- refresh 用 **single-flight**：并发多个请求同时 401 时只发一次 refresh，其余复用同一个 Promise。
- 同步管理器不感知这些细节，只看到“同步成功”或“同步失败（会话失效）”。

## 4. 端点契约

三个端点全部需要有效 access token（鉴权守卫见 `docs/auth-structure.md` §2.10）。

### 4.1 POST /sync/push

批量推送本地待同步操作。请求体是操作数组，**必须按 outbox 的 `queueId` 顺序排列**，服务端保序逐条执行。

请求体：

```json
{
  "operations": [
    {
      "operation_id": "op-a1b2c3d4e5f6",
      "operation_type": "update_work_order",
      "actor_type": "user",
      "source_turn_id": null,
      "reverts_operation_id": null,
      "changes": [
        {
          "entity_type": "work_order",
          "entity_sync_id": "sync-0001",
          "base_version": 4,
          "fields": { "unit_price_cents": 1250 }
        }
      ]
    }
  ]
}
```

> wire 格式统一用 `fields`（一条变更希望改变的字段集合）；`base_snapshot` / `patch` 的概念仍存在于前端 `outbox.command`（冲突合并时 Base / Ours 的来源，结构见 `docs/data-model.md` §6.3），不进 wire。`base_version` 照常随变更提交，服务端据此做版本校验。

撤回展开语义（`reverts_operation_id`）：

- `operation_type = "revert_operation"` 时，前端只提交撤回意图：`reverts_operation_id` 指向目标操作，`changes` 为空数组。
- 服务端在幂等检查之后、changes 循环之前把撤回意图展开成反向 changes，再走普通写入管线（`docs/data-model.md` §6.5）：按 `operation_changes.change_id` 升序，每条 change 取 `before_json` 作为 `fields`、`after_version` 作为 `base_version`。
- create 的撤回仅支持工单，展开为等价软删（`fields.deleted_at = 当前时间`）；其他实体的 create 撤回不支持。
- 展开前校验目标：目标不存在或不属于当前账户 → `revert_target_not_found`；目标本身是撤回操作、已被其他撤回指向、或含不支持的实体 create 变更 → `revert_target_invalid`。校验失败为单条 `rejected`（变更级 errors）。
- 展开后的反向 changes 走普通版本校验：目标记录在服务端已被再次修改时返回 `conflict`（Theirs 为服务端当前状态）。**MVP 已知限制**：前端当前没有撤回冲突的三方合并路径（撤回操作提交时 `changes: []`，outbox.command 无 base_snapshot/patch），撤回冲突条目保留在 outbox 且计入冲突数；冲突中心可见（只读提示）、不可展开/重推；该路径待后续补实现。

批量上限：单次请求最多 500 条操作、请求体不超过 1MB；超出返回 400 `invalid_request`，由客户端拆批重发（见 §5）。

响应体（数组与请求一一对应）：

```json
{
  "results": [
    {
      "operation_id": "op-a1b2c3d4e5f6",
      "status": "accepted",
      "server_seq": 42,
      "row_versions": { "sync-0001": 5 }
    }
  ]
}
```

单条结果三种状态：

| status | 含义 | 附带字段 | 客户端动作 |
| --- | --- | --- | --- |
| `accepted` | 服务端接受，已写正式历史 | `server_seq`、`row_versions`（每条记录的新版本） | 删除 outbox，operations 标 synced |
| `conflict` | `base_version` 与当前 `row_version` 不一致，未写入 | `conflict_json`（含 Theirs 快照 + row_version） | 保留 outbox，进入三方对比（§7） |
| `rejected` | 命令本身非法（业务校验失败），未写入 | `error`（错误码 + 信息） | 保留 outbox，等待用户修正或丢弃 |

- 新建（create）操作：`base_version` 填 `0`，表示此前不存在该记录；服务端规则"记录不存在即允许创建"。
- 删除（delete）操作为**软删**：`patch` 把 `deleted_at`（工单）或 `archived_at`（客户）设为当前时间，`base_version` 照常校验；不物理删除。
- 操作内多个 `changes` 为**原子**：任一记录冲突或校验失败，整条操作不写入，全部返回非 `accepted`（见 §7）。操作之间则相互独立。

幂等（`docs/data-model.md` §5.5）：服务端按 `operation_id` 查正式操作表；已存在且 `request_hash` 相同则直接返回首次成功的 `result_json`；已存在但哈希不同则拒绝复用。

### 4.2 GET /sync/pull

增量拉取。`after` 是排他游标（= 本地 `applied_server_seq`），返回 `server_seq > after` 且属于当前账户的操作，升序。

> `server_seq` 是全局自增序号（所有账户共用），但 Pull 只返回当前账户的操作，因此本账户操作之间**必然存在跨账户的 gap**。游标语义是"严格大于"，不要求 `after + 1` 连续；客户端应用后把 `applied_server_seq` 设为本账户最后一条操作的 seq 即可。

```
GET /sync/pull?after=41&limit=200
```

响应体：

```json
{
  "operations": [
    {
      "server_seq": 42,
      "operation_id": "op-...",
      "operation_type": "update_work_order",
      "actor_type": "user",
      "device_id": "dev-a1b2c3d4e5f6",
      "created_at": "2026-08-08T12:00:00+08:00",
      "changes": [
        {
          "entity_type": "work_order",
          "entity_sync_id": "sync-0001",
          "change_type": "update",
          "after_json": "{\"...\": \"应用后的完整业务快照\"}",
          "after_version": 5,
          "before_json": "{\"...\": \"变更前完整业务快照（create 为 null）\"}",
          "changed_fields_json": "{\"unit_price_cents\":{\"before\":null,\"after\":1250}}"
        }
      ]
    }
  ],
  "has_more": true
}
```

- `limit`：默认 200，上限 500。每页同时限操作数量与响应字节数（1MB），单次业务操作也设规模上限；一条操作不会被拆到两个响应中。
- `actor_type`（operation 级，`user` / `ai` / `system`）与 `device_id`（operation 级）、`before_json` / `changed_fields_json`（change 级）为**新增可选字段，向后兼容**：旧后端缺省时前端按 `null` / `user` 处理。`before_json` 在 create 变更为 `null`；`changed_fields_json` 是变更字段 before/after 差异的 JSON 字符串（create 记全量快照）。
- 客户端先在 IndexedDB 事务外完成网络下载与 JSON 解析，再开一个 Dexie 事务一次完成：应用本页所有业务变化（写 `after_json` + `after_version` 到业务表）、写入本地 operations 镜像（含 `deviceId` 与上述两个新字段，供历史载荷展示）、更新 `applied_server_seq` 为本页最后一条 `server_seq`。
- 事务失败或 PWA 中途退出时，整页回滚，`applied_server_seq` 保持原值，下次从原值继续拉。
- **写入用 `put`（按 `operationId` 幂等覆盖），不用 `add`**：自己已 push 并被 Pull 拉回的操作，覆盖同一行，天然去重；Pull 不能跳过这些操作，否则 `applied_server_seq` 游标无法推进。
- delete / restore 操作同样是 `after_json` 完整快照（软删标记字段非空 / 置空），客户端整条覆盖，**不执行"移除记录"动作**。

### 4.3 GET /sync/bootstrap

本地为空（新设备首登、本地库被清空、切换账户后）时执行。分页下载四张业务表当前有效状态，不重放历史、不传 SQLite 文件。

```
GET /sync/bootstrap?cursor=...
```

**MVP 扁平返回、不分页**：一次返回四张表的当前在用记录 + `snapshot_seq` + `has_more=false`；游标分页留待数据量增大后再做（见 §12）。`cursor` 参数当前被忽略。

响应体：

```json
{
  "snapshot_seq": 100,
  "has_more": false,
  "customers": [ { "...": "含 sync_id、row_version、account_phone 的完整业务记录" } ],
  "service_categories": [ "..." ],
  "work_orders": [ "..." ],
  "customer_code_mappings": [ "..." ]
}
```

- **`snapshot_seq`**：服务端固定的最大 `server_seq`，作为这份快照的基线。
- 只下载**当前在用**记录（`deleted_at` / `archived_at` 为空的软删记录不进入 bootstrap）；历史记录靠后续 Pull 的 delete 操作带出。
- 客户端写完四张表后 `applied_server_seq = snapshot_seq`，再立即 Pull `snapshot_seq` 之后的新操作，把下载期间的增量补齐。
- 接受各表下载期间的读时差（不同表可能"长在"不同版本上），靠后续 Pull 收敛到一致。

## 5. Push 语义

- **保序**：同一 `sync_id` 的 create → update → delete 必须按请求顺序执行；服务端按数组顺序逐条处理。
- **部分成功是特性**：一条 conflict 不阻塞整批，其余条照常 accepted。
- 批量请求体大小设上限（当前：最多 500 条操作、请求体 1MB），超出服务端返回 400 `invalid_request`，由客户端拆批重发。
- `operation_id` 是幂等键，也是撤回关联与操作历史归组的键（`docs/data-model.md` §5.1）。

## 6. Pull 语义与同步循环

每轮同步流程：

```text
1. Push 全部 outbox（保序，逐条结果）
2. Push 后仍有 pending / sending（如网络错误回退、拆批未清）→ 本轮只 Push，不 Pull
3. 若某条 conflict → 停下，进三方对比（§7）；用户解决后生成新合并操作重新 Push
4. 仅剩 conflict / rejected 或 outbox 清空时 → 统一 Pull：拉 applied_seq 之后所有变更，一次性收敛业务表 + 写 operations 镜像 + 推进 applied_server_seq
```

**存在 pending / sending 不 Pull**：只要还有 `pending` / `sending`，这一轮只 Push。仅剩 `conflict` / `rejected` 时允许 Pull。理由：Pull 应用的是服务端结果快照，若本地还有未推送成功的修改，覆盖会让未决修改丢失；conflict / rejected 的 Base / Ours / Theirs 材料只存在 outbox，不进入业务表，因此业务表可被 Pull 结果快照覆盖（见 §8 单记录 gate）。

## 7. 冲突处理

- 冲突发生在 Push 时：服务端发现 `base_version ≠ row_version`，不写业务表，返回 `conflict_json`（Theirs 当前快照 + row_version）。
- **Theirs 来自冲突响应本身**，不等 Pull；UI 立即能拼三方对比。
- 前端用三份材料本地比对：

```text
Base     outbox.command.base_snapshot（修改前快照）
Ours     Base 应用 patch 后的本地目标结果
Theirs   冲突响应返回的服务端当前结果
```

- 双方改不同字段 → 可自动合并建议；改同一字段 → 用户选 Ours / Theirs / 手动填。
- 合并结果不能直接写后端：生成新的 `operation_id`，以 Theirs 的当前 `row_version` 作为 `base_version`，重新走 Push。
- 原冲突操作保留在本地作为合并来源，处理完成后从 outbox 移除。
- **操作内原子**：一条操作含多条变更时，任一记录冲突则整条操作不提交，用户确认整条合并后再生成新操作；操作与操作之间相互独立，不互相阻塞。

## 8. 并发写入控制

不做全局锁（本地优先原则下不能锁数据）。用两套轻量机制：

- **单记录 gate**：某 `syncId` 在 outbox 中有未决条目时，对该记录的新写入受限：
  - `pending`：允许继续写（保序即可）。
  - `conflict`：禁止，必须先解决冲突（新写入的 base 语义模糊）。
  - `rejected`：禁止或要求先修正原操作。
  - 前端在写入入口（MutationService / 页面层）查 outbox 的 `entitySyncIds` 实现。
- **同步循环单飞**：同一时刻只有一个 Push → Pull 循环在跑（队列/标志位），防止手动同步与自动同步同时处理 outbox。

## 9. 重试与退避

- **网络错误**（Push / Pull / bootstrap 请求失败）：指数退避重试，首次 1s，×2，封顶 60s，加抖动；不设最大次数（断网就无限退避等网络恢复）。outbox 记录 `attempts` 与 `nextRetryAt`。
- **conflict / rejected 不自动重试**：等用户处理。
- 应用重新启动时，超时停留在 `sending` 的 outbox 记录恢复为 `pending`，沿用原 `operation_id` 重试。
- 401 → API client 拦截 refresh 后重试一次（§3.3）。

## 10. 本地历史保留策略

- `operations`（本地历史镜像，`syncStatus` 只有 `pending` / `synced`）：只清理 **synced** 且超过保留窗口的旧记录（MVP 建议保留最近 30 天或 500 条）。
- outbox 的未决条目（`pending` / `sending` / `conflict` / `rejected`）**永不清理**（`docs/data-model.md` §6.2：不能因为缓存清理而删除）。conflict / rejected 状态只存在于 outbox，operations 不复制这两个状态。

## 11. 错误码

错误码唯一登记处为 `docs/error-codes.md`（认证域 + 同步 rejected 业务校验），前端持 `error_code → 中文文案` 映射表负责展示。

- 请求体缺字段或类型错误：FastAPI 默认 422。
- 批量请求整体格式不合法：400 `invalid_request`。
- 单条 `rejected` 为**变更级**：`results[].errors` 数组，每条 `{ entity_sync_id, error_code }`，清单见 `docs/error-codes.md` §4.2。

## 12. 未定事项

- 同步端点是否纳入 `docs/api.md`（当前 api.md 仅认证端点）。
- bootstrap 分页：MVP 已定不分页（数据量小，四表整包返回），`cursor` 编码留待分页需求出现时再定。
- Pull 响应字节精确上限（1MB）：MVP 以 `limit` 条数（上限 500）限流，不做响应字节截断；待数据量增大再实现。
- 实际部署后的真机验证：iOS PWA 独立窗口模式对 refresh cookie 的影响。
