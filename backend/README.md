# backend — Casual-bookkeeping 后端

FastAPI + SQLite，本地优先记账应用的后端：账户认证、远程同步、AI 对话与操作历史。

## 启动

```bash
cd backend
PYTHONPATH=src .venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

启动时自动建表（lifespan）。配置读取 `config.toml`（复制自
`config.example.toml`）；JWT 密钥必须通过环境变量 `CB_JWT_SECRET` 提供，
不写入 TOML。

## 管理脚本（cb-manage）

`scripts/manage.py` 是后台管理 CLI，本机直连 SQLite，不经过 HTTP 认证。
密码入库前经 Argon2id 哈希，不存明文。

```bash
cd backend

# 两种运行方式等价
.venv/bin/python -m backend.scripts.manage --help
uv run cb-manage --help
```

| 子命令 | 用途 | 危险度 |
| --- | --- | --- |
| `add-account` | 创建账户 | 低 |
| `list-accounts` | 列出全部账户 | 只读 |
| `list-devices <手机号>` | 查看账户已登记设备 | 只读 |
| `add-device` | 登记设备会话 | 低 |
| `revoke-device <手机号> <device_id>` | 踢出设备，会话立即失效 | 中 |
| `set-password` | 修改账户密码 | 中 |
| `set-account-status` | 停用/启用账户 | 中 |
| `delete-account --yes <手机号>` | 物理删除账户及全部关联数据 | 高（不可恢复） |
| `db-tables` / `db-rows` | 查看表与行（调试用） | 只读 |

示例：

```bash
.venv/bin/python -m backend.scripts.manage add-account 13800000000 --password cb123456
.venv/bin/python -m backend.scripts.manage list-devices 13800000000
.venv/bin/python -m backend.scripts.manage revoke-device 13800000000 dev-0123456789ab
```

完整手册与参数说明见 `../docs/manage-cli.md`。

## 测试

```bash
.venv/bin/python -m pytest -m "not live"   # 默认跳过真实模型冒烟
.venv/bin/python -m pytest -m live          # 真实模型冒烟（读 config.toml [model]）
```

## 分层

`data/`（Database 连接工厂 + 建表）→ `repositories/`（受控读写）→
`deps.py`（FastAPI 依赖注入）→ `main.py`（入口）。仓库层不 import FastAPI。
