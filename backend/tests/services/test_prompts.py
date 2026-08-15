"""缝：动态提示词载入（docs/spec/chat-agent.md §9 services/agent.py 系统指令来源）。

被测缝：
- render_Instructions —— 把动态上下文（当前日期）注入系统指令模板：
  - 注入给定日期，供模型回答“今天/本周”类时间问题时直接使用
  - 保留原有纯文本输出等关键约束
"""

from datetime import date

from backend.services.prompts import render_Instructions


def test_render_Instructions_injects_today():
    # 验证什么：动态日期进入最终指令，且给出“今天/本周按此推算”的明确规则。
    # 为什么：快捷指令“今日工单汇总/本周工单汇总”依赖模型知道当天日期，不能等用户再报日期。
    instructions = render_Instructions(today=date(2026, 8, 16))
    assert "2026-08-16" in instructions
    assert "今天" in instructions


def test_render_Instructions_keeps_plain_text_rule():
    # 验证什么：注入动态内容后，原有纯文本输出约束仍保留。
    # 为什么：动态模板替换不能吞掉或破坏既定约束（docs/spec/agent-tools.md §4.3）。
    instructions = render_Instructions(today=date(2026, 8, 16))
    assert "不要用 Markdown" in instructions
