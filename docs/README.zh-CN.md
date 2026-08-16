# Casual-bookkeeping 中文说明

面向衣物处理厂的移动端、离线优先记账 PWA。日常工单录入、修改、查询和整理全部可在本机完成，网络恢复后与后端同步；AI 助手通过受控业务工具起草修改，不直接碰 SQL。

## 1. 技术栈

- 前端：Vue 3 + Vite + Vant 4，PWA（Dexie/IndexedDB 本地数据，Cache API 静态资源）
- 后端：Python + FastAPI + SQLite（分层：data → repositories → deps → routers）
- AI：Pydantic AI
- 本地优先：前端本地库即时落盘，后端是权威备份与跨设备同步源

## 2. 本地开发

前置：Node 24（项目用 nvm）、Python 3.12、`uv`。后端自带 `.venv`，直接使用。

### 2.1 后端（8000 端口）

```bash
cd backend

# 首次运行：创建本地开发账号
.venv/bin/python -m backend.scripts.manage add-account 13800000000 --password cb123456

# 启动
PYTHONPATH=src .venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

本地开发账号（如上创建）：`13800000000` / `cb123456`，仅限开发环境。

### 2.2 前端（5173 端口）

```bash
cd frontend
npm install
npm run dev
```

dev server 把 `/auth`、`/sync`、`/chat` 代理到 `http://127.0.0.1:8000`，
目标地址可用 `frontend/.env.local` 里的 `CB_API_TARGET` 覆盖。打开
`http://localhost:5173` 登录使用。

### 2.3 测试与类型检查

```bash
cd backend && .venv/bin/python -m pytest -m "not live"   # 后端（live 冒烟默认跳过）
cd frontend && npm run test                               # 前端（vitest）
cd frontend && npm run build                              # vue-tsc -b 类型门 + 构建
```

注意：`npx vue-tsc --noEmit` 是假信号（根 tsconfig 为 solution 式），
真正的类型检查命令是 `npx vue-tsc -b`（`npm run build` 已包含）。

## 3. 生产部署

### 3.1 构建

```bash
cd frontend
npm install
npm run build    # 产物在 frontend/dist/（index.html、assets、sw.js、manifest）
```

后端不需要单独构建，直接以 uvicorn 运行：

```bash
cd backend
PYTHONPATH=src .venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

### 3.2 后端配置

```bash
cd backend
cp config.example.toml config.toml    # config.toml 不入 git，按需修改
```

关键项：

| 配置 | 说明 |
| --- | --- |
| `[database] path` | SQLite 文件位置，默认 `data/app.db` |
| `[database] busy_timeout_ms` | 写锁排队毫秒数 |
| `CB_JWT_SECRET` 环境变量 | **启动必填**；也可放 `[auth] jwt_secret`，但真实密钥禁止入库 |
| `[auth] secure_cookie` | 生产（HTTPS）必须设为 `true` |
| `[model]` | 仅启用 AI 对话时需要；`api_key` 勿写进入库文件 |

### 3.3 同域反向代理（必须）

前端全部用相对路径请求 `/auth`、`/sync`、`/chat`，刷新令牌是 HttpOnly
cookie。**SPA 与 API 必须同域部署**，把三个前缀反代到后端。nginx 示例：

```nginx
server {
    listen 443 ssl;
    server_name app.example.com;
    # ssl_certificate / ssl_certificate_key ...

    root /var/www/cb/frontend/dist;
    location / {
        try_files $uri $uri/ /index.html;
    }

    location /auth/ { proxy_pass http://127.0.0.1:8000; }
    location /sync/ { proxy_pass http://127.0.0.1:8000; }
    location /chat/ { proxy_pass http://127.0.0.1:8000; }
}
```

### 3.4 HTTPS 与 PWA

- Service Worker 只在安全上下文注册，**生产必须 HTTPS**。
- PWA 为 autoUpdate 模式（`registerSW({ immediate: true })`），发新版本后用户刷新即生效。
- 建议把 `frontend/dist/` 交给同域静态服务，不要把 API 拆到跨域域名。

### 3.5 数据库与备份

- 默认库文件：`backend/data/app.db`（WAL 模式）。
- 备份要在一致性前提下进行：服务停掉后整目录复制，或用
  `sqlite3 app.db ".backup app-backup.db"`。
- 库文件与 `-wal` / `-shm` 要一起处理，不要只拷主文件。

### 3.6 初始化账号与管理 CLI

管理 CLI 在本机直连 SQLite，不经过 HTTP 认证：

```bash
cd backend
.venv/bin/python -m backend.scripts.manage add-account 13800000000 --password '强密码'
```

常用命令：`list-accounts`、`list-devices <手机号>`、
`revoke-device <手机号> <device_id>`、`set-password`、`set-account-status`。
完整手册见 `docs/manage-cli.md`。

### 3.7 部署后冒烟

1. 用 HTTPS 打开站点，登录第 3.6 节创建的账号。
2. 在「工单台」录一张单。
3. 到「查账本」确认该单出现且状态为「已同步」（Push 后 Pull 收敛）。

## 4. 部署注意事项

- 同域反代**不是可选项**：跨域会同时破坏 cookie 和相对路径。
- 生产必须 HTTPS，否则 PWA 不注册、同步不可用。
- 前端构建必须走 `npm run build`；单独 `npx vue-tsc --noEmit` 不做真实类型检查。
- `CB_JWT_SECRET`、模型 `api_key` 等敏感项只走环境变量或 git-ignored 的
  `config.toml`，任何情况下不得提交到仓库。
- 工单日期按设备本地日期计算（`localDateToday()`），部署环境与时区应保持一致，
  尤其不要用 UTC 容器时间冒充业务日期。
- 前端与后端要配套升级：同步协议、错误码、wire 字段名是一起演进的。
- SQLite 文件应放在持久化磁盘路径；容器部署时不要把库放进易失层。

## 5. 文档索引

| 文档 | 内容 |
| --- | --- |
| `docs/data-model.md` | 业务表、字段与前后端协同规则（权威） |
| `docs/auth-structure.md` | 账户、设备、会话、token 与鉴权 |
| `docs/sync-protocol.md` | bootstrap / Push / Pull 远程同步协议 |
| `docs/ai-chat-storage.md` | AI 会话与回合存储 |
| `docs/manage-cli.md` | 后台管理 CLI 手册 |
| `docs/error-codes.md` | 统一错误码 |
| `docs/spec/sync-backend.md` | 后端同步实现 spec |
| `docs/spec/chat-agent.md` | AI 对话 Agent spec |

## 6. 常见操作速查

```bash
# 后端
cd backend
PYTHONPATH=src .venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
.venv/bin/python -m backend.scripts.manage --help
.venv/bin/python -m pytest -m "not live"

# 前端
cd frontend
npm run dev        # 开发
npm run build      # 类型检查 + 生产构建
npm run test       # vitest
```
