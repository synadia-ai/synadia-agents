# Agents

Plugins that wrap existing AI harnesses - PI, OpenClaw, Claude Code, Hermes - as NATS micro services speaking the **Synadia Agent Protocol for NATS**, so any SDK in `../client-sdk/` can drive them the same way.

The plugins are built on the SDK pair: caller-side primitives from [`../client-sdk/`](../client-sdk/) for subjects, envelope types, and the error hierarchy; server-side helpers from [`../agent-sdk/`](../agent-sdk/) (`encodeChunk`, `splitResponseText`, the heartbeat-payload encoders, and — when the harness fits — `AgentService`) for putting an agent on the wire. The OpenClaw, PI, and Claude Code harnesses currently call the encoders directly; the controller agents in [`../examples/pi-headless/`](../examples/pi-headless/) and [`../examples/claude-code-headless/`](../examples/claude-code-headless/) are obvious migration candidates for `AgentService` once their custom `spawn` / `stop` / `list` endpoints land on `extraEndpoints`.

For an example of *building* a fresh agent from scratch with the host SDK, see [`../examples/dspy/`](../examples/dspy/).

## Harness plugins

| Path                | Type token | Underlying harness                          | Prompt subject (v0.3 verb-first)                              | `max_payload` | `attachments_ok` |
| ------------------- | ---------- | ------------------------------------------- | ------------------------------------------------------------- | ------------- | ---------------- |
| `pi/`               | `pi`       | [PI Agent](https://github.com/earendil-works/pi) | `agents.prompt.pi.<owner>.<session>`                      | server-negotiated | true |
| `openclaw/`         | `oc`       | [OpenClaw](https://openclaw.ai)             | `agents.prompt.oc.<owner>.<agentName>`                        | server-negotiated | true |
| `claude-code/`      | `cc`       | [Claude Code](https://claude.com/claude-code) | `agents.prompt.cc.<owner>.<name>`                          | server-negotiated | true |
| `hermes/`           | `hermes`   | [Hermes Agent](https://github.com/NousResearch/hermes-agent) | `agents.prompt.hermes.<owner>.<name>`          | server-negotiated (config can request a smaller cap) | true |
| `open-agent/`       | `open-agent` | [vercel-labs/open-agents](https://github.com/vercel-labs/open-agents) | `agents.prompt.open-agent.<owner>.<session>` | server-negotiated | false |

`max_payload` is read from the NATS connection's `INFO` block at startup and advertised verbatim, formatted into the §2.1 `\d+(B|KB|MB|GB)` grammar. A `nats-server` running the default 1 MB advertises `1MB`; bump `--max_payload 8MB` and the agents track it.

Every agent also publishes heartbeats on `agents.hb.<type-token>.<owner>.<session>` every 30 s and answers `agents.status.<type-token>.<owner>.<session>` requests with the same payload (§8.7 (v0.3)).

## How it works

Every agent registers a NATS micro service called `agents` with an endpoint named `prompt`. The protocol only fixes the endpoint name - the subject is the agent's to choose. For the agents in this repo we've picked the v0.3 verb-first pattern `agents.prompt.<type-token>.<owner>.<session>`. The endpoint accepts either plain UTF-8 text or a JSON envelope (optionally with inline base64 attachments), then streams typed JSON chunks back on the reply subject - `status` for keep-alive, `response` for content deltas, optional `query` for mid-stream questions - and ends the stream with an empty body. Each agent also publishes heartbeats on `agents.hb.<type-token>.<owner>.<session>` (the verb is the abbreviation `hb` because heartbeats dominate per-account subject volume) and answers `agents.status.<type-token>.<owner>.<session>` requests with a freshly-built heartbeat-shaped payload. The prompt endpoint advertises its `max_payload` and `attachments_ok` in the endpoint metadata. That's the entire contract; everything else below is per-agent variation.

## Per-agent notes

- **`pi/`** - each running PI CLI session becomes one agent instance. Attachments stage at `~/.pi/agent/attachments/<session>/<uuid>/` and are cleaned on session shutdown.
- **`openclaw/`** - one OpenClaw agent per configured account. Attachments stage at `~/.openclaw/attachments/<agentName>/<uuid>/`, cleaned on gateway stop. Also publishes agent-initiated outbound messages on `<subject>.outbound` (OpenClaw-specific).
- **`claude-code/`** - ships as a Claude Code plugin (`/plugin install`). Two permission modes: `terminal` (prompt locally) or `query` (relay as a `query` chunk over NATS). Attachments stage at `~/.claude/channels/nats/attachments/<request_id>/`, cleaned on reply completion.
- **`open-agent/`** - inbound bridge for [`vercel-labs/open-agents`](https://github.com/vercel-labs/open-agents). Vendors `packages/agent` verbatim and ships a `LocalSandbox` so the harness runs without a Vercel account; first agent in the repo built directly on `AgentService` from `@synadia-ai/agent-service`. The companion [`../examples/open-agent-vercel/`](../examples/open-agent-vercel/) swaps in `@vercel/sandbox` to prove the sandbox seam is interchangeable. v1 is single-process / single-session (one bridge handles one `(owner, session)` pair).
- **`hermes/`** - full Hermes Agent (CLI + TUI + messaging gateway). Unlike the others, each gateway registers **one** identity and multiplexes conversations via the envelope's optional `session` field (§5.1); subject stays stable per instance. Images route through Hermes's `vision_analyze` tool so the model actually sees them. Currently installed from [`synadia-ai/hermes-agent`, branch `nats-gateway`](https://github.com/synadia-ai/hermes-agent/tree/nats-gateway) - upstream PR pending.

When an agent accepts attachments, it decodes them to disk and prepends the absolute paths to the prompt text like so:

```
[Attachments available at the following absolute paths]
- /absolute/path/to/<uuid>/<filename>

<original prompt text>
```

## Adding a new plugin

1. Create `agents/<name>/` with a project layout suited to the target harness.
2. Pick a short, lowercase **type token** and add a row to the table above.
3. Implement the protocol contract - registration, streaming, heartbeats, envelope handling, error codes, queue group. See the conformance checklist below.
4. Cross-verify against any SDK in `../client-sdk/` - the SDK's integration tests are the wire-level contract.

<details>
<summary>Conformance checklist</summary>

1. Register as a NATS micro service named `agents` with metadata `{agent, owner, session, protocol_version}`.
2. Expose an endpoint named `prompt` that advertises `max_payload` and `attachments_ok`. The subject is your choice; the agents in this repo serve it at `agents.prompt.<type-token>.<owner>.<session>` (v0.3 verb-first).
3. Publish heartbeats on `agents.hb.<type-token>.<owner>.<session>` (verb `hb`, §8.1 v0.3).
3b. Optionally expose a `status` endpoint on `agents.status.<type-token>.<owner>.<session>` that returns the same payload shape as a heartbeat — useful for callers that want one-shot liveness without subscribing.
4. Accept plain-text OR JSON envelopes. Decode inline attachments to a per-session staging dir and prepend their absolute paths to the prompt.
5. Stream typed chunks on the reply subject: `status` (ack / keep-alive), `response` (content deltas), `query` (mid-stream questions, when supported).
6. Terminate with an empty body and no headers.
7. Reject malformed envelopes, oversized payloads, invalid base64, and unsafe filenames with `Nats-Service-Error-Code: 400`. Internal failures return `500`.
8. Endpoints belong to the `"agents"` queue group.

Caller-side constraints (rejected with `400`): `content` must be strict RFC 4648 base64; `filename` must be a plain basename (no `/`, `\`, `..`, absolute paths, or NUL bytes); the encoded envelope must fit within `max_payload`.

</details>

Per-agent configuration, install instructions, and troubleshooting live in each subdirectory README.

Full protocol spec: <https://github.com/synadia-ai/synadia-agent-sdk-docs>
