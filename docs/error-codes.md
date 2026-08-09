# Casual-bookkeeping 错误码

> 全项目错误码的唯一登记处，前端展示与后端抛出共用。
> 后端抛出见 `backend/errors.py`；同步协议见 `docs/sync-protocol.md`；认证语义见 `docs/auth-structure.md` §2.14。

## 1. 目的与范围

- 定义全部错误码（认证域 + 同步 rejected 业务校验），供前后端引用。
- **前端持有 `error_code → 中文文案` 映射表**，负责解析与展示；服务端 `message` 仅作调试/日志兜底，不承担用户展示职责。
- 新增错误码必须先登记本文，前后端同步修改。

## 2. 响应格式

所有错误统一为：

```json
{ "error_code": "invalid_quantity", "message": "数量必须是正整数", "details": { ... } }
```

- `error_code`：机器可读，前端映射的依据。
- `message`：服务端附带的说明，用于日志与兜底展示。
- `details`：可选，补充结构化信息（如冲突的 `entity_sync_id`）。

## 3. HTTP 状态码语义

| HTTP | 场景 |
| --- | --- |
| 401 | token 缺失/无效/过期、登录失败、防刷锁定 |
| 403 | 账户停用、设备被踢（组合非 active） |
| 400 | 请求整体格式不合法 |
| 422 | 请求体缺字段或类型错误（FastAPI 默认） |
| 200 | 批量 Push 整体成功，逐条结果内的 `rejected` 携带业务错误 |

rejected 不单独占 HTTP 错误码：Push 请求返回 200，`results[]` 内逐条 `status: "rejected"` 并带 `errors`（变更级）。

## 4. 错误码清单

### 4.1 认证域（docs/auth-structure.md §3.2）

| error_code | HTTP | 含义 |
| --- | --- | --- |
| `invalid_credentials` | 401 | 登录失败（手机号或密码错），不泄露账户是否存在 |
| `login_blocked` | 401 | 防刷锁定（同一手机号失败 5 次 / 15 分钟） |
| `invalid_token` | 401 | token 缺失、无效、过期、类型不符、验签失败 |
| `session_revoked` | 403 | 设备被踢或组合失效，需重新登录 |
| `account_disabled` | 403 | 账户停用，无法登录 / 已登录会话立即失效 |
| `invalid_request` | 400 | 请求格式不合法（手机号 / device_id） |

### 4.2 同步 rejected（业务校验，变更级）

rejected 响应结构（变更级，一条操作可带多条）：

```json
{
  "operation_id": "op-...",
  "status": "rejected",
  "errors": [
    { "entity_sync_id": "sync-0003", "error_code": "invalid_quantity" },
    { "entity_sync_id": "sync-0007", "error_code": "customer_mapping_invalid" }
  ]
}
```

#### 通用（跨表）

| error_code | 触发 |
| --- | --- |
| `entity_not_found` | 目标记录不存在或已软删（update/delete 引用） |
| `operation_id_conflict` | operation_id 已存在但 request_hash 不同（拒绝复用） |

#### 工单 `work_orders`

| error_code | 触发 |
| --- | --- |
| `invalid_quantity` | 数量非正整数 |
| `invalid_unit` | 单位为空 |
| `invalid_unit_price` | 单价为负 |
| `service_item_mismatch` | 小类不属于所选大类 |
| `service_option_disabled` | 服务大类/小类已停用 |
| `customer_not_found` | 客户不存在或已归档 |
| `customer_mapping_invalid` | 该业务日期无有效编号映射 |

#### 客户 `customers`

| error_code | 触发 |
| --- | --- |
| `invalid_customer_name` | 名称为空 |

#### 编号映射 `customer_code_mappings`

| error_code | 触发 |
| --- | --- |
| `mapping_period_overlap` | 同编号不同有效期重叠 |
| `invalid_mapping_period` | `valid_to < valid_from` |

#### 服务选项 `service_categories`

| error_code | 触发 |
| --- | --- |
| `category_name_duplicate` | 同账户大类重名 |
| `invalid_subcategories` | 小类 JSON 格式不合法 |
| `subcategory_name_duplicate` | 小类 JSON 内重名 |

## 5. 前端映射与展示

- 前端维护 `error_code → 中文文案` 映射表，收到错误后解析并展示（如 `invalid_quantity` → "数量必须是正整数"）。
- rejected 为变更级：前端遍历 `errors[]`，结合 `entity_sync_id` 定位具体记录，把用户引导到出错的那条修正。
- 未在映射表中的错误码：展示 `message` 兜底。

## 6. 维护规则

- 新增/修改/删除错误码时同步更新：本文、`backend/errors.py`、前端映射表。
- 认证错误码变化同时更新 `docs/auth-structure.md` §3.2。
