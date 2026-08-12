"""缝 10（live）：真实模型冒烟测试（docs/spec/chat-agent.md §10 补充）。

被测缝：build_Agent + run_stream_events 对真实模型端点的完整链路。

验证什么、为什么：
- 配置有效：读 config.toml [model]（与生产同路径 get_ActiveModelConfig），
  一次验证 base_url / model_name / api_key 三项配置可用。
- 链路可用：真实模型下流式事件至少出现一次文本增量（TextPartDelta），
  最终收到携带结果的收尾事件且 output 非空——即 services/chat.py 将依赖的那条
  流式路径（构建 Agent → OpenAI 兼容流式 → 模型真实返回）能跑通。
- 失败即红：本测试红 ≠ 代码 bug，先查网络 / 额度 / 模型配置，不做为单元测试断言依据。
- 打真接口、耗额度：默认 pytest 不运行（pyproject addopts = -m "not live"），
  需显式 `uv run pytest tests/live -m live -s` 才执行。
"""

import asyncio

import pytest
from pydantic_ai import AgentRunResultEvent
from pydantic_ai.messages import PartDeltaEvent, TextPartDelta

from backend.services.agent import build_Agent
from backend.services.model_config import get_ActiveModelConfig


@pytest.mark.live
@pytest.mark.asyncio
async def test_real_model_stream_round():
    # 与生产同路径取配置并构建 Agent，验证完整链路
    cfg = get_ActiveModelConfig()
    agent = build_Agent(cfg)

    text_len = 0
    final_result = None

    async def _collect() -> None:
        nonlocal text_len, final_result
        async with agent.run_stream_events("你好，请用一句话介绍你自己") as run:
            async for event in run:
                if isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                    text_len += len(event.delta.content_delta)
                elif isinstance(event, AgentRunResultEvent):
                    final_result = event.result

    # 兜底：网络挂起时 60s 超时，避免测试无限挂起
    await asyncio.wait_for(_collect(), timeout=60)

    assert text_len > 0, "未收到任何文本增量，先查网络 / api_key / 模型名"
    assert final_result is not None, "未收到收尾事件"
    assert final_result.output, "模型返回空输出"
