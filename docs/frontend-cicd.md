# 前端 CI/CD

仓库中的 `.github/workflows/frontend-ci-cd.yml` 负责前端的持续集成和持续部署：

- Pull Request：安装依赖、运行 Vitest、执行 `npm run build`，不部署。
- `main` 分支 push：通过上述检查后，将 `frontend/dist/` 同步到生产服务器。
- `main` 分支手动运行：执行同一套检查和部署流程。

部署目标为 `<CB_DEPLOY_ROOT>/frontend/dist/`，由 Nginx 直接托管静态文件。

Nginx 模板保存在 [`deploy/nginx/casual-account-ip.conf.template`](../deploy/nginx/casual-account-ip.conf.template)，包含服务器地址的本地实配置保存在被忽略的 `deploy/nginx/casual-account-ip.local.conf`，后续修改按 `deploy/nginx/README.md` 的流程处理。

## 变量命名规则

统一使用大写蛇形命名，并以 `CB_` 开头。为避免服务器地址、用户和路径出现在日志或仓库中，本 workflow 从 GitHub Environment `First_CB_NORMAL` 的 Secrets 读取部署配置。

| 名称 | GitHub 类型 | 示例 | 用途 |
| --- | --- | --- | --- |
| `CB_DEPLOY_HOST` | Secrets | `your-server.example.com` | SSH 主机名或 IPv4 地址 |
| `CB_DEPLOY_SSH_PORT` | Secrets | `22` | SSH 端口，不是 HTTPS 端口 |
| `CB_DEPLOY_USER` | Secrets | `deploy-user` | SSH 登录用户 |
| `CB_DEPLOY_ROOT` | Secrets | `/home/deploy-user/Projects/Casual-Account` | 远端项目根目录，必须是不含空格的绝对路径 |
| `CB_DEPLOY_SSH_PRIVATE_KEY` | Secrets | 多行 OpenSSH 私钥 | GitHub Actions 使用的部署私钥 |
| `CB_DEPLOY_KNOWN_HOSTS` | Secrets | `ssh-keyscan` 输出 | 服务器公钥，防止连接到错误的主机 |

`CB_DEPLOY_SSH_PRIVATE_KEY` 对应的公钥必须已经写入服务器用户的
`~/.ssh/authorized_keys`。私钥只能放在 **Secrets**，不能放在 Variables、代码或
`.env` 文件中。

### 为什么没有配置 `CB_API_TARGET`

当前生产前端请求 `/auth`、`/sync`、`/chat` 相对路径，生产环境要求 Nginx 将这三个路径
反向代理到 FastAPI。因此构建阶段不需要后端地址；现有 `CB_API_TARGET` 只用于 Vite
开发服务器代理（见 `frontend/.env.example`）。不要把 JWT 密钥、模型 API Key 等后端
密钥放进任何 `VITE_*` 变量，因为 Vite 会把它们打包进浏览器代码。

## 在 GitHub 中配置

以下操作需要仓库管理员权限。所有值配置在 GitHub Environment `First_CB_NORMAL` 中。

### 1. 打开 GitHub 项目配置

打开 GitHub 仓库 → **Settings** → **Environments** → **First_CB_NORMAL**。

### 2. 添加 Secrets

进入 **Environment secrets** → **Add secret**，逐个添加以下四项：

```text
CB_DEPLOY_HOST=你的服务器域名或 IP
CB_DEPLOY_SSH_PORT=22
CB_DEPLOY_USER=服务器 SSH 用户
CB_DEPLOY_ROOT=/home/deploy-user/Projects/Casual-Account
```

`CB_DEPLOY_ROOT` 要填服务器上项目的真实绝对路径（不要包含空格）；workflow 会向其中的
`frontend/dist/` 写入文件。

### 3. 生成并添加 SSH Secrets

在自己的电脑上生成一对专用部署密钥（不要复用个人主密钥）：

```bash
ssh-keygen -t ed25519 -N "" -C "github-actions-casual-account" -f ~/.ssh/casual-account-actions
```

将公钥安装到服务器（登录用户、主机和端口按实际值替换）：

```bash
ssh-copy-id -p 22 -i ~/.ssh/casual-account-actions.pub user@your-host
```

如果服务器没有 `ssh-copy-id`，也可以把 `.pub` 文件的一整行追加到服务器的
`~/.ssh/authorized_keys`。

获取并核对服务器公钥：

```bash
ssh-keyscan -p 22 -H your-host
```

回到同一个 **First_CB_NORMAL → Environment secrets** 页面，继续添加：

- `CB_DEPLOY_SSH_PRIVATE_KEY`：粘贴 `~/.ssh/casual-account-actions` 文件的完整内容，包含
  `BEGIN OPENSSH PRIVATE KEY` 和 `END OPENSSH PRIVATE KEY` 两行。
- `CB_DEPLOY_KNOWN_HOSTS`：粘贴上面 `ssh-keyscan` 输出的完整一行（或多行）。如果 SSH
  端口不是 22，命令中的端口必须与 `CB_DEPLOY_SSH_PORT` 相同。

不要在 workflow 日志中 `echo` 这两个 Secret，也不要把它们提交到 Git。

## 第一次运行与排查

1. 先提交 workflow，打开 **Actions → Frontend CI/CD**，确认 Pull Request 的 CI 通过。
2. 合并到 `main` 后观察 `Deploy frontend` job。
3. 出现 `Missing GitHub secret ...` 时，检查对应名称是否添加在 `First_CB_NORMAL` 的 Environment Secrets。
4. 出现 SSH `Permission denied` 时，检查服务器 `authorized_keys`、SSH 用户、端口和私钥
   是否匹配。
5. 出现 host key 错误时，重新运行 `ssh-keyscan -p <端口> -H <主机>`，确认保存的是正确
   服务器的输出。
6. 部署完成后访问 HTTPS 地址，并按根目录 README 的 smoke test 检查登录、录单和同步。

