"""模型配置：每次调用重新读 config.toml [model]，支持热改（docs/spec/chat-agent.md §8）。

与 Settings 惰性单例分离：Settings 缓存整文件（适合启动期配置），本模块不缓存，
每次调用都重读磁盘，改 model_name / base_url / api_key 后下一回合即生效、无需重启。

config.toml 缺失时回退到示例文件（与 Settings 行为一致）。api_key 直接写 config.toml
（已 gitignore）是对「敏感项走 env」约定的有意识豁免，见 spec §8。
"""

import tomllib
from dataclasses import dataclass
from pathlib import Path

# config.toml 位于 backend/ 根目录：src/backend/services/model_config.py → 上四级
_CONFIG_FILE = Path(__file__).resolve().parent.parent.parent.parent / "config.toml"
_EXAMPLE_FILE = _CONFIG_FILE.with_name("config.example.toml")


class ModelConfigError(Exception):
    """config.toml [model] 缺失或非法；映射错误码 model_config_missing。"""

    error_code = "model_config_missing"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class ModelConfig:
    """一次有效的模型配置快照。"""

    model_name: str
    base_url: str
    api_key: str


def get_ActiveModelConfig(config_file: Path | None = None) -> ModelConfig:
    """读取当前生效的 [model] 配置，每次调用重读文件（热加载）。

    Args:
        config_file: 显式指定配置文件（测试用）；默认读 backend/config.toml，
            缺失时回退到同目录 config.example.toml。

    Raises:
        ModelConfigError: [model] 段缺失或 model_name / base_url 为空。
    """
    if config_file is None:
        config_file = _CONFIG_FILE
        if not config_file.exists():
            config_file = _EXAMPLE_FILE
    with config_file.open("rb") as f:
        data = tomllib.load(f)

    section = data.get("model") or {}
    model_name = str(section.get("model_name") or "").strip()
    base_url = str(section.get("base_url") or "").strip()
    api_key = str(section.get("api_key") or "")
    if not model_name or not base_url:
        raise ModelConfigError("config.toml 未配置 [model]（需要 model_name 与 base_url）")
    return ModelConfig(model_name=model_name, base_url=base_url, api_key=api_key)
