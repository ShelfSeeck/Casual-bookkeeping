"""FastAPI 应用入口。

lifespan 在应用启动时对配置的数据库执行 apply_schema，确保 10 张表就绪
（幂等，数据库文件不存在会自动创建，路径来自 config.toml）。
本轮不挂业务路由——认证端点（登录/刷新/登出）下一轮引入。
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from backend.config import Settings
from backend.data.db import Database
from backend.data.schema import apply_schema


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 应用启动时确保表存在（幂等建表），数据库文件缺失会自动创建
    settings = Settings()
    database = Database(settings.database_path)
    apply_schema(database)
    yield


app = FastAPI(lifespan=lifespan)
