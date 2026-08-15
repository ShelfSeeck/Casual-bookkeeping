# Casual-bookkeeping 后端 API

> 面向开发的端点参考（供 AI 与前后端联调使用），内容与实现保持一致；
> 改动端点时请同步更新本文。认证设计见 `docs/auth-structure.md`。

## 鉴权总则

- **白名单制**：默认所有端点要求有效 access token，仅 `POST /auth/login`、`POST /auth/refresh`、`POST /auth/logout` 放行。
- 认证方式：请求头 `Authorization: Bearer <access_token>`。
- 401：token 缺失、无效、过期、`token_type` 不符、验签失败。
- 403：账户停用、设备被踢（组合非 `active`）。
- access token 24h 有效，refresh token 180 天（cookie 滚动续期）。

## 统一错误格式

认证失败统一返回（`error_code` + `message` + 可选 `details`）：

```json
{ "error_code": "invalid_token", "message": "access token 无效或已过期" }
```

| error_code | HTTP | 场景 |
| --- | --- | --- |
| `invalid_credentials` | 401 | 登录失败（手机号或密码错），不泄露账户是否存在 |
| `login_blocked` | 401 | 防刷锁定（同一手机号失败 5 次 / 15 分钟） |
| `invalid_token` | 401 | token 缺失、无效、过期、类型不符、验签失败 |
| `session_revoked` | 403 | 设备被踢或组合失效，需重新登录 |
| `account_disabled` | 403 | 账户停用 |
| `invalid_request` | 400 | 手机号 / device_id 格式不合法 |

> 请求体缺字段或类型错误时返回 FastAPI 默认 422（非上述格式）。

## 端点

### POST /auth/login

手机号+密码登录，首次登录自动登记设备。

请求体：

```json
{ "phone": "13800000000", "password": "secret", "device_id": "dev-a1b2c3d4e5f6" }
```

- `phone`：11 位手机号，可带空格/`+86` 前缀（应用层统一规范化）。
- `device_id`：`dev-` 前缀 + 12 位十六进制（前端首次启动生成，重新安装才变）。

成功 `200`：

```json
{ "access_token": "<jwt>", "token_type": "Bearer" }
```

同时通过 `Set-Cookie` 下发 HttpOnly cookie `refresh_token`（`Secure` 由配置开关控制，SameSite=Lax）。

### POST /auth/refresh

用 refresh cookie 换新 access + 新 refresh（滚动续期，更新服务端 `refresh_expires_at`）。

无请求体；需携带 cookie `refresh_token`。

成功 `200`：响应体同登录，且 `Set-Cookie` 刷新 refresh cookie。

失败：
- 401 `invalid_token`：cookie 缺失 / 无效 / 过期。
- 403 `session_revoked`：设备被踢或账户停用。

### POST /auth/logout

吊销当前会话（按 refresh cookie 识别），并清除 cookie。幂等。

无请求体；需携带 cookie `refresh_token`。

成功 `204`（无响应体）。

## 业务端点身份注入

受保护端点在 handler 声明依赖 `get_CurrentAccount`，自动获得身份（`deps.py`）：

```python
from backend.deps import CurrentAccount, get_CurrentAccount

@router.get("/work-orders")
def list_orders(current: CurrentAccount = Depends(get_CurrentAccount)):
    # current.account_phone / current.device_id
```

## 聊天端点（Chat）

> 完整契约见 `docs/spec/chat-agent.md` §4/§5；错误码见 `docs/error-codes.md` §4.3。
> 同步端点（bootstrap / Push / Pull）契约见 `docs/sync-protocol.md`。
> 所有聊天端点均经 `get_CurrentAccount` 鉴权，`Authorization: Bearer <access_token>`；会话归属校验失败返回 404 `session_not_found`。

### POST /chat/sessions

创建会话。请求体 `{ "title": "7月对账" }`，成功 `200` 返回会话公共字段（`session_id` / `title` / `created_at` / `updated_at`）。

### GET /chat/sessions

当前账户会话列表，按 `updated_at` 倒序。

### GET /chat/sessions/{sid}/turns

回合历史，后端把每轮 `ModelMessage[]` 摊平成 user/assistant 文本段。游标分页参数：`after_turn_id`、`limit`（默认 50）。

### POST /chat/sessions/{sid}/turns（send / approve 双模式）

发消息 / 确认工具共用此端点；**send 与 approve 响应均为 SSE**（`text/event-stream`），事件协议见 `docs/spec/chat-agent.md` §5。

send 模式请求体：

```json
{ "turn_id": "turn-...", "message": "帮我把昨天王老板的工单改成 12 件", "allowed_tools": ["query_work_orders"] }
```

approve 模式请求体：

```json
{ "approval_request_id": "ar-...", "approved": true }
```

错误（流开始前按统一错误格式返回，不发 SSE）：

| error_code | HTTP | 场景 |
| --- | --- | --- |
| `invalid_approval` | 400 | approve 模式缺 `approved` 字段 |
| `approval_not_found` | 404 | 确认请求不存在或已处理 |
| `tool_approval_required` | 409 | 当前账户存在未处理的工具确认请求（或 `approval_request_id` 不是最新请求） |
| `session_busy` | 409 | 同账户已有回合在运行（单飞锁） |
| `session_not_found` | 404 | 会话不存在或不属于该账户 |
| `turn_not_found` | 404 | 回合不存在 |

### GET /chat/model-config

模型配置诊断（只读），返回当前生效的模型配置。
