# @synadia-ai/nats-pi-channel

NATS channel extension for [PI Agent](https://github.com/earendil-works/pi). Every running PI session becomes discoverable, addressable, and streamable over NATS — anyone with a [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs) client (e.g. [`@synadia-ai/agents`](../../client-sdk/typescript) or [`synadia-ai-agents`](../../client-sdk/python)) can find your session, prompt it, and stream the reply back.

## Install

```bash
# From npm
pi install npm:@synadia-ai/nats-pi-channel

# From a local clone (development)
pi install /absolute/path/to/nats-pi-channel
```

When iterating on the SDKs locally, both `@synadia-ai/agents` and `@synadia-ai/agent-service` need a current `dist/` for PI's loader to resolve the `file:` links — see [`README-DEV.md`](../../README-DEV.md) at the repo root for the build sequence.

Then start PI normally:

```bash
pi
```

You should see `Connected to NATS (<server>) as agents.prompt.pi.<you>.<session>` and a footer status line `NATS: agents.prompt.pi.<you>.<session>`.

## Configure

Out of the box, no configuration is needed: PI connects to `demo.nats.io` and uses your `$USER` + the basename of the working directory as the subject tokens. Your session is reachable at:

```
agents.prompt.pi.<owner>.<session>
```

For real deployments, point PI at your own NATS via a context file. Two common setups:

**Production with a NATS CLI context** (already configured via `nats context add`):

```json
// ~/.pi/agent/nats-channel.json
{
  "context": "prod"
}
```

**Pin a stable session name** (so callers can address the same logical session even if you cd around):

```json
{
  "context": "prod",
  "sessionName": "my-session"
}
```

Restart PI to pick up changes — or use the in-PI commands below.

### Configuration reference

Config file lives at `~/.pi/agent/nats-channel.json`:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `context` | no | — | Name of a NATS CLI context (file under `~/.config/nats/context/<name>.json`). When unset, falls back to `$NATS_URL` or, if that's also unset, the built-in `demo.nats.io`. |
| `sessionName` | no | sanitized basename of CWD | The 5th subject token. Override to give your session a stable, addressable name. |
| `owner` | no | `$USER` | The 4th subject token. Override to scope the session to a service account, deployment, or tenant instead of the OS user — sanitized to a legal subject token. |

The `owner` token (4th) defaults to `$USER` but is overridable via the `owner` config field or the `NATS_PI_OWNER` env var (see below) — useful for service-account or deployment-scoped sessions. For multi-tenant isolation, see [Multi-tenancy](#multi-tenancy) below.

### Environment variables

Env vars override the config file:

| Variable | Sets | Notes |
|----------|------|-------|
| `NATS_CONTEXT` | `context` | Highest precedence — see below. |
| `NATS_URL` | raw URL (no auth context) | Used only when `NATS_CONTEXT` and `config.context` are both unset. |
| `NATS_SESSION_NAME` | `sessionName` | |
| `NATS_PI_OWNER` | `owner` | Overrides `$USER`; loses to the `owner` config field. |

### Resolution order

1. Built-in default — `demo.nats.io`, no auth
2. `config.context` — wizard-set / hand-edited NATS CLI context
3. `$NATS_URL` — raw URL fallback (only consulted when no context is set)
4. **`$NATS_CONTEXT`** — wins over everything

For `sessionName`: `$NATS_SESSION_NAME` overrides `config.sessionName`, which overrides the CWD-basename default.

For `owner`: `config.owner` overrides `$NATS_PI_OWNER`, which overrides `$USER`, which falls back to `unknown`.

### In-PI commands

Available inside a running PI session:

| Command | What it does |
|---------|--------------|
| `/nats-status` | Show current subject, service, instance id, protocol version, pending/queued counts |
| `/nats-configure` | Print current config |
| `/nats-configure <context>` | Switch NATS context |
| `/nats-configure session <name>` | Override session name |
| `/nats-configure session clear` | Revert to CWD basename |

`/nats-configure` writes the config file; restart PI to apply. (Live reconnect on context switch is a deferral — see [Limitations](#limitations).)

## Verify

```bash
# Find your session (and any other agents on the same NATS)
nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s

# Watch heartbeats — your session beats every ~5 s
nats sub 'agents.hb.*.*.*'
```

A successful `$SRV.INFO.agents` response for a PI session looks like:

```json
{
  "type": "io.nats.micro.v1.info_response",
  "name": "agents",
  "id": "JC8O0IGAWI5APOHLAOA96N",
  "version": "0.4.0",
  "description": "PI agent (my-session) in /home/me",
  "metadata": {
    "agent": "pi",
    "owner": "me",
    "session": "my-session",
    "protocol_version": "0.3",
    "cwd": "/home/me"
  },
  "endpoints": [
    {
      "name": "prompt",
      "subject": "agents.prompt.pi.me.my-session",
      "queue_group": "agents",
      "metadata": { "max_payload": "8MB", "attachments_ok": "true" }
    },
    {
      "name": "status",
      "subject": "agents.status.pi.me.my-session",
      "queue_group": "agents"
    }
  ]
}
```

If you see your `agents.prompt.pi.<owner>.<session>` subject in the response, you're discoverable. Multiple PI sessions show up as multiple responses to the same query — the `cwd` metadata field tells you which working directory each one was started from, useful when you've got several PI windows open and need to pick the right session to prompt.

## Talk to your session

From the CLI:

```bash
# Plain text prompt
nats req agents.prompt.pi.<owner>.<session> "What files are here?" \
  --wait-for-empty --reply-timeout 30s --timeout 120s

# JSON envelope (caller SDKs use this form)
nats req agents.prompt.pi.<owner>.<session> '{"prompt":"What files are here?"}' \
  --wait-for-empty --reply-timeout 30s --timeout 120s
```

`--wait-for-empty` is required: replies stream as multiple chunks and end with an empty terminator message.

`--reply-timeout` matters too. Its default is **300 ms** — the maximum gap allowed between consecutive replies. The agent publishes an immediate `{type:"status",data:"ack"}` chunk on request receipt, but the LLM's first response chunk typically lands 1–2 s later, so the default fires before the first response and the CLI exits after just the ack. Setting `--reply-timeout 30s` gives the LLM enough warm-up time. SDK callers (`requestMany` with `strategy:"sentinel"`) don't hit this — they wait the full `maxWait` regardless of inter-arrival gaps.

From TypeScript using `@synadia-ai/agents`:

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

## Attachments

When a request envelope carries `attachments`, each file is decoded and staged at:

```
~/.pi/agent/attachments/<session>/<uuid>/<filename>
```

The absolute paths are prepended to the prompt text so PI's model can open them with its file tools. Files staged earlier in a session stay on disk so follow-up turns can reference them; the whole `<session>/` directory is removed on session shutdown.

Encode files with `base64 -w0 <file>` (Linux/macOS) or `Buffer.from(bytes).toString("base64")` in Node before embedding in the JSON envelope. Caller SDKs do this for you.

Caller-side limits (rejected with `400` if violated):

- `content` must be standard-alphabet padded base64 — no URL-safe variant, no whitespace.
- `filename` must be a plain basename. Path separators, `..`, absolute paths, and NUL bytes are rejected, not silently flattened.
- The fully-encoded request must fit within the server-negotiated `max_payload` (1 MB on a default `nats-server`, more if the operator raised `--max_payload`).

## Concurrency

Each PI session processes one NATS request at a time. Additional requests queue until the session is idle. The local TUI input and inbound NATS prompts share the same agent — typing locally during a NATS-driven turn means that local output flows to the NATS reply alongside the remote prompt's response.

Multiple PI sessions on the same host register as distinct service instances; `nats micro info agents` aggregates across all of them. If two sessions try to register on the same `owner + session`, the later one auto-suffixes `-2`, `-3`, … — pick a stable name with `/nats-configure session <name>` if you want addressability.

## Multi-tenancy

The agent subject layout has no per-tenant slot. For real isolation between tenants or environments, use **NATS accounts** and subject permissions — that's a server-side configuration, not an extension one. Within a single account, sessions with distinct `owner` values (different `$USER`s, or owners set via the `owner` config field / `NATS_PI_OWNER`) coexist cleanly.

## Limitations

Deliberate deferrals:

- **No mid-stream queries.** PI doesn't initiate permission prompts or clarifications over this channel; the protocol's `query` chunk type is supported by callers but never emitted by the PI side.
- **No live reconfigure.** `/nats-configure` writes the config file; PI must be restarted for the new context or session name to apply.
- **TUI bleed.** Local typing during a NATS-driven turn flows to the NATS reply subject as part of the response.

## Troubleshooting

- **`NATS: reconnecting…`** — the connection dropped; the channel keeps retrying indefinitely (`maxReconnectAttempts: -1` from the SDK's `withAgentReconnectDefaults`), so just leave it — it will recover when the server is reachable again, including after a host sleep / network blip.
- **`NATS: disconnected` in footer** — terminal. The client gave up reconnecting; the typical cause is repeated identical auth errors (the one path nats.js does not retry through, regardless of our defaults). Run `/nats-status`, then check the context file at `~/.config/nats/context/<context>.json` and that the NATS server is reachable. Restart PI after fixing.
- **My session got a `-2` suffix** — another PI session was already registered on the same `owner + session`. Use `/nats-configure session <name>` to pick a different one.
- **`nats req` returns only the initial ack and exits** — pass `--reply-timeout 30s` (default is 300 ms, shorter than the gap between the ack chunk and the LLM's first response). See the "Talk to your session" section above for the full command. `--wait-for-empty` alone isn't enough.
- **`nats req` hangs or returns nothing** — pass `--wait-for-empty`. The protocol ends streams with an empty-body message, not a single response.
- **`400 attachment[N] has invalid base64 content`** — the caller emitted URL-safe base64 or unpadded output. `Buffer.from(bytes).toString("base64")` (Node) produces the right form.
- **`400 attachment[N] has unsafe filename`** — send the basename only (`"report.pdf"`), not a path (`"./reports/report.pdf"`).
- **Stale attachments piling up under `~/.pi/agent/attachments/`** — clean session shutdown removes the whole `<session>/` tree, but a force-quit or crash leaves the per-request UUID directories on disk. Safe to `rm -rf ~/.pi/agent/attachments/<session>/` between runs if you don't need to re-reference earlier attachments.

## See also

- Sibling channel plugins: [`openclaw`](../openclaw) (OpenClaw), [`claude-code`](../claude-code) (Claude Code).
- The wire-level protocol behind it all: [`synadia-ai/synadia-agent-sdk-docs`](https://github.com/synadia-ai/synadia-agent-sdk-docs).

## License

Apache-2.0
