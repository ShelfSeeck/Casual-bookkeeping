# 记账助手对话 Agent（MVP）spec

> 面向开发与前后端联调的接口设计。范围：后端可运行的对话助手 + 业务工具与确认握手（**现状已实现**，见 `docs/spec/agent-tools.md`；MVP 历史描述保留并逐项标注）。
> 相关文档：`docs/ai-chat-storage.md`（会话/回合存储）、`docs/data-model.md`（AI 操作草案与确认）、`docs/error-codes.md`（错误码登记）、`docs/api.md`（端点约定）、`docs/sync-protocol.md`（同步）、`docs/spec/agent-tools.md`（工具与确认握手实现）。

## 1. 目的与范围

### 目标

搭一个可用的记账助手对话骨架：用户创建会话、发消息、后端用 Pydantic AI 跑一个回合、SSE 流式返回、回合落库。**现状（2026-08-15）**：工具调用与确认握手已实现——7 个业务工具（5 读 + 2 写草案）接入，写草案暂停等待前端确认后 resume；详见 `docs/spec/agent-tools.md`。以下 MVP 历史描述保留要点并标注现状。

### 范围

- 后端：会话/回合仓库、Agent 构建（Pydantic AI 内循环）、SSE 流式、按账户单飞锁、模型配置热读、业务工具与确认握手（已实现，见 `docs/spec/agent-tools.md`）。
- 接口：4 个聊天端点 + 1 个模型诊断端点，含 SSE 事件协议与回合摊平展示格式。
- 前端：接口契约已定；数据层 `chatApi` / `chatApproval` 已实现，确认 UI 仍未实现（见 `docs/spec/agent-tools.md` §8）。

### 不做（MVP 明确排除）

- regenerate / stop、状态机图引擎（Learnova 式外层循环）。
- 业务工具与 `tool_confirm_request` 的触发：MVP 原列为不做；**现状已实现**（`docs/spec/agent-tools.md`）。
- 会话重命名 / 删除、附件、markdown 富渲染（前端后续做）。
- 前端本地缓存对话：AI 会话以后端为权威，前端纯在线，不走离线优先。

### 核心原则

- **内循环用 Pydantic AI**：工具调用循环（模型→工具→结果→再调模型）由 `run_stream_events` 黑盒完成，不手写循环。
- **后端工具永不落库**：AI 写业务数据走「前端确认 → outbox → Push」链路，后端 agent 不直接写库（§6）。

## 2. 架构决策

| 决策 | 结论 |
| --- | --- |
| 外层编排 | 不做状态机图，直接端点 → Agent → SSE |
| 内循环 | Pydantic AI `agent.run_stream_events()` |
| 单飞锁 | **按账户**（同一 `account_phone` 同时只跑一个回合，跨会话） |
| 工具 | `register_tool` 注册表 + `build_tools(allowed=...)` 过滤；**现状：7 个业务工具**（5 读 + 2 写草案，见 `docs/spec/agent-tools.md` §4） |
| 流式 | SSE（`text_delta` / `tool_call` / `tool_result` / `tool_confirm_request` / `done`） |
| 确认 | `tool_confirm_request`（方案 B：确认握手，后端不执行写库）——**现状已实现**（send 暂停 → 部分回合落库 → approve 续跑） |
| 模型配置 | `config.toml [model]`，每次运行热读，无 env 覆盖 |
| 存储 | `chat_sessions` / `chat_turns`（§3） |

## 3. 存储

沿用 `docs/ai-chat-storage.md`，建表 SQL 已在 `backend/src/backend/data/schema/chat/`。

### 3.1 `chat_sessions`

| 列名 | 类型 | 含义 |
| --- | --- | --- |
| `session_id` | TEXT | 主键，服务端生成（uuid） |
| `account_phone` | TEXT | 所属账户，鉴权归属 |
| `title` | TEXT | 会话标题（创建时必填） |
| `created_at` / `updated_at` | TEXT | 创建 / 最后活动时间 |

### 3.2 `chat_turns`

| 列名 | 类型 | 含义 |
| --- | --- | --- |
| `turn_id` | TEXT | 主键，同时作幂等 ID（前端生成 uuid） |
| `session_id` | TEXT | 所属会话 |
| `messages_json` | TEXT | 本轮完整 Pydantic AI `ModelMessage[]` JSON |
| `created_at` / `updated_at` | TEXT | 创建 / 最后更新时间 |

### 3.3 落库规则

