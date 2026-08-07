# AcS 认证与设备管理设计

> 本文是认证系统（账户、设备、会话、token）的设计文档，本会话逐项确认后落地。未定内容登记在 `AGENTS.md` 的"未定事项"或本文"未定事项"。

## 1. 文档目的与边界

- 定义账户、设备、登录会话、token 生命周期，供 Vue/PWA、FastAPI/SQLite 和后台管理脚本使用。
- 认证只解决"谁能访问同步和后端服务"，**不控制本地记账**（本地 Dexie 完全离线可用）。
- 本文只收录已定内容；未定内容见文末。

## 2. 核心决策（已确认）

### 2.1 账户模型

- **认证层多账户**，业务数据按账户隔离。
- 业务隔离采用 **B 方案**：所有账户共用同一套业务表 schema，每张业务表加 `account_phone` 列，写入强制带、查询强制过滤。不为每个账户动态建表。
- **MVP 只开两个账户**：一个测试、一个生产。
- 业务表隔离是硬隔离：账户之间数据互不可见，`account_phone` 贯穿四张业务表。

### 2.2 账户标识与密码

- 账户标识 = **手机号**，手机号作账户主键（TEXT）。
- 登录方式：**手机号 + 密码**，MVP 不做短信验证码。
- 密码哈希：**Argon2id**，`accounts` 表存哈希不存明文。
- MVP 只支持中国大陆 11 位手机号，不做国际区号分区；应用层统一存储格式（去空格/`+86` 前缀）。

### 2.3 设备模型

- 设备 = 一个 PWA 安装实例，以 `device_id` 标识。
- 设备表是 **授权语义（受信任设备清单）**，首次登录自动登记，可手动踢出；MVP 不设审批流程。
- **一台设备可登录多个账户**，同时只能登一个；切换账户需重新登录，`sync_state` 按账户各存一份。

### 2.4 认证边界

- 认证只在**要同步**和**依赖后端服务**（如 AI 对话）时需要。
- 本地记账、查询完全离线可用；token 过期或失效**不清空、不锁死**本地数据。token 只是同步的钥匙，不是数据的锁。

### 2.5 Token 范式

- 双层 token：**access token** + **refresh token**，两者均为 JWT，claims 携带 `phone` + `device_id` + `token_type` + `exp`。
- `token_type`：access 为 `"access"`，refresh 为 `"refresh"`；鉴权依赖校验 `token_type == "access"`，refresh 端点校验 `token_type == "refresh"`，防止 refresh 被误当 access 使用。
- 具体有效期：**access 24 小时 + refresh 180 天**。使用节奏为天天记、天天同步，离线概率低。
- **吊销靠信任状态表，不存 token**：`account_devices` 表记录 `(account_phone, device_id)` 组合是否有效；踢出设备 = 将该行标记失效或删除。refresh 请求验签后必须查表确认组合仍有效，被踢即拒绝。
- 吊销粒度是"(账户, 设备)"而非单个 token，对"一个设备一个会话"的模型完全等价。
- 过期时间双存：JWT `exp`（验签判断）+ 表 `refresh_expires_at`（供清理过期会话脚本使用），刷新时滚动续期两处同步更新。

### 2.6 前端 token 存储

- **同域部署**（PWA 与后端同一域名）。
- **access token 存 localStorage**（打开即用，XSS 偷到也只有 24h 有效期），**refresh token 存 HttpOnly + Secure cookie**（JS 读不到，XSS 偷不走）。
- 已知风险：iOS PWA 独立窗口模式下 cookie 与 Safari 存储分离，且 ITP 可能清除长期未用的 cookie；本项目天天同步，实际影响低，登记为待验证事项。

### 2.7 标识生成

- `device_id`：前端首次启动生成，本地持久化（IndexedDB），重新安装 PWA 才变；后端首次登录自动登记进设备表。
- `sync_id`：创建记录的一方生成（前端离线新增由客户端生成，AI/后端新增由服务端生成）。
- `operation_id`：发起业务动作的一方生成。
- `turn_id`：AI 回合发起时生成，同时作为请求幂等 ID。
- 统一格式：**业务前缀 + `uuid4().hex[:12]`**（12 位十六进制）。前缀对应：`dev-`（device_id）、`sync-`（sync_id）、`op-`（operation_id）、`turn-`（turn_id）。

### 2.8 登录、刷新、登出 API

