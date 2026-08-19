# 后端 CI/CD

仓库中的 `.github/workflows/backend-ci-cd.yml` 负责后端的持续集成与代码同步：

- Pull Request：安装 Python 3.12 与 `uv` 依赖，运行 pytest 测试（排除真实模型冒烟），不进行部署同步。
- `main` 分支 push：通过测试后，将 `backend/` 下的源码和配置文件同步到生产服务器。
- `main` 分支手动运行：执行同一套测试与代码同步流程。

部署目标为 `<CB_DEPLOY_ROOT>/backend/`。

## 变量与 Secrets 复用

本 workflow 完全复用前端 CD 所使用的 GitHub Environment `First_CB_NORMAL` 中的 Secrets，**无需新增任何 Secrets**：

| 名称 | GitHub 类型 | 示例 | 用途 |
| --- | --- | --- | --- |
| `CB_DEPLOY_HOST` | Secrets | `your-server.example.com` | SSH 主机名或 IPv4 地址 |
| `CB_DEPLOY_SSH_PORT` | Secrets | `22` | SSH 端口 |
| `CB_DEPLOY_USER` | Secrets | `deploy-user` | SSH 登录用户 |
| `CB_DEPLOY_ROOT` | Secrets | `/home/deploy-user/Projects/Casual-Account` | 远端项目根目录 |
| `CB_DEPLOY_SSH_PRIVATE_KEY` | Secrets | 多行 OpenSSH 私钥 | GitHub Actions 部署私钥 |
| `CB_DEPLOY_KNOWN_HOSTS` | Secrets | `ssh-keyscan` 输出 | 服务器公钥验证 |

### 为什么不需要新增 Secrets

1. **部署路径同根**：前端托管于 `<CB_DEPLOY_ROOT>/frontend/dist/`，后端位于 `<CB_DEPLOY_ROOT>/backend/`，通过统一的 `CB_DEPLOY_ROOT` 定位。
2. **生产密钥本地保留**：`CB_JWT_SECRET`、大模型 API Key 及生产 `config.toml` 属于服务器本地运行环境配置（通常在 systemd service 或服务器环境配置中），不应也不需要在 CI/CD 流程中传递。

## 数据与配置安全保护

在同步后端代码时，rsync 配置了严格的排除规则，确保远端生产数据与配置不会被覆盖或删除：

- `data/`：生产 SQLite 数据库（`app.db`、`app.db-wal` 等），绝对不能被覆盖或删除。
- `config.toml`：服务器本地独立配置文件。
- `.venv/`：服务器端 Python 虚拟环境。
- `__pycache__/`、`.pytest_cache/`、`*.pyc`、`.env*`：缓存与本地临时文件。
