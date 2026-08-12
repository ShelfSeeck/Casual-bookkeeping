"""缝 8：模型配置热读（docs/spec/chat-agent.md §8）。

被测缝：get_ActiveModelConfig —— 每次调用重新读 config.toml [model]，不缓存：
- 正常读取 model_name / base_url / api_key
- 修改配置文件后再次调用立即反映（热改生效，无需重启进程）
- 默认路径 config.toml 缺失时回退到示例文件（与 Settings 行为一致）
- [model] 段缺失或 model_name/base_url 为空 → ModelConfigError（对应 model_config_missing）
"""

import pytest

from backend.services.model_config import (
    ModelConfig,
    ModelConfigError,
    get_ActiveModelConfig,
)


def _write_config(path, model_section: str) -> None:
    path.write_text(
        f"[model]\n{model_section}\n",
        encoding="utf-8",
    )


def test_reads_model_section(tmp_path):
    # 正常配置：三个字段都能读出来
    cfg_file = tmp_path / "config.toml"
    _write_config(cfg_file, 'model_name = "deepseek-chat"\nbase_url = "https://api.deepseek.com"\napi_key = "sk-x"')

    cfg = get_ActiveModelConfig(cfg_file)
    assert cfg == ModelConfig(
        model_name="deepseek-chat",
        base_url="https://api.deepseek.com",
        api_key="sk-x",
    )


def test_hot_reload_reflects_file_change(tmp_path):
    # 热改：第一次读取后改 model_name，再次调用应拿到新值（不缓存）
    cfg_file = tmp_path / "config.toml"
    _write_config(cfg_file, 'model_name = "deepseek-chat"\nbase_url = "https://a.com"\napi_key = "sk-x"')
    assert get_ActiveModelConfig(cfg_file).model_name == "deepseek-chat"

    _write_config(cfg_file, 'model_name = "gpt-5.2"\nbase_url = "https://a.com"\napi_key = "sk-x"')
    assert get_ActiveModelConfig(cfg_file).model_name == "gpt-5.2"


def test_missing_model_section_raises(tmp_path):
    # 没有 [model] 段：应抛 ModelConfigError（前端映射 model_config_missing）
    cfg_file = tmp_path / "config.toml"
    cfg_file.write_text("[database]\npath = 'data/app.db'\n", encoding="utf-8")

    with pytest.raises(ModelConfigError) as exc:
        get_ActiveModelConfig(cfg_file)
    assert exc.value.error_code == "model_config_missing"


def test_missing_model_name_raises(tmp_path):
    # [model] 存在但 model_name 为空：同样视为未配置
    cfg_file = tmp_path / "config.toml"
    _write_config(cfg_file, 'model_name = ""\nbase_url = "https://a.com"\napi_key = ""')

    with pytest.raises(ModelConfigError):
        get_ActiveModelConfig(cfg_file)


def test_falls_back_to_example_when_config_missing(monkeypatch, tmp_path):
    # 默认路径 config.toml 不存在时，回退到同目录的 config.example.toml
    missing = tmp_path / "config.toml"
    example = tmp_path / "config.example.toml"
    _write_config(example, 'model_name = "fallback-model"\nbase_url = "https://fallback.com"\napi_key = ""')

    monkeypatch.setattr("backend.services.model_config._CONFIG_FILE", missing)
    monkeypatch.setattr("backend.services.model_config._EXAMPLE_FILE", example)

    cfg = get_ActiveModelConfig()
    assert cfg.model_name == "fallback-model"
