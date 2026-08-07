"""Settings：从 config.toml 读取项目配置。

config.toml 放在 backend/ 目录下（本文件 src/backend/config.py 向上三级）。
路径字段按相对该目录解析，方便迁移部署。
目前只有 [database] path；后续 [auth]、[server] 等段加在这里。

用标准库 tomllib 解析 TOML（Python 3.11+ 内置，零依赖）。
"""

from pathlib import Path

import tomllib

# config.toml 位于 backend/ 根目录：src/backend/config.py → 上三级
_CONFIG_FILE = Path(__file__).resolve().parent.parent.parent / "config.toml"


class Settings:
    """从 config.toml 读取项目配置。"""

    def __init__(self, config_file: Path = _CONFIG_FILE) -> None:
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
