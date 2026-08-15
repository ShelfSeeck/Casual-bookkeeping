# 后台管理 CLI 手册（`cb-manage`）

> 面向开发与维护人员。命令只在后端本机运行、直接读写 SQLite，**不经过 FastAPI 认证**；密码会先经 Argon2id 哈希再入库，绝不存明文。

## 1. 运行方式

在 `backend/` 目录下，两种等价写法：

```bash
# 方式 A：直接运行模块
.venv/bin/python -m backend.scripts.manage <子命令> ...

# 方式 B：安装后的命令（uv run 环境）
uv run cb-manage <子命令> ...
```

查看全部命令：

```bash
.venv/bin/python -m backend.scripts.manage --help
```

每个子命令都自带帮助，例如：

```bash
.venv/bin/python -m backend.scripts.manage delete-account --help
```

## 2. 命令一览

| 子命令 | 用途 | 危险度 |
| --- | --- | --- |
| `add-account` | 快速创建账户（含测试账户） | 低 |
| `set-password` | 修改账户密码 | 中 |
| `set-account-status` | 停用 / 启用账户 | 中 |
| `add-device` | 登记设备会话 | 低 |
| `list-devices` | 查看某账户已登记设备 | 只读 |
| `revoke-device` | 踢出某设备（会话立即失效） | 中 |
| `list-accounts` | 列出全部账户 | 只读 |
| `delete-account` | 物理删除账户并级联清空其全部数据 | **高（不可恢复）** |
| `db-tables` | 列出全部表与行数 | 只读 |
| `db-rows` | 按表查询具体数据行（JSON） | 只读 |

## 3. 账户维护

### 3.1 快速创建测试账户

```bash
.venv/bin/python -m backend.scripts.manage add-account 13800000000 --password demo1234
# 账户已创建: 13800000000 (status=active)
```

- `phone`：11 位中国大陆手机号（`1[3-9]` 开头）；入库前会规范化（去空格、去 `+86`）。
- `--password`：必填，明文输入后立即 Argon2id 哈希。
- `--status`：`active`（默认）或 `disabled`；停用账户无法登录，已登录会话立即失效。

### 3.2 查看全部账户

```bash
.venv/bin/python -m backend.scripts.manage list-accounts
#   13800000000  status=active  created=2026-08-07T08:56:32.954240+00:00
#   13811111111  status=active  created=2026-08-07T09:09:49.482589+00:00
```

### 3.3 修改密码 / 停用启用

```bash
.venv/bin/python -m backend.scripts.manage set-password 13800000000 --password new-pass
.venv/bin/python -m backend.scripts.manage set-account-status 13800000000 --status disabled
.venv/bin/python -m backend.scripts.manage set-account-status 13800000000 --status active
```

> 只想让账户暂时不可用，优先用 `set-account-status disabled`，不要用 `delete-account`。

### 3.4 物理删除账户

```bash
.venv/bin/python -m backend.scripts.manage delete-account 13800000000 --yes
#   已删除 chat_turns: 1 行
#   已删除 chat_sessions: 1 行
#   ...（仅打印实际删到行的表）
#   账户已物理删除: 13800000000
```

安全规则：

- **必须带 `--yes`**，否则 argparse 直接拒绝执行。
- 账户不存在时报错退出（`错误: 账户不存在: <phone>`），不会误以为已删除。
- 级联顺序固定，清空该账户在以下表中的全部行：`chat_turns` → `chat_sessions` → `operation_changes` → `database_operations` → `work_orders` → `customer_code_mappings` → `customers` → `service_categories` → `account_devices` → `accounts`。
- 只影响目标账户；其他账户数据不动。
- 删除不可恢复，生产环境使用前先备份 `backend/data/app.db`。

## 4. 设备维护

```bash
# 登记设备（默认 refresh 有效期 180 天，可 --expires-at 指定 ISO 8601）
.venv/bin/python -m backend.scripts.manage add-device 13800000000 dev-a1b2c3d4e5f6

# 查看该账户信任的设备清单
.venv/bin/python -m backend.scripts.manage list-devices 13800000000

# 踢出设备：该设备已签发 token 立即失效，需重新登录
.venv/bin/python -m backend.scripts.manage revoke-device 13800000000 dev-a1b2c3d4e5f6
```

## 5. 库内数据排查（识别后端行）

### 5.1 看全局：表和行数

```bash
.venv/bin/python -m backend.scripts.manage db-tables
#   account_devices          3 行
#   accounts                 2 行
#   chat_sessions            0 行
#   chat_turns               0 行
#   customer_code_mappings   0 行
#   customers                0 行
#   database_operations      0 行
#   operation_changes        0 行
#   service_categories       0 行
#   work_orders              0 行
```

只列真实业务表，排除 SQLite 内部表（`sqlite_*`）。

### 5.2 看具体行：`db-rows`

```bash
# 某账户全部工单（最多 20 行，JSON）
.venv/bin/python -m backend.scripts.manage db-rows work_orders --phone 13800000000

# 按 sync_id 精确定位一条记录
.venv/bin/python -m backend.scripts.manage db-rows customers --sync-id sync-cus-380000000000

# 组合过滤 + 更大上限
.venv/bin/python -m backend.scripts.manage db-rows work_orders --phone 13800000000 --sync-id sync-wo-... --limit 100
```

参数说明：

- `table`：必填，只接受库里真实存在的表名（内部按 `sqlite_master` 白名单校验，防注入）。
- `--phone`：目标表存在 `account_phone` 列时生效；不存在则忽略该条件。
- `--sync-id`：目标表存在 `sync_id` 列时生效；不存在则忽略。
- `--limit`：默认 20，范围 1–500（越界自动收窄）。
- 输出：每行一个 JSON 对象，`ensure_ascii=False`（中文可读）。

常用排查表名：`work_orders` / `customers` / `customer_code_mappings` / `service_categories` / `database_operations` / `operation_changes` / `chat_sessions` / `chat_turns` / `account_devices` / `accounts`。

## 6. 常见操作配方

```bash
# 1) 建一个联调用的测试账户
cb-manage add-account 13800000000 --password demo1234

# 2) 忘记密码时重置
cb-manage set-password 13800000000 --password demo1234

# 3) 排查"这台手机为什么登不上"
cb-manage list-accounts
cb-manage list-devices 13800000000

# 4) 排查"后端到底有哪些工单"
cb-manage db-tables
cb-manage db-rows work_orders --phone 13800000000 --limit 100

# 5) 清掉临时测试账户的全部数据
cb-manage delete-account 13911111111 --yes
```

## 7. 错误与退出约定

- 参数不合法（手机号格式错误、账户已存在、账户不存在、表不存在）→ 打印 `错误: ...`，`exit 1`，数据库回滚。
- 命令成功 → 打印结果，事务提交，`exit 0`。
- 未预料的异常 → 事务回滚并向上抛出（带 Python traceback，供开发排查）。

## 8. 实现与测试

- 实现：`backend/src/backend/scripts/manage.py`（命令动作是独立纯函数，argparse 只做参数解析）。
- 测试：`backend/tests/scripts/test_manage.py`（只测公共命令函数；级联删除、白名单、过滤与 limit 收窄均有覆盖）。
- 本手册如有命令增改，请同步更新；测试为手册中安全规则的权威验证。
