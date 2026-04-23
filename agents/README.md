# Agents

Agent hosts that speak the **NATS Agent Protocol**. Each subdirectory wraps an existing AI harness — PI, OpenClaw, Claude Code, DSPy-style ReAct — as a NATS micro service, so any SDK in `../client-sdk/` can drive it the same way.

## Available agents

| Path                | Type token | Underlying harness                          | Subject pattern                                        | `max_payload` | `attachments_ok` |
| ------------------- | ---------- | ------------------------------------------- | ------------------------------------------------------ | ------------- | ---------------- |
| `pi/`               | `pi`       | [PI Agent](https://github.com/badlogic/pi-mono) | `agents.pi.<owner>.<session>`                      | 1 MB          | true             |
| `openclaw/`         | `oc`       | [OpenClaw](https://openclaw.ai)             | `agents.oc.<owner>.<agentName>`                        | 1 MB          | true             |
| `claude-code/`      | `ccc`      | [Claude Code](https://claude.com/claude-code) | `agents.ccc.<owner>.<session>`                      | 1 MB          | true             |
| `dspy/`             | `dspy`     | [ax-llm](https://github.com/ax-llm/ax) ReAct | `agents.dspy.<owner>.react`                           | 1 MB          | false            |

## How it works

Every agent registers a NATS micro service called `agents` with an endpoint named `prompt`. The protocol only fixes the endpoint name — the subject is implementation-chosen; across this repo we use `agents.<type-token>.<owner>.<session>` by convention. The endpoint accepts either plain UTF-8 text or a JSON envelope (optionally with inline base64 attachments), then streams typed JSON chunks back on the reply subject — `status` for keep-alive, `response` for content deltas, optional `query` for mid-stream questions — and ends the stream with an empty body. Each agent also publishes a heartbeat on `<subject>.heartbeat` and advertises its `max_payload` and `attachments_ok` in the endpoint metadata. That's the entire contract; everything else below is per-agent variation.

## Per-agent notes

- **`pi/`** — each running PI CLI session becomes one agent instance. Attachments stage at `~/.pi/agent/attachments/<session>/<uuid>/` and are cleaned on session shutdown.
- **`openclaw/`** — one OpenClaw agent per configured account. Attachments stage at `~/.openclaw/attachments/<agentName>/<uuid>/`, cleaned on gateway stop. Also publishes agent-initiated outbound messages on `<subject>.outbound` (OpenClaw-specific, not part of the spec).
- **`claude-code/`** — ships as a Claude Code plugin (`/plugin install`). Two permission modes: `terminal` (prompt locally) or `query` (relay as a protocol query chunk over NATS). Attachments stage at `~/.claude/channels/nats/attachments/<request_id>/`, cleaned on reply completion.
- **`dspy/`** — an [ax-llm](https://github.com/ax-llm/ax) ReAct loop (DSPy-style signatures) with four sandboxed tools: `list_files`, `read_file`, `write_file`, `bash`. Streams each tool call as a `status` chunk so callers see the ReAct trace live; the final answer arrives as `response` deltas. Does not accept attachments.

When an agent accepts attachments, it decodes them to disk and prepends the absolute paths to the prompt text using the spec-defined prefix:

```
[Attachments available at the following absolute paths]
- /absolute/path/to/<uuid>/<filename>

<original prompt text>
```

## Adding a new agent

1. Create `agents/<name>/` with a host-specific project layout.
2. Pick a short, lowercase **type token** and add a row to the table above.
3. Implement the protocol contract — registration, streaming, heartbeats, envelope handling, error codes, queue group. See the conformance checklist below.
4. Cross-verify against any SDK in `../client-sdk/` — the SDK's integration tests are the wire-level contract.

<details>
<summary>Conformance checklist</summary>

1. Register as a NATS micro service named `agents` with metadata `{agent, owner, session, protocol_version}`.
2. Expose an endpoint named `prompt` that advertises `max_payload` and `attachments_ok`. The subject is your choice; the convention in this repo is `agents.<type-token>.<owner>.<session>`.
3. Publish heartbeats on `<subject>.heartbeat`.
4. Accept plain-text OR JSON envelopes. Decode inline attachments to a per-session staging dir and prepend their absolute paths to the prompt.
5. Stream typed chunks on the reply subject: `status` (ack / keep-alive), `response` (content deltas), `query` (mid-stream questions, when supported).
6. Terminate with an empty body and no headers.
7. Reject malformed envelopes, oversized payloads, invalid base64, and unsafe filenames with `Nats-Service-Error-Code: 400`. Internal failures return `500`.
8. Endpoints belong to the `"agents"` queue group.

Caller-side constraints (rejected with `400`): `content` must be strict RFC 4648 base64; `filename` must be a plain basename (no `/`, `\`, `..`, absolute paths, or NUL bytes); the encoded envelope must fit within `max_payload`.

</details>

Per-agent configuration, install instructions, and troubleshooting live in each subdirectory README.

Full protocol spec: <https://github.com/synadia-ai/nats-agent-sdk-docs>
