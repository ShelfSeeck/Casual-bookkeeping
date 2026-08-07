"""认证路由（docs/auth-structure.md §2.8）：登录 / 刷新 / 登出。

refresh token 写 HttpOnly cookie（名称与 Secure 来自配置），access token 返回前端
存 localStorage（docs §2.6）。业务逻辑全部委托 AuthService，本层只做 HTTP 适配。
"""

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel

from backend.deps import (
    RefreshCookieConfig,
    get_AuthService,
    get_RefreshCookieConfig,
)
from backend.errors import ERROR_INVALID_TOKEN, AuthError
from backend.services.auth import AuthService
from backend.services.token import TokenPair

router = APIRouter(prefix="/auth", tags=["auth"])

# refresh cookie 的 SameSite：同域部署取 lax（docs §2.6）
_SAMESITE = "lax"


class LoginRequest(BaseModel):
    phone: str
    password: str
    device_id: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "Bearer"


def _set_refresh_cookie(
    response: Response, cookie: RefreshCookieConfig, token: str
) -> None:
    response.set_cookie(
        key=cookie.name,
        value=token,
        httponly=True,
        secure=cookie.secure,
        samesite=_SAMESITE,
        path="/",
    )


@router.post("/login", response_model=TokenResponse)
def login(
    body: LoginRequest,
    response: Response,
    auth: AuthService = Depends(get_AuthService),
    cookie: RefreshCookieConfig = Depends(get_RefreshCookieConfig),
) -> TokenResponse:
    pair: TokenPair = auth.login(body.phone, body.password, body.device_id)
    _set_refresh_cookie(response, cookie, pair.refresh_token)
    return TokenResponse(access_token=pair.access_token)


@router.post("/refresh", response_model=TokenResponse)
def refresh(
    request: Request,
    response: Response,
    auth: AuthService = Depends(get_AuthService),
    cookie: RefreshCookieConfig = Depends(get_RefreshCookieConfig),
) -> TokenResponse:
    token = request.cookies.get(cookie.name)
    if not token:
        raise AuthError(ERROR_INVALID_TOKEN, "缺少 refresh token", 401)
    pair = auth.refresh(token)
    _set_refresh_cookie(response, cookie, pair.refresh_token)
    return TokenResponse(access_token=pair.access_token)


@router.post("/logout", status_code=204)
def logout(
    request: Request,
    response: Response,
    auth: AuthService = Depends(get_AuthService),
    cookie: RefreshCookieConfig = Depends(get_RefreshCookieConfig),
) -> None:
    token = request.cookies.get(cookie.name)
    if token:
        auth.logout(token)
    response.delete_cookie(cookie.name, path="/")
