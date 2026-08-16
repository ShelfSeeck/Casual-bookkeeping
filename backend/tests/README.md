# 测试命令速查

前后端测试分开跑。后端 pytest（默认跳过 live），前端 vitest + vue-tsc。

## 一键全量

```bash
# 后端全部（238 个，跳过 live）
cd backend && uv run pytest -q

# 前端全部（221 个）+ 类型检查
cd frontend && npx vitest run && npx vue-tsc -b
```

## 后端：按测试目标选命令

| 想测什么 | 命令 |
| --- | --- |
| 全部 | `cd backend && uv run pytest -q` |
| 同步协议（三端点 + 全链路 e2e） | `uv run pytest tests/sync -q` |
| 同步端点契约（鉴权/批量/分页/隔离） | `uv run pytest tests/sync/test_sync.py -q` |
| 协议级全链路（bootstrap→push→pull、两设备冲突收敛、幂等重试） | `uv run pytest tests/sync/test_sync_e2e.py -q` |
| 四张业务仓库（版本/软删/本表校验） | `uv run pytest tests/repositories/test_business_repositories.py -q` |
| 操作历史仓库（幂等/分页游标/snapshot_seq） | `uv run pytest tests/repositories/test_operation_repositories.py -q` |
| 账户 + 设备仓库 | `uv run pytest tests/repositories/test_repositories.py -q` |
| BusinessCommandService（幂等/冲突/原子性/跨表校验） | `uv run pytest tests/services/test_business_command.py -q` |
| 认证领域服务（密码哈希/JWT/防刷） | `uv run pytest tests/services/test_auth_services.py -q` |
| 认证端点（登录/刷新/登出/踢出/停用） | `uv run pytest tests/auth/test_auth.py -q` |
| 建表 + 连接 DI | `uv run pytest tests/data/test_data.py -q` |
| 管理 CLI | `uv run pytest tests/scripts/test_manage.py -q` |
| Agent 构建 / 模型配置热读（chat-agent） | `uv run pytest tests/services/test_agent.py tests/services/test_model_config.py -q` |
| **真实模型冒烟**（打真接口，耗额度） | `uv run pytest tests/live -m live -s` |

单测筛选：
```bash
uv run pytest tests/sync/test_sync.py::test_push_accepts_batch -q   # 单个测试
uv run pytest -k conflict -q                                        # 按名字关键字
```

## 前端：按测试目标选命令

| 想测什么 | 命令 |
| --- | --- |
| 全部 | `cd frontend && npx vitest run` |
| 同步循环（Push→Pull/outbox 状态机/单飞/退避/历史保留/bootstrap 守卫） | `npx vitest run src/services/syncManager.test.ts` |
| 冲突三方对比与合并 | `npx vitest run src/services/conflictResolver.test.ts` |
| 重试退避计算 | `npx vitest run src/services/backoff.test.ts` |
| 本地写入事务 + 单记录 gate | `npx vitest run src/services/mutation.test.ts` |
| HTTP wire 适配（snake↔camel 请求/响应映射） | `npx vitest run src/services/syncApi.test.ts` |
| API client（401→refresh→重试/single-flight/失效回调） | `npx vitest run src/services/apiClient.test.ts` |
| 活跃账户身份（meta 库存取） | `npx vitest run src/services/activeAccount.test.ts` |
| 四业务 Repository | `npx vitest run src/repositories -q` |
| Dexie 库工厂 / device_id / schema | `npx vitest run src/db -q` |
| 类型检查 | `npx vue-tsc -b` |

## marker 说明

配置在 `backend/pyproject.toml`：`addopts = ["-m", "not live"]` 让普通 `pytest` 默认跳过 live。

| marker | 位置 | 说明 |
| --- | --- | --- |
| `@pytest.mark.live` | 仅 `tests/live/test_agent_smoke.py` | 打真实模型接口，需 `-m live` 显式运行 |
| `@pytest.mark.asyncio` | `live/test_agent_smoke.py`、`services/test_agent.py` | 异步测试（pytest-asyncio 提供），普通 pytest 会跑、不耗额度 |

## 注意

- live 冒烟红 ≠ 代码 bug：先查网络 / 额度 / 模型配置（读 `config.toml [model]`）。
- 测试按"缝"组织：每个文件头注明被测缝，只测公共接口，期望值来自文档字面量。
