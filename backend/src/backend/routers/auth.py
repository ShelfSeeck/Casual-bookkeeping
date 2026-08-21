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
    get_Settings,
)
from backend.config import Settings
from backend.errors import ERROR_INVALID_TOKEN, AuthError
from backend.services.auth import AuthService
from backend.services.token import TokenPair

router = APIRouter(prefix="/auth", tags=["auth"])


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
        max_age=cookie.max_age,  # 持久 cookie：180 天（与 JWT 有效期一致，关浏览器不丢）
        httponly=True,
        secure=cookie.secure,
        samesite=cookie.samesite,
        path="/",
    )


def _clear_refresh_cookie(
    response: Response, cookie: RefreshCookieConfig
) -> None:
    # 删除 cookie 需镜像设置时的属性，确保 Secure cookie 也能被可靠清除
    response.delete_cookie(
        key=cookie.name,
        httponly=True,
        secure=cookie.secure,
        samesite=cookie.samesite,
        path="/",
    )


def _source_ip(request: Request, trusted_proxies: list[str]) -> str:
    """解析请求来源 IP，用于登录防刷。

    默认只取 ASGI 直连 peer；仅当直连 peer 在可信代理列表内时，
    才从 X-Forwarded-For 取最后一个非可信跳（防伪造：XFF 可被客户端随意附加，
    只有逐跳由可信代理追加的尾部链才可靠）。解析失败一律回退直连 peer。
    """
    peer = request.client.host if request.client else "unknown"
    if peer not in trusted_proxies:
        return peer
    forwarded = request.headers.get("x-forwarded-for")
    if not forwarded:
        return peer
    chain = [hop.strip() for hop in forwarded.split(",") if hop.strip()]
    for hop in reversed(chain):
        if hop not in trusted_proxies:
            return hop
    return peer


@router.post("/login", response_model=TokenResponse)
def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    auth: AuthService = Depends(get_AuthService),
    cookie: RefreshCookieConfig = Depends(get_RefreshCookieConfig),
    settings: Settings = Depends(get_Settings),
) -> TokenResponse:
    # 直连来源 IP + 可信代理时的 X-Forwarded-For（配置 trusted_proxies 启用）
    source_ip = _source_ip(request, settings.trusted_proxies)
    pair: TokenPair = auth.login(
        body.phone, body.password, body.device_id, source_ip=source_ip
    )
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
    _clear_refresh_cookie(response, cookie)
