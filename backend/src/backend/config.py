"""Settings：从 config.toml 读取项目配置。

config.toml 放在 backend/ 目录下（本文件 src/backend/config.py 向上三级），
具体配置不入 git（见 .gitignore），仓库只提交 config.example.toml 示例。
本地首次使用时把示例复制成 config.toml；若 config.toml 缺失（如新克隆仓库），
Settings 自动回退到示例文件读取，保证开箱即用。
路径字段按该目录解析，方便迁移部署。

用标准库 tomllib 解析 TOML（Python 3.11+ 内置，零依赖）。
"""

import os
from pathlib import Path

import tomllib

# config.toml 位于 backend/ 根目录：src/backend/config.py → 上三级
_CONFIG_FILE = Path(__file__).resolve().parent.parent.parent / "config.toml"
_EXAMPLE_FILE = _CONFIG_FILE.with_name("config.example.toml")


class Settings:
    """从 config.toml 读取项目配置；缺失时用 config.example.toml 兜底。"""

    def __init__(self, config_file: Path | None = None) -> None:
        if config_file is None:
            config_file = _CONFIG_FILE
            if not config_file.exists():
                # 具体配置未就绪（新克隆/未复制示例）时，用仓库内的示例文件兜底
                config_file = _EXAMPLE_FILE
        # 记住配置文件所在目录，用于把相对路径解析成绝对路径
        self._config_dir = config_file.parent
        with config_file.open("rb") as f:
            self._config = tomllib.load(f)

    @property
    def database_path(self) -> str:
        # 相对路径（如 "data/app.db"）相对 config.toml 目录解析
        # → backend/data/app.db；绝对路径则原样使用
        raw = self._config["database"]["path"]
        path = Path(raw)
        if not path.is_absolute():
            path = self._config_dir / path
        return str(path)

    def _auth(self, key: str) -> object:
        # [auth] 段的统一取值入口；配置缺失视为错误（fail fast）
        return self._config["auth"][key]

    @property
    def jwt_secret(self) -> str:
        # 生产密钥从环境变量读（ACS_JWT_SECRET），config.toml 只作本地开发默认值，
        # 避免把真实密钥写进仓库
        return os.environ.get("ACS_JWT_SECRET") or str(self._auth("jwt_secret"))

    @property
    def access_token_ttl_seconds(self) -> int:
        return int(self._auth("access_token_ttl_seconds"))

    @property
    def refresh_token_ttl_seconds(self) -> int:
        return int(self._auth("refresh_token_ttl_seconds"))

    @property
    def max_login_failures(self) -> int:
        return int(self._auth("max_login_failures"))

    @property
    def login_lock_seconds(self) -> int:
        return int(self._auth("login_lock_seconds"))

    @property
    def refresh_cookie_name(self) -> str:
        return str(self._auth("refresh_cookie_name"))

    @property
    def secure_cookie(self) -> bool:
        return bool(self._auth("secure_cookie"))
