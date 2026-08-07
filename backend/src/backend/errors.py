"""统一错误响应 schema（docs/auth-structure.md §3.2）。

错误响应格式：{"error_code": ..., "message": ..., "details": ...}。
认证层先落地，其他模块后期复用。AppError 由服务层抛出，
FastAPI 通过 register_error_handlers 统一转成 JSON 响应。
"""

from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse


class AppError(Exception):
    """带 error_code / HTTP 状态码的业务错误基类。

    服务层抛 AppError 子类表达业务失败（登录失败、被锁定、会话失效等），
    由统一异常处理器转成约定格式的 JSON 响应，路由层无需 try/except。
    """

    def __init__(self, error_code: str, message: str, status_code: int,
                 details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.message = message
        self.status_code = status_code
        self.details = details


class AuthError(AppError):
    """认证域错误基类：默认 401。"""

    def __init__(self, error_code: str, message: str,
                 status_code: int = status.HTTP_401_UNAUTHORIZED,
                 details: dict[str, Any] | None = None) -> None:
        super().__init__(error_code, message, status_code, details)


# 常见认证错误常量（§2.14 的 401 / 403 语义映射）
ERROR_INVALID_CREDENTIALS = "invalid_credentials"      # 登录失败（密码错），401
ERROR_LOGIN_BLOCKED = "login_blocked"                  # 防刷锁定，401
ERROR_INVALID_TOKEN = "invalid_token"                  # token 缺失/无效/过期/类型不符，401
ERROR_SESSION_REVOKED = "session_revoked"              # 设备被踢，403
ERROR_ACCOUNT_DISABLED = "account_disabled"            # 账户停用，403
ERROR_INVALID_REQUEST = "invalid_request"              # 请求格式不合法（手机号/设备标识），400


def register_error_handlers(app: FastAPI) -> None:
    """注册 AppError → 统一错误 JSON 响应。"""

    @app.exception_handler(AppError)
    async def _app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        body: dict[str, Any] = {"error_code": exc.error_code, "message": exc.message}
        if exc.details is not None:
            body["details"] = exc.details
        return JSONResponse(status_code=exc.status_code, content=body)
