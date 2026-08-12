"""FastAPI 应用入口。

lifespan 在应用启动时对配置的数据库执行 apply_schema，确保 10 张表就绪
（幂等，数据库文件不存在会自动创建，路径来自 config.toml）。
全局挂 get_CurrentAccount 鉴权守卫：默认所有端点要求有效 access token，
仅 login/refresh/logout 三个认证端点白名单放行（docs §2.10）。
"""

from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI

from backend.config import Settings
from backend.data.db import Database
from backend.data.schema import apply_schema
from backend.deps import get_CurrentAccount
from backend.errors import register_error_handlers
from backend.routers import auth as auth_router
from backend.routers import sync as sync_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 应用启动时确保表存在（幂等建表），数据库文件缺失会自动创建
    settings = Settings()
    database = Database(settings.database_path)
    apply_schema(database)
    yield


# 全局鉴权：白名单路径（login/refresh/logout）放行，其余端点由守卫校验并注入身份。
# 不注册 Swagger/openapi 端点：接口文档统一维护在 docs/api.md，供 AI 开发与联调使用。
app = FastAPI(
    lifespan=lifespan,
    dependencies=[Depends(get_CurrentAccount)],
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
app.include_router(auth_router.router)
app.include_router(sync_router.router)
register_error_handlers(app)