- 回合**成功完成后**才用 `new_messages_json()` 保存；重试复用同一个 `turn_id`，成功后直接覆盖该行，不保留旧版本。
- 草案确认暂停时，先以 `turn_id` 保存部分回合（供 resume 加载续跑），成功后整体覆盖；暂停前的中断可重新请求（同 `turn_id` 幂等重放），不需要 `ai_runs` / `ai_pending` 表。
- AI 写操作由 `database_operations.source_turn_id` 关联回本回合（`actor_type=ai`）。

## 4. HTTP 接口

- 鉴权沿用白名单制：所有端点经 `get_CurrentAccount`，`Authorization: Bearer <access_token>`。
- 错误统一格式 `{error_code, message, details?}`（§7 错误码；SSE 阶段错误挂在 `done` 帧，见 §5）。
- 归属校验：`sid` 必须属于当前账户，否则 404 `session_not_found`（不泄漏存在性）。

### 4.1 POST /chat/sessions

创建会话。

请求体：

```json
{ "title": "7月对账" }
```

成功 `200`：

```json
{ "session_id": "s-...", "title": "7月对账", "created_at": "...", "updated_at": "..." }
```

### 4.2 GET /chat/sessions

会话列表，按 `updated_at` 倒序。

成功 `200`：

```json
{ "sessions": [ { "session_id": "s-...", "title": "7月对账", "created_at": "...", "updated_at": "..." } ] }
```

### 4.3 GET /chat/sessions/{sid}/turns

回合历史，**后端把每轮 `ModelMessage[]` 摊平成展示段**返回，前端不认识也不应认识 Pydantic AI 内部结构。

- 查询参数：`after_turn_id`（游标，返回该回合之后的回合，不含自身）、`limit`（默认 50）。
- 按 `created_at` 升序；无更多回合时 `next_cursor` 为 `null`。

```json
{
  "turns": [
    {
      "turn_id": "turn-...",
      "created_at": "...",
      "messages": [
        { "role": "user", "content": "帮我把昨天王老板的工单改成 12 件", "type": "text" },
        { "role": "assistant", "content": "好的，我把 **#A-003** 的件数改为 12。\n\n| 字段 | 原值 | 新值 |\n| --- | --- | --- |\n| 件数 | 10 | 12 |", "type": "text" }
      ]
    }
  ],
  "next_cursor": "turn-002"
}
```

- `role ∈ {user, assistant}`；assistant 的 `content` 为 **markdown 文本**（前端负责富渲染）。
- `type` 默认 `text`，为未来工具/草案预留：`{role, type: "tool_call", tool_name}`、`{role, type: "draft", draft}` 等，接口不破。
- 每段携带 `content_length` 元数据（当前隐藏，虚拟滚动需求时暴露为索引端点字段，见 §11）。

### 4.4 POST /chat/sessions/{sid}/turns

发消息 / 确认工具。两种模式共用此端点，响应均为 `text/event-stream`。

#### 模式 A：send（发消息）

```json
{ "turn_id": "turn-...", "message": "帮我把昨天王老板的工单改成 12 件", "allowed_tools": ["query_work_orders"] }
```

- `turn_id`：前端生成 uuid，幂等；重试复用同一值。
- `allowed_tools`：可选，本轮允许的工具白名单；send 模式按其过滤工具（缺省/`null` 用完整工具集）。approve resume 不使用该字段，使用完整工具集（已知近似，见 §11）。
- 命中单飞锁（同账户已有回合运行）→ 409 `session_busy`。

#### 模式 B：approve（确认工具）

```json
{ "approval_request_id": "msg-...", "approved": true }
```

- `approval_request_id`：`tool_confirm_request` 事件里的 `request_id`。
- `approved: true` → 握手工具执行（不写库），agent 继续本回合收尾；`false` → 该工具以「用户拒绝」回传模型，agent 继续。
- `request_id` 不是最新未处理请求 → 409 `tool_approval_required`；已处理 → 404 `approval_not_found`。

### 4.5 GET /chat/model-config

模型配置诊断（只读）。返回当前生效配置，便于确认热改是否生效。

```json
{ "model_name": "deepseek-chat", "base_url": "https://api.deepseek.com", "api_key_configured": true }
```

## 5. SSE 协议

每个事件一个 `data: {json}\n\n` 帧。`Content-Type: text/event-stream`。

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `text_delta` | `{ "type": "text_delta", "content": "..." }` | 模型输出文本增量，逐帧推送 |
| `tool_call` | `{ "type": "tool_call", "tool_name": "..." }` | 工具调用开始（协议保留；当前 `ChatService` 不转发，读工具在内循环执行） |
| `tool_result` | `{ "type": "tool_result", "tool_name": "...", "status": "success"\|"error" }` | 工具执行结束（协议保留；当前不转发） |
| `tool_confirm_request` | `{ "type": "tool_confirm_request", "request_id": "...", "tool_call_id": "...", "tool_name": "...", "draft": { ... } }` | 写工具暂停待确认；`draft` 即工具参数（§6） |
| `done` | `{ "type": "done", "turn_id": "...", "error": { "error_code": "...", "message": "..." } \| null }` | 结束帧；成功时 `error` 为 `null` |

