"""The agent tools (``docs/agent-tools.md``): discover, prompt, wait, answer, cancel and list
other agents, as tools a model calls. See :class:`AgentTools`."""

from __future__ import annotations

from ._agent_tools import (
    AGENT_TOOLS_QUESTION_REFUSAL,
    DEFAULT_AGENT_TOOLS_MAX_CALLS,
    AgentCallState,
    AgentToolResult,
    AgentTools,
    AgentToolsExtension,
    AgentToolsPromptContext,
    AgentToolsPromptRewrite,
    AgentToolsReplyContext,
    SettledInfo,
    agent_tool_definitions,
)

__all__ = [
    "AGENT_TOOLS_QUESTION_REFUSAL",
    "DEFAULT_AGENT_TOOLS_MAX_CALLS",
    "AgentCallState",
    "AgentToolResult",
    "AgentTools",
    "AgentToolsExtension",
    "AgentToolsPromptContext",
    "AgentToolsPromptRewrite",
    "AgentToolsReplyContext",
    "SettledInfo",
    "agent_tool_definitions",
]
