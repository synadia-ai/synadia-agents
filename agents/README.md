# Agents

Agent hosts that implement the **NATS Agent Protocol** (`0.2.0-draft`). Each subdirectory bridges an existing AI coding harness (PI, OpenClaw, Claude Code, …) onto NATS so any SDK in `../client-sdk/` can drive it.

## Agents in this monorepo

| Path                | Type token | Underlying harness                          | Subject pattern                                        | `max_payload` | `attachments_ok` |
| ------------------- | ---------- | ------------------------------------------- | ------------------------------------------------------ | ------------- | ---------------- |
| `pi/`               | `pi`       | [PI Agent](https://github.com/badlogic/pi-mono) | `agents.pi.<owner>.<session>`                      | 1 MB          | true             |
| `openclaw/`         | `oc`       | [OpenClaw](https://openclaw.ai)             | `agents.oc.<owner>.<agentName>`                        | 1 MB          | true             |
| `claude-code/`      | `ccc`      | [Claude Code](https://claude.com/claude-code) | `agents.ccc.<owner>.<session>`                      | 1 MB          | true             |

Each agent also publishes `<subject>.heartbeat` every 30 s with the spec §8.3 payload.

## What every agent must do

All three implementations register the **same** NATS micro service (`agents`) and share the **same** wire protocol. Differences are confined to the underlying harness integration.

1. **Register** as a NATS micro service named `agents` with metadata `{agent, owner, session, protocol_version: "0.2"}`.
2. **Add a `prompt` endpoint** at `agents.<type-token>.<owner>.<session>` advertising `max_payload` and `attachments_ok` in the endpoint metadata.
3. **Publish heartbeats** on `<subject>.heartbeat` every 30 s (§8).
4. **Accept** plain-text OR JSON envelopes. Decode inline attachments to a per-session staging dir and prepend their absolute paths to the prompt text.
5. **Stream** typed chunks back on the reply subject:
   - `{"type":"status","data":"ack"}` on accept and as periodic keep-alive
   - `{"type":"response","data":"<text>"}` for each content delta
   - `{"type":"query","data":{...}}` for mid-stream questions (§7) when supported
6. **Terminate** with an empty body and no headers (§6.5).
7. **Reject** malformed envelopes, oversized payloads, invalid base64, and unsafe filenames at the wire with `Nats-Service-Error-Code: 400`. Internal failures return `500`.
8. **Queue group:** endpoints belong to the `"agents"` queue group (§3.3).

## Attachment staging

All three agents decode inline attachments to local disk and reference the paths in the prompt text, using the spec-defined prefix:

```
[Attachments available at the following absolute paths]
- /absolute/path/to/<uuid>/<filename>

<original prompt text>
```

Staging locations differ per host:

| Agent        | Staging root                                       | Cleanup                             |
| ------------ | -------------------------------------------------- | ----------------------------------- |
| `pi/`        | `~/.pi/agent/attachments/<session>/<uuid>/`        | on session shutdown                 |
| `openclaw/`  | `~/.openclaw/attachments/<agentName>/<uuid>/`      | on gateway stop                     |
| `claude-code/` | `~/.claude/channels/nats/attachments/<request_id>/` | on reply completion              |

Caller-side constraints (same across all three, rejected with `400`):

- `content` must be strict RFC 4648 §4 base64.
- `filename` must be a plain basename — no `/`, `\`, `..`, absolute paths, or NUL bytes.
- Full encoded envelope must fit within the advertised `max_payload`.

## Differences worth knowing

- **`pi/`** — each running PI CLI session becomes one agent instance.
- **`openclaw/`** — one OpenClaw agent per configured account. Also publishes agent-initiated outbound messages on `<subject>.outbound` (OpenClaw-specific, not part of the spec).
- **`claude-code/`** — ships as a Claude Code plugin (`/plugin install`). Supports two permission modes: `terminal` (prompt locally) and `query` (relay as §7 query chunk over NATS).

## Adding a new agent

1. Create `agents/<name>/` with the host-specific project layout.
2. Pick a short **type token** (≤ 3 chars, lowercase). Document it in the table above.
3. Implement the eight requirements under *What every agent must do*.
4. Cross-verify against any SDK in `../client-sdk/` — the SDK's integration tests are the wire-level contract.
5. Update this README with the agent's row.

Per-agent configuration, install instructions, and troubleshooting live in the subdirectory READMEs.