| 端点 | 职责 |
| --- | --- |
| `POST /auth/login` | 手机号+密码校验 → 查/建 `account_devices`（首登自动登记）→ 生成 access + refresh（均 JWT）→ refresh 写 cookie、access 返回前端 |
| `POST /auth/refresh` | 读 cookie refresh → 验签 + 查 `account_devices` 确认组合有效 → 生成新 access + 新 refresh（滚动续期，更新 `refresh_expires_at`） |
| `POST /auth/logout` | 删除当前 `(account, device)` 会话行 + 清 cookie；不删同设备其他账户会话 |

**切换账户** = 先登出当前账户再登录目标账户，旧会话保留。

### 2.9 本地数据隔离

- **不做本地数据加密**：密钥无法安全落地，且真正威胁（能解锁手机的人）加密挡不住，反而引入数据不可恢复风险。
- **每账户独立的 IndexedDB 数据库**（如 `db_<phone>`）：切换账户 = 打开另一个数据库，物理隔离，互不可见。
- **登出保留本地库**：登出只断开会话，数据留在本地；重新登录同一账户直接恢复，无需重新 bootstrap。
- 配合 `sync_state` 按 `account_phone` 主键，每账户维护独立同步进度。

### 2.10 鉴权执行边界

- **白名单制**：FastAPI 全局鉴权依赖，默认所有端点要求有效 access token，仅 `POST /auth/login`、`POST /auth/refresh`、`POST /auth/logout` 三个端点放行。
- 认证守卫所有依赖后端的功能：同步（bootstrap、Push、Pull）、AI 对话等。

### 2.11 登录防刷

- **失败次数限速**：同一手机号登录失败 5 次后锁定 15 分钟（仅手机号维度，不做 IP 计数，避免内网 NAT 共享出口 IP 误伤）。
- 计数放**内存**，不建表（进程重启即重置，可接受）。
- MVP 不做图形/短信验证码（等以后加短信验证码登录时一并考虑）。

### 2.12 后台管理脚本

- 形态：单个 CLI（`acs-manage`，argparse 子命令），仅后端本机使用，不走 API 认证。已实现子命令：`add-account`、`add-device`、`set-password`、`set-account-status`、`list-devices`、`revoke-device`。
- 职责 **A + B**：
  - 账户：创建、改密码、停用/启用（重置密码与列出账户未做，MVP 不急需）。
  - 会话/设备：列出某账户的设备、强制踢出某设备（清理过期会话未做）。
- 密码处理：`add-account` / `set-password` 接收明文密码，用 Argon2id 哈希后入库（复用 `AccountsRepository` + `PasswordService`，不存明文）。
- MVP 不做登录审计日志。
- **删除账户 = 停用**：`accounts` 加 `status` 字段（如 `active` / `disabled`），停用后无法登录、已登录会话立即失效（踢掉），数据全部保留，可逆。不做物理删除。

### 2.13 认证相关表集合

**认证层 2 张表**：`accounts` + `account_devices`。

受影响但属已有层（不加新表）：
- `database_operations`、`chat_sessions`：鉴权列统一为 `account_phone`，存账户手机号。
- 四张业务表：各加 `account_phone` 列（B 方案隔离）。
- `sync_state`（前端）：`account_phone` 主键。

不建表：登录防刷用内存计数。

### 2.14 其他模块接入契约

**鉴权依赖**：FastAPI 用依赖注入（`Depends`）提供 `get_current_account`，业务端点声明依赖后自动获得已解析的 `account_phone`（可选 `device_id`）。校验链：
1. 从 Authorization 头读取 access JWT
2. 验签 + 校验过期（`exp`）
3. 校验 `token_type == "access"`
4. 解析出 `phone`、`device_id`
5. 查 `account_devices` + `accounts` 确认设备组合与账户均为 `active`（实现优先用一次 JOIN 查询完成两步校验，一次 DB 往返）
6. 注入 `account_phone`

> 注：JWT claims 使用短名 `phone`，数据库字段统一为 `account_phone`，两者对应关系在文档第 7 节说明。不缓存解码结果，踢出机制要求每次鉴权实时查表。

**同步模块**（bootstrap / Push / Pull）：声明鉴权依赖，以注入的 `account_phone` 过滤数据，只返回当前账户的业务数据。

