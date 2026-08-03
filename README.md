# AcS（衣物处理厂记账）

面向衣物处理厂的移动端记账 PWA。项目采用**本地优先**策略：工单等业务数据优先写入浏览器 IndexedDB，后端负责权威备份、同步和受控的 AI 对话能力。

## 项目结构

```text
apps/
├── web/  # Vue 3 + Vite + Vant + Dexie + PWA
└── api/  # FastAPI + SQLite + Pydantic AI
```

## 启动开发环境

```bash
# 终端 1：API
cd apps/api
uv sync --group dev
uv run uvicorn acs_api.main:app --reload

# 终端 2：PWA
cd apps/web
pnpm install
pnpm dev
```

访问前端开发服务器显示的地址；API 健康检查为 `http://127.0.0.1:8000/api/health`。

## 当前范围

本次初始化已建立工程结构、SQLite 初始表结构、IndexedDB 本地模型和可安装的 PWA 外壳。
业务录入、同步协议、认证与 AI 工具将在后续迭代实现。
