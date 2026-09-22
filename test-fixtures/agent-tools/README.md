# `test-fixtures/agent-tools/` — the agent tools' definitions and result schemas

The one place the agent tools are defined: what a model is shown, and what it
gets back. The contract is [`docs/agent-tools.md`](../../docs/agent-tools.md).

A published package cannot read files outside its own directory, so each SDK
embeds its own copy of the definitions: `src/tools/definitions.ts` in
`client-sdk/typescript` and `synadia_ai/agents/tools/definitions.json` in
`client-sdk/python`. A test in each suite checks that its copy equals the
files here, so a change starts here and is copied into both.

| File | What |
| --- | --- |
| `discover_agents.json`, `prompt_agent.json`, `wait_agent.json`, `answer_agent.json`, `cancel_agent.json`, `list_agent_calls.json` | The definitions: `name`, `description`, `parameters` (a JSON Schema). A host maps them to its own tool format (MCP's `inputSchema`, a chat-completions `function`, its framework's tool objects) without changing a word. |
| `discover_agents.result.json` | What `discover_agents` hands back. |
| `prompt_agent.result.json` | What `prompt_agent`, `answer_agent` and `wait_agent` hand back: a call's result, a refusal, or `wait_agent`'s timeout. |
| `cancel_agent.result.json` | What `cancel_agent` hands back: one entry per call. |
| `list_agent_calls.result.json` | What `list_agent_calls` hands back. |

The result schemas are JSON Schema 2020-12. A tool hands its result to the
model as JSON text.
