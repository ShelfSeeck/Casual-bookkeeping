# AcS AI 对话存储

> 自 `docs/data-model.md` 原“AI 对话存储”一章拆出，独立描述 AI 会话与回合的存储结构，供后端 Agent 会话持久化使用。

## 1. 存储位置与权威来源

后端 SQLite 是唯一权威来源，前端只缓存。

```text
账户 → chat_sessions → chat_turns
```

## 2. `chat_sessions`

**一行表示一个独立会话。**

| 列名 | 类型 | 含义 |
| --- | --- | --- |
| `session_id` | TEXT | 主键 |
| `owner_user_id` | TEXT | 所属账户，仅供后端鉴权 |
| `title` | TEXT | 会话标题 |
| `created_at` | TEXT | 创建时间 |
| `updated_at` | TEXT | 最后活动时间 |

## 3. `chat_turns`

**一行表示一次完整的 Agent 运行。**

| 列名 | 类型 | 含义 |
| --- | --- | --- |
| `turn_id` | TEXT | 主键，同时作为请求幂等 ID |
| `session_id` | TEXT | 所属会话 |
| `messages_json` | TEXT | 本轮完整的 Pydantic AI `ModelMessage[]` JSON |
| `created_at` | TEXT | 创建时间 |
| `updated_at` | TEXT | 最后更新时间 |

## 4. 规则

- 使用 `new_messages_json()` 保存成功完成的回合，使用 `ModelMessagesTypeAdapter` 加载历史。
- 重试复用同一个 `turn_id`，成功后直接替换该行内容，不保留旧版本。
- 对话存储与业务操作及回滚机制相互独立。
- 成功的 AI 业务修改由 `database_operations.source_turn_id` 关联回对话回合。
- 不需要 `ai_runs` 或 `ai_pending` 表；草案返回前中断可重新请求，确认并 Push 后中断由幂等和 Pull 判断。
