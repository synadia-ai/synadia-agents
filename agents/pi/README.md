# @synadia-ai/nats-pi-channel

NATS channel for [PI Agent](https://github.com/badlogic/pi-mono), implementing the **[NATS Agent Protocol](https://github.com/synadia-ai/nats-agent-sdk-docs) v0.2.0**.

Every PI session becomes a discoverable, addressable, streaming agent on NATS. Callers using any SDK that speaks the protocol - e.g. [`@synadia-ai/agents`](../../client-sdk/typescript) - can enumerate running PI sessions, prompt them, and stream responses back.

Sibling implementations (same wire protocol): [`claude-code`](../claude-code), [`openclaw`](../openclaw).

## How it works

On session start the extension:

1. Connects to NATS using a configured context (or `demo.nats.io` by default).
2. Registers a NATS micro service named `agents` with spec metadata (`agent`, `owner`, `session`, `protocol_version`).
3. Adds a `prompt` endpoint at `agents.pi.<owner>.<session>` advertising `max_payload: 1MB` and `attachments_ok: true`.
4. Begins publishing heartbeats on `agents.pi.<owner>.<session>.heartbeat` every 30 s.
5. On each inbound prompt: decodes any attached files to `~/.pi/agent/attachments/<session>/<uuid>/<filename>`, prepends their absolute paths to the prompt text, emits a `status: ack` chunk, injects the augmented prompt into PI via `pi.sendUserMessage()`, streams `text_delta` events back as typed `{type:"response",data}` chunks, and closes with the spec-mandated empty-body no-headers terminator.
6. Malformed envelopes, oversized payloads, invalid base64, and unsafe filenames are rejected at the wire with `Nats-Service-Error-Code: 400`. Staging failures (disk full, permission denied) return `500`.

Multiple PI sessions on the same host register as distinct instances of the same service, each with a unique `prompt` endpoint subject - `nats micro info agents` aggregates across all of them.

## Install

```bash
# From npm
pi install npm:@synadia-ai/nats-pi-channel

# From a local clone during development
pi install /absolute/path/to/nats-pi-channel
```

Then start PI normally:

```bash
pi
```

You should see `Connected to NATS (<server>) as agents.pi.<you>.<session>` and a footer status `NATS: agents.pi.<you>.<session>`.

## Configure

Config lives at `~/.pi/agent/nats-channel.json`:

```json
{
  "context": "my-nats-context",
  "sessionName": "my-session"
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `context` | no | `demo.nats.io` | NATS CLI context name in `~/.config/nats/context/` |
| `sessionName` | no | sanitized basename of CWD | Overrides the 4th subject token |

Environment variables take precedence over the file:
- `NATS_CONTEXT` - select a NATS CLI context
- `NATS_SESSION_NAME` - override the session name

### In-PI commands

- `/nats-status` - show current subject, service, instance id, protocol version, pending/queued counts
- `/nats-configure` - print current config
- `/nats-configure <context>` - switch NATS context
- `/nats-configure session <name>` - override session name
- `/nats-configure session clear` - revert to CWD basename

Changes take effect after restarting PI.

### Tenant isolation

The spec reserves the subject structure for protocol use; there is no `org` segment. For multi-tenant isolation, use NATS accounts and subject permissions (spec §10.1). Within an account, collisions between two PI sessions on the same `owner + session` auto-suffix `-2`, `-3`, …

## Subject hierarchy

```
agents.pi.<owner>.<session>             # prompt endpoint (spec §2, §5)
agents.pi.<owner>.<session>.heartbeat   # liveness beacon (spec §8)
```

- `pi` is both `metadata.agent` and its subject abbreviation (Appendix C).
- `owner`: sanitized `$USER`.
- `session`: sanitized basename of CWD, overridable.

## Talking to a running PI session

Any caller speaking the protocol - a spec-compliant SDK or the `nats` CLI - can:

```bash
# Enumerate all compliant agents (includes Claude Code, OpenClaw, etc.)
nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s

# Send a plain-text prompt
nats req agents.pi.<owner>.<session> "What files are in the current directory?" --wait-for-empty --timeout 120s

# Or a JSON envelope
nats req agents.pi.<owner>.<session> '{"prompt":"What files are here?"}' --wait-for-empty --timeout 120s
```

With the TypeScript SDK:

```ts
import { connect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const nc = await connect({ servers: "nats://localhost:4222" });
const agents = new Agents({ nc });

const [agent] = await agents.discover({ filter: { agent: "pi" } });

for await (const msg of await agent!.prompt("What files are here?")) {
  if (msg.type === "response") process.stdout.write(msg.text);
}

await agents.close();
await nc.close();
```

## Wire protocol (summary)

Full spec: <https://github.com/synadia-ai/nats-agent-sdk-docs>. Quick reference:

- **Request**: plain UTF-8 text OR JSON `{"prompt":"…","attachments":[{"filename":"…","content":"<base64>"},…]}`. Attachment `content` must be RFC 4648 §4 base64 (standard alphabet, padded, no URL-safe variant, no whitespace).
- **Response**: one or more typed chunks on the reply subject:
  - `{"type":"response","data":"<text>"}` - content
  - `{"type":"status","data":"ack"}` - accepted / keep-alive
- **Terminator**: empty body **and no headers** (spec §6.5).
- **Errors**: `Nats-Service-Error-Code` header with `400`/`500`, followed by the terminator.

## Discovery

Any NATS Agent Protocol SDK will enumerate PI sessions automatically. Without an SDK:

```bash
# Micro service framework
nats micro list           # shows all agents instances
nats micro info agents

# Heartbeats - track liveness without polling
nats sub 'agents.*.*.*.heartbeat'
```

## Concurrency

Each PI session processes one NATS request at a time. Additional requests queue until the agent is idle. The user's local TUI input and inbound NATS prompts share the same agent session.

## Attachments

When a request envelope contains `attachments`, each file is decoded and staged on disk at:

```
~/.pi/agent/attachments/<session>/<uuid>/<filename>
```

The absolute paths are then prepended to the prompt as:

```
[Attachments available at the following absolute paths]
- /home/you/.pi/agent/attachments/myproj/abcd-…/vacation.jpg

<original prompt text>
```

PI's model sees the list in the user message and can open the files with its file tools. The entire `<session>` directory is removed on `session_shutdown`; within a session, attachments from earlier turns remain on disk so follow-up turns can still reference them.

Caller-side constraints (rejected at the wire with `400` if violated):
- `content` must be strict RFC 4648 §4 base64 - standard alphabet, padded, no URL-safe, no whitespace.
- `filename` must be a plain basename. Path separators (`/`, `\`), `..`, absolute paths, and NUL bytes are rejected rather than silently flattened.
- Full encoded envelope must fit within `max_payload` (1 MB).

Spec §5.5 reserves a future `attachments` endpoint at `agents.pi.<owner>.<session>.attachments` for chunked large-file upload; that lands in protocol 0.2 and will coexist with inline attachments.

## Limitations

Deliberate deferrals:

- **No mid-stream queries.** PI doesn't currently initiate permission prompts or clarifications over this channel; the spec's `query` chunk type (§7) is supported by callers but never emitted.
- **No live reconfigure.** `/nats-configure` writes the config file; restart PI to apply.
- **TUI bleed.** If the user types locally during a NATS-driven turn, that output flows to the NATS reply subject alongside the prompt's response.

## Troubleshooting

- **`NATS: disconnected` in footer.** Check `/nats-status`, the context file at `~/.config/nats/context/<context>.json`, and NATS server reachability.
- **`NATS: reconnecting…`.** Connection dropped; restoring automatically.
- **My session got a `-2` suffix.** Another PI session on the same `owner + session` was already registered. Use `/nats-configure session <name>` to pick a different name.
- **`nats req` returns nothing or hangs.** Pass `--wait-for-empty`; the protocol signals end-of-stream with an empty-body message, not a single response.
- **`400 attachment[N] has invalid base64 content`.** The SDK / client emitted URL-safe base64 or unpadded output. Switch to RFC 4648 §4 (standard alphabet, padded) - Node's `Buffer.from(bytes).toString("base64")` produces the correct form.
- **`400 attachment[N] has unsafe filename`.** Path separators, `..`, absolute paths, or NUL in `filename`. Send the basename only (e.g. `"report.pdf"`, not `"./reports/report.pdf"`).

## License

Apache-2.0