- 前端用 **fetch + ReadableStream** 解析流（POST 不支持 `EventSource`）。
- `done` 前中断：SEND 模式带 `turn_id` 重试，幂等重放；approve 模式可携 `approval_request_id` 重发。
- HTTP 层错误（会话不存在、锁占用等）在流开始前按统一错误格式直接返回，不发 SSE。

## 6. 确认握手机制（草案协议对准）

### 6.1 流程

```
写工具(requires_approval) → agent 暂停 → SSE tool_confirm_request(draft=工具参数)
→ 前端渲染「查看更改」确认框 → 用户点确认 → 前端同时：
   ① 写 Dexie（业务表 + operations + outbox；来源字段由前端确认时补齐，见 §6.2）
   ② 触发同步 Push
   ③ POST approve {approval_request_id, approved: true}
→ 后端握手工具执行（不写库）→ agent 收尾本回合 → done
```

### 6.2 协议对准

- 工具的**参数 schema 即草案 schema**（`operation_type` + `changes[]` + `base_version`），`tool_confirm_request.draft` 原样携带工具参数——前端展示的「具体更改内容」与后端将要提交的是同一份数据，无需另设草案格式。
- 运行时来源字段（`operation_id` / `actor_type=ai` / `source_turn_id`）由前端确认时补齐（`docs/spec/agent-tools.md` §4.3/§8）；工具参数本身不含这些字段，避免模型编造 ID。
- 后端握手工具**永不落库**：权威写入只经前端 outbox → Push 链路（`docs/data-model.md` §7.2）。`operation_id` 幂等保证重复 Push 只生效一次，Pull 收敛。
- 安全理由：即使前端漏渲染了确认请求（用户未看到具体更改），没有确认按钮就没有任何写操作——「未知情不动手」。这也是与 Learnova「确认后 agent 直接写库」的关键差异。

## 7. 错误码

新增「聊天域」，登记入 `docs/error-codes.md`（§4.3），并同步 `backend/errors.py` 常量与前端映射表。

| error_code | HTTP | 含义 |
| --- | --- | --- |
| `session_busy` | 409 | 同一账户已有回合在运行（单飞锁） |
| `session_not_found` | 404 | 会话不存在或不属于该账户 |
| `turn_not_found` | 404 | 回合不存在 |
| `invalid_approval` | 400 | 确认请求缺 `approved` 字段 |
| `approval_not_found` | 404 | 确认请求不存在或已处理 |
| `tool_approval_required` | 409 | 当前账户存在未处理的工具确认请求（send 先处理再发新消息）；或 approve 的 `approval_request_id` 不是最新未处理请求 |
| `model_config_missing` | 500 | `config.toml` 未配置 `[model]` |
| `model_build_failed` | 500 | Agent 构建失败 |
| `model_authentication_error` | 502 | 模型服务认证失败（api_key 错误） |
| `model_quota_limit_error` | 429 | 模型额度不足 / 频率限制 |
| `model_network_error` | 502 | 模型服务网络 / 超时 |
| `model_call_failed` | 500 | 模型调用失败（通用） |

模型类错误映射参考模型异常类型与状态码判定；流内错误以 `done.error` 携带上述 `error_code`。

## 8. 模型配置

- 存放于 `config.toml` 的 `[model]` 段：

```toml
[model]
model_name = "deepseek-chat"
base_url = "https://api.deepseek.com"
api_key = "sk-..."
```

- **热读**：每次构建 Agent 时重新读 `config.toml`（不缓存），与现有 `Settings` 惰性单例分离（`Settings` 缓存整文件，仅适合启动期配置）。改 `model_name` / `base_url` / `api_key` 后**下一回合即生效**，无需重启。
- **无 env 覆盖**。`api_key` 写入 `config.toml` 是对「敏感项走 env」约定的**有意识豁免**：`config.toml` 已被 `.gitignore` 排除（仓库只留 `config.example.toml`），单机个人工具可接受；此豁免已记录在本 spec，改动时需重新评估。
- 诊断端点 `GET /chat/model-config` 返回当前生效值（§4.5）。

## 9. 后端实现分层

遵循现有 backend 约定（`data/` → `repositories/` → `deps.py` → `services/` → `routers/` → `main.py`，仓库层不 import FastAPI）。