**AI 模块**：AI 从不直接写数据库，只生成操作草案；写入由用户确认后前端 Push 完成，Push 携带 access JWT，服务端以注入的 `account_phone` 记录所属账户。AI 读数据也发生在已认证的对话请求内，账户同样来自该请求的 access。因此**前端与 AI 均不额外传账户，身份唯一来源是鉴权依赖注入**。AI 不跨账户读取或修改。

**管理脚本**：仅在后端本机使用，直接操作 SQLite，不走 API 认证；后期可开发管理界面替代。

**401 vs 403**：
- 401：token 缺失、无效、过期、`token_type` 不符、验签失败。
- 403：账户被停用（`status == disabled`）、设备被踢（组合非 `active`）。
- 登录失败（密码错）与防刷锁定返回 401（不泄露账户是否存在）。

### 2.15 实现结构（依赖注入）

认证逻辑已按"仓库层纯净、服务层组合、deps 唯一接线"落地：

| 文件 | 职责 |
| --- | --- |
| `repositories/accounts.py`、`account_devices.py` | 账户/设备表的受控读写；`get_ActiveSession` 一次 JOIN 完成"设备组合 + 账户"双校验（§2.14 第 5 步） |
| `services/password.py` | Argon2id 哈希/校验 |
| `services/token.py` | JWT 签发/验签（access/refresh），时钟可注入 |
| `services/rate_limiter.py` | 登录防刷内存计数（§2.11），时钟可注入 |
| `services/auth.py` | `AuthService` 门面：login / refresh / logout |
| `deps.py` | 唯一 FastAPI 接线层：`get_AuthService`、`get_CurrentAccount`（全局守卫）、`AUTH_WHITELIST` |
| `routers/auth.py` | `POST /auth/login` / `refresh` / `logout`，refresh 写 HttpOnly cookie |
| `errors.py` | 统一错误 schema + 全局异常处理器（§3.2） |

注入约定：服务构造器全部注入依赖（仓库、密钥、TTL、时钟、限流参数），测试通过
`dependency_overrides` 替换 DB 与时钟，业务逻辑零 mock 走真实链路。

## 3. 测试计划

### 3.1 分层与范围
| 层 | 内容 | MVP 范围 | 状态 |
| --- | --- | --- | --- |
| A 单元测试 | 手机号规范化、密码哈希校验、access/refresh 签发验签、过期判断、防刷计数 | 必做 | 已完成（缝 6） |
| B 接口测试 | 登录/刷新/登出全链路、踢出失效、停用即踢、鉴权白名单、防刷锁定 | 必做 | 已完成（缝 7） |
| C 管理脚本测试 | 创建账户、改密码、停用/启用、列出/踢出设备 CLI 行为 | 值得做 | 已完成（缝 5） |
| D 前端测试 | token 存取、切换账户库、登出保留数据 | 缓做 | 缓做 |

工具：pytest + FastAPI TestClient + 临时 SQLite。

### 3.2 错误响应约定

- 认证错误返回格式**已落地**：统一 `AppError`（`error_code` + `message` + 可选 `details`），
  FastAPI 全局异常处理器转 JSON，实现在 `backend/errors.py`；认证层先落地，后期其他模块复用。
- 错误码清单与 HTTP 状态码映射（401 vs 403 语义见 §2.14）：

| error_code | HTTP | 含义 |
| --- | --- | --- |
| `invalid_credentials` | 401 | 登录失败（手机号或密码错），不泄露账户是否存在 |
| `login_blocked` | 401 | 防刷锁定（同一手机号失败 5 次 / 15 分钟） |
| `invalid_token` | 401 | token 缺失、无效、过期、类型不符、验签失败 |
| `session_revoked` | 403 | 设备被踢或组合失效，需重新登录 |
| `account_disabled` | 403 | 账户停用，无法登录 / 已登录会话立即失效 |
| `invalid_request` | 400 | 登录请求格式不合法（手机号 / device_id） |

### 3.3 单元测试用例清单（A 层）

1. 手机号规范化：`138 0000 0000` / `+8613800000000` → `13800000000` ✅
2. 密码哈希：Argon2id 校验通过/失败、同一密码两次哈希不同 ✅
3. access JWT：签发含 `phone` + `device_id` + `exp`；验签通过/伪造签名拒绝 ✅
4. refresh JWT：同样含 `phone` + `device_id` + `exp`；验签通过/伪造拒绝 ✅
5. 过期判断：`exp` 已过期 / 未过期边界 ✅
6. 防刷计数：失败计数、锁定阈值、锁定到期自动解锁、按 key 隔离 ✅