| 层 | 新增文件 | 职责 |
| --- | --- | --- |
| data | 无（建表 SQL 已存在） | — |
| repositories | `repositories/chat_sessions.py`、`repositories/chat_turns.py` | 会话/回合的受控读写；`account_phone` 归属校验、`turn_id` upsert、按游标分页取回合 |
| services | `services/model_config.py` | `get_ActiveModelConfig()`：每次重读 `config.toml [model]` |
| services | `services/business_query.py` | `BusinessQueryService`：四个业务仓库的只读查询门面（供 Agent 工具使用，见 `docs/spec/agent-tools.md` §6） |
| services | `services/prompts.py` | Agent 系统指令：先查后改、只能通过写草案工具提议、必须等用户确认 |
| services | `services/agent.py` | 构建 Pydantic AI Agent：模型来自 `get_ActiveModelConfig()`，工具来自 `build_tools(allowed)`，`deps_type=BusinessToolDeps`，`output_type=[str, DeferredToolRequests]` |
| services | `services/chat.py` | 编排：单飞锁（按 `account_phone`，进程内 `asyncio.Lock` 字典）、`run_stream_events` 事件转发、send 暂停（部分回合落库 + `tool_confirm_request`）/ approve 续跑（整体覆盖落库）/ 恢复 |
| tools | `tools/registry.py` | `register_tool` 注册表（`requires_approval` 元数据）+ `build_tools(allowed)` 白名单过滤；**现状已实现** |
| tools | `tools/business_tools.py` | 7 个业务工具（5 读 + 2 写草案），见 `docs/spec/agent-tools.md` §4 |
| routers | `routers/chat.py` | 4 个聊天端点 + 模型诊断端点，`Depends(get_CurrentAccount)`；`POST /turns` send/approve 双模式 + `preflight_Send` |
| deps | `deps.py` | `get_ChatSessionsRepository` / `get_ChatTurnsRepository` / `get_ChatService` / `get_BusinessQueryService` |
| errors | `errors.py` | 新增聊天域错误常量 |
| main | `main.py` | `include_router(chat_router.router)` |

单飞锁说明：键为 `account_phone`（非会话），与 `get_CurrentAccount` 返回的身份一致；锁占用时新请求立即 409 `session_busy`，不排队。

## 10. 测试策略

沿用 pytest + `tmp_path`（`conftest.py` 的 `database`/`connection` fixture），只测公共接口：

- 建表：`chat_sessions` / `chat_turns` 已建（补测）。
- 仓库：会话创建 / 归属校验 / 列表排序；回合 upsert（幂等覆盖）、游标分页。
- 模型配置：`get_ActiveModelConfig()` 热读（改文件立即反映）、缺 `[model]` 抛 `model_config_missing`。
- Agent 服务：用 `TestModel` override 固定模型输出，断言 SSE 事件序列（`text_delta` → `done`）；单飞锁并发行为；`tool_confirm_request` 事件与错误码（`approval_not_found` / `tool_approval_required` / `invalid_approval`）。
- 确认握手：已实现；用 FakeAgent/FakeRun 与测试工具桩验证 send 暂停 → 部分回合落库 → approve 续跑 → 握手工具不写库 → done 整体覆盖落库（见 `tests/chat/`）。
- 业务工具：读工具用 `tmp_path` SQLite 造数直接断言；写草案用 `FunctionModel` 断言暂停与 `DeferredToolRequests`（见 `tests/services/test_agent_tools.py`）。

## 11. 未定与后续

- 虚拟滚动：长会话加「区块索引端点」（`digest` / `content_length` / `estimated_height`），前端按需拉正文；当前 `turns` 接口已带游标与 `content_length` 元数据，直接扩即可。
- ~~读工具：`query_work_orders` / `query_customers` 等只读工具，接现有业务仓库。~~ **现状：已实现**（`tools/business_tools.py` + `BusinessQueryService`）。
- ~~写工具 + 草案确认完整链路：`DeferredToolRequests` resume、`tool_confirm_request` 真实触发、前端确认框与 outbox/Push 联调。~~ **现状：后端已实现**（send 暂停 / approve 续跑 / 重启恢复）；前端 `chatApi` / `chatApproval` 接口已就绪，**确认 UI 与页面联调仍未做**（本期无 UI）。
- resume 语义深化：确认且同步成功后，同一回合内由 agent 汇报同步结果（当前不 resume 汇报，回合在握手后即收尾）。
- 已知近似（登记在 `AGENTS.md` 未定事项）：approve resume 使用完整工具集（`allowed_tools` 不生效）；resume 中若模型再次发起写草案不会再次暂停（直接收尾）。
- 会话标题自动生成（当前创建时必填）。