### 3.4 接口测试用例清单（B 层）

1. 登录成功 → 返回 access + 设置 refresh cookie ✅
2. 登录失败（密码错）→ 401，且记一次失败 ✅
3. 防刷：连续失败 5 次 → 第 6 次即使密码对也锁定 ✅
4. 刷新：有效 refresh → 新 access + 新 refresh（滚动）✅
5. 刷新：被踢出设备的 refresh → 拒绝 ✅
6. 刷新：过期 refresh → 拒绝 ✅
7. 登出 → 会话删除，refresh 不能再刷新 ✅
8. 未认证请求业务端点 → 401 ✅
9. access 过期 → 401 ✅
10. 停用账户 → 已登录会话立即失效 ✅
11. 手机号未规范化输入（带空格/`+86`）→ 登录仍成功（应用层规范化）✅
12. 两台设备同账户 → 两个独立会话、各自登录不受影响 ✅

## 4. 术语表

| 术语 | 含义 |
| --- | --- |
| Account | 一个登录身份，以手机号唯一标识；业务数据按账户隔离 |
| Device | 一个 PWA 安装实例，以 `device_id` 标识 |
| Device Session | 一个账户在某台设备上的登录会话；服务端以 `(account_phone, device_id)` 组合行记录信任状态，token 为 JWT 不落库，一行 = 账户 × 设备 |
| 认证边界 | 认证只守卫同步与后端服务，不控制本地记账数据 |
| account_phone | 全项目统一的账户引用字段名（`accounts.phone`、业务表隔离列、`sync_state` 主键、`database_operations`/`chat_sessions` 鉴权列），值存账户手机号 |

## 5. 数据模型（草案）

**存储位置**：认证表与业务表、操作历史、AI 会话存储于**同一个 SQLite 数据库文件**（后端唯一库）。不拆库，原因：鉴权依赖需要 JOIN `accounts` + `account_devices`，业务写入需按 `account_phone` 过滤业务表，跨库会引入不必要的复杂度。

### 5.1 `accounts`

**一行含义：一个可登录的账户。**

| 列名 | 类型 | 含义 |
| --- | --- | --- |
| `phone` | TEXT | 主键，账户唯一标识，规范化后的 11 位手机号 |
| `password_hash` | TEXT | Argon2id 哈希 |
| `status` | TEXT | `active` / `disabled`；停用后无法登录、已登录会话立即失效 |
| `created_at` | TEXT | 创建时间 |
| `updated_at` | TEXT | 最后修改时间 |

### 5.2 `account_devices`

**一行含义：一个账户在某台设备上的登录会话的信任状态。**

| 列名 | 类型 | 含义 |
| --- | --- | --- |
| `account_phone` | TEXT | 主键一部分，所属账户（= `accounts.phone`） |
| `device_id` | TEXT | 主键一部分，登录设备标识 |
| `status` | TEXT | `active` / `revoked`；踢出 = 置 `revoked` 或删除 |
| `refresh_expires_at` | TEXT | refresh token 过期时间（= 最后登录/刷新时间 + 180 天），供清理过期会话 |
| `created_at` | TEXT | 首次登记时间 |
| `last_active_at` | TEXT | 最后活跃时间 |

约束：`(account_phone, device_id)` 组合主键，同一账户在同一设备同时只存在一个会话。token 本身不落库，验签后查本表确认组合有效。

## 6. 未定事项

- iOS PWA 独立窗口模式对 HttpOnly cookie 的实际影响（需真机验证）。
- 登录 / 踢出 / 换账户与 `sync_state` 的具体联动流程。
- 后续可加能力：短信验证码登录、设备审批流程。

## 7. 术语统一

账户引用字段全项目统一为 `account_phone`，值存账户手机号。涉及：
- `accounts.phone`（主键）
- 四张业务表隔离列
- `sync_state` 主键（前端）
- `database_operations`、`chat_sessions` 鉴权列统一为 `account_phone`

**JWT claims 例外**： 数据库字段 `account_phone` 是同一值的两个名字。鉴权依赖解析 access 后，将 claim `phone` 映射为业务层的 `account_phone`，下游模块只见 `account_phone`。
