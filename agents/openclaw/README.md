# @synadia-ai/nats-channel

NATS channel plugin for [OpenClaw](https://openclaw.ai). Every configured OpenClaw agent becomes discoverable, addressable, and streamable over NATS — anyone running a [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs) client (e.g. [`@synadia-ai/agents`](../../client-sdk/typescript) or [`synadia-ai-agents`](../../client-sdk/python)) can find your agent, prompt it, and stream the reply back.

## Install

```bash
openclaw plugins install @synadia-ai/nats-channel
```

If your OpenClaw config has a non-empty `plugins.allow` list, add `"nats"` to it — that list, if set, gates which non-bundled plugins are enabled.

## Quickstart (env vars)

Set env vars and start the gateway — the channel auto-bootstraps on first start:

```bash
# Pick one connection path:
export NATS_CONTEXT=ngs                       # a NATS CLI context (recommended for NGS / managed NATS)
# — or —
export NATS_URL=nats://demo.nats.io            # raw URL
export NATS_CREDENTIALS=/path/to/your.creds   # optional, for NKEY/JWT auth

export NATS_AGENT_NAME=my-agent               # required: agent identity (5th subject token)
export NATS_OWNER=my-org                      # optional: 4th subject token (defaults to "default")

openclaw gateway
```

The channel comes up on first start at `agents.prompt.oc.<owner>.<agentName>`. **No edits to `~/.openclaw/openclaw.json` needed** — the plugin's account resolver falls back to a `"default"` account when none is configured and fills every field from env vars. No `openclaw configure` step, no extensions/ symlink.

> **Only one account is active at a time.** The plugin runs a single gateway process and registers one account on it. Adding multiple `accounts.<id>` blocks in your config doesn't register multiple agents simultaneously — pick the one you want active.

## Configure via the wizard (alternative)

> **Known issue on OpenClaw 2026.5.4+.** The wizard's channel list (`openclaw configure --section channels`, `openclaw channels add`) doesn't currently surface npm-installed channel plugins that aren't in OpenClaw's official channel catalog. Tracked upstream; until then, prefer the env-var quickstart above.

If you're on an older OpenClaw (or the catalog enrollment lands), the wizard path still works:

```bash
openclaw configure --section channels
```

Pick **NATS Agent Network** and answer the prompts. The only required field is the **agent name** (alphanumeric, `-`, `_` — no spaces or dots; it becomes part of a NATS subject); the rest fall back to sensible defaults (`demo.nats.io`, `default` owner, no auth).

After restarting OpenClaw, your agent is reachable at:

```
agents.prompt.oc.<owner>.<agentName>
```

### Three common configurations

**Local dev — public demo NATS:**

```bash
openclaw config set channels.nats.accounts.default.agentName "my-agent"
# url defaults to demo.nats.io; owner defaults to "default"
```

**Production with a NATS CLI context** (already configured via `nats context add`):

```bash
openclaw config set channels.nats.accounts.default.agentName "my-agent"
openclaw config set channels.nats.accounts.default.context "prod"
openclaw config set channels.nats.accounts.default.owner "acme"
```

**NGS or other auth via a `.creds` file:**

```bash
openclaw config set channels.nats.accounts.default.agentName "my-agent"
openclaw config set channels.nats.accounts.default.url "tls://connect.ngs.global"
openclaw config set channels.nats.accounts.default.credentials "/home/me/.config/nats/ngs.creds"
openclaw config set channels.nats.accounts.default.owner "acme"
```

Or write directly to `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "nats": {
      "accounts": {
        "default": {
          "agentName": "my-agent",
          "owner": "acme",
          "context": "prod"
        }
      }
    }
  }
}
```

Restart with `openclaw gateway restart`.

### Configuration reference

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `agentName` | yes | — | The 5th token in your agent's subject. Letters, digits, `-`, `_`. |
| `owner` | no | `default` | The 4th token — your operator/account namespace. |
| `url` | no | `nats://demo.nats.io` | NATS server URL. Ignored when `context` resolves successfully. |
| `context` | no | — | Name of a NATS CLI context (file under `~/.config/nats/context/<name>.json`). Sources `url` and `credentials` from there. |
| `credentials` | no | — | Path to a `.creds` file (NGS, NKEY/JWT auth). |
| `description` | no | `OpenClaw agent <agentName>` | Shown in `$SRV.INFO` so callers know what they discovered. |
| `enabled` | no | `true` | Set to `false` to keep the account block in config but skip connecting. |

> **`org` → `owner`.** The pre-0.3 `org` field is still accepted as a deprecated alias and logs a one-time warning until you rename it.

### Environment variables

Each field has a matching env var. Useful for containers and any setup where you don't want secrets baked into a config file.

| Variable | Sets | Notes |
|----------|------|-------|
| `NATS_CONTEXT` | `context` | Highest precedence — see below. |
| `NATS_URL` | `url` | |
| `NATS_AGENT_NAME` | `agentName` | |
| `NATS_DESCRIPTION` | `description` | |
| `NATS_OWNER` | `owner` | |
| `NATS_ORG` | `owner` | Legacy alias. |
| `NATS_CREDENTIALS` | `credentials` | |

### Resolution order

When several sources set the same field, this is who wins. Later steps override earlier ones, except `$NATS_CONTEXT` which is applied last as a single source of truth for `url` + `credentials`.

1. Built-in default (`nats://demo.nats.io` for `url`, `default` for `owner`)
2. Account config in `openclaw.json`
3. `config.context` — wizard-selected NATS CLI context
4. Per-field env vars (`$NATS_URL`, `$NATS_CREDENTIALS`, `$NATS_AGENT_NAME`, …)
5. **`$NATS_CONTEXT`** — wins over everything else

A failure in step 3 or 5 (missing file, malformed JSON, no `url`) is logged and downgraded — the gateway falls back to whatever the previous step resolved instead of crashing.

> **Auth limitations.** A NATS CLI context is read for `url`, `token`, `user`/`password`, and `creds`. Inline `nkey`, `user_jwt`/`user_seed`, and the TLS triple `cert`/`key`/`ca` are silently dropped — for those, point `credentials` at a `.creds` file directly.

## Verify

```bash
# Find your agent (and any others on the same NATS)
nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s

# Watch heartbeats — your agent beats every ~5 s
nats sub 'agents.hb.*.*.*'
```

A successful `$SRV.INFO.agents` response for an OpenClaw agent looks like:

```json
{
  "type": "io.nats.micro.v1.info_response",
  "name": "agents",
  "id": "PYYZRKNVLK6CA1LC6L7FZU",
  "version": "0.4.0",
  "description": "My OpenClaw agent",
  "metadata": {
    "agent": "openclaw",
    "owner": "me",
    "session": "default",
    "protocol_version": "0.3",
    "platform": "openclaw",
    "description": "My OpenClaw agent"
  },
  "endpoints": [
    {
      "name": "prompt",
      "subject": "agents.prompt.oc.me.my-agent",
      "queue_group": "agents",
      "metadata": { "max_payload": "8MB", "attachments_ok": "true" }
    },
    {
      "name": "status",
      "subject": "agents.status.oc.me.my-agent",
      "queue_group": "agents"
    }
  ]
}
```

If you see your `agents.prompt.oc.<owner>.<agentName>` subject in the response, you're discoverable.

## Talk to your agent

From the CLI:

```bash
# Plain text prompt
nats req agents.prompt.oc.<owner>.<agentName> "Hello!" \
  --wait-for-empty --reply-timeout 30s --timeout 60s

# JSON envelope (caller SDKs use this form under the hood)
nats req agents.prompt.oc.<owner>.<agentName> '{"prompt":"Hello!"}' \
  --wait-for-empty --reply-timeout 30s --timeout 60s

# With an attachment
nats req agents.prompt.oc.<owner>.<agentName> '{
  "prompt": "describe this image",
  "attachments": [{"filename":"pic.png","content":"<base64>"}]
}' --wait-for-empty --reply-timeout 30s --timeout 120s
```

`--wait-for-empty` is required: replies stream as multiple chunks and end with an empty terminator message.

`--reply-timeout` matters too. Its default is **300 ms** — the maximum gap allowed between consecutive replies. The agent publishes an immediate `{type:"status",data:"ack"}` chunk on request receipt, but the LLM's first response chunk typically lands 1–2 s later, so the default fires before the first response and the CLI exits after just the ack. Setting `--reply-timeout 30s` gives the LLM enough warm-up time. SDK callers (`requestMany` with `strategy:"sentinel"`) don't hit this — they wait the full `maxWait` regardless of inter-arrival gaps.

From TypeScript using `@synadia-ai/agents`:

```ts
import { connect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const nc = await connect({ servers: "nats://localhost:4222" });
const agents = new Agents({ nc });

const [agent] = await agents.discover({ filter: { agent: "openclaw" } });

for await (const msg of await agent!.prompt("what can you do?")) {
  if (msg.type === "response") process.stdout.write(msg.text);
}

await agents.close();
await nc.close();
```

## Attachments

When a request envelope carries `attachments`, each file is decoded and staged at:

```
<stateDir>/media/nats-channel/<agentName>/<uuid>/<filename>
```

`<stateDir>` is the OpenClaw state directory (typically `~/.openclaw`). The `media/` prefix is required: OpenClaw's media-access allowlist only permits paths under `<stateDir>/media`, so staged files have to live there for the agent's tools to be allowed to read them.

The absolute paths are prepended to the prompt text so OpenClaw's pipeline (and any tool the agent has access to) can open them by path. Files staged earlier in the gateway's lifetime stay on disk so follow-up turns can reference them; the whole `<agentName>/` directory is removed when the gateway stops.

Encode files with `base64 -w0 <file>` (Linux/macOS) or `Buffer.from(bytes).toString("base64")` in Node before embedding in the JSON envelope. Caller SDKs do this for you.

Caller-side limits (rejected with `400` if violated):

- `content` must be standard-alphabet padded base64 — no URL-safe variant, no whitespace.
- `filename` must be a plain basename. Path separators, `..`, absolute paths, and NUL bytes are rejected, not silently flattened.
- The fully-encoded request must fit within the server-negotiated `max_payload` (1 MB on a default `nats-server`, more if the operator raised `--max_payload`).

## Outbound messages from the agent

When OpenClaw's `sendText` fires (the agent proactively pushing a message rather than replying to a prompt), the channel publishes to:

```
agents.oc.<owner>.<agentName>.outbound
```

This is a fire-and-forget pub/sub subject — subscribe with `nats sub agents.oc.<owner>.<agentName>.outbound` to consume them. **The payload is raw UTF-8 text, not a JSON envelope** — pipe it straight into your consumer, don't try to parse it as JSON. It's an OpenClaw-specific extension, not part of the protocol; the subject deliberately sits under the agent root for easy locating relative to the prompt subject.

## Multi-tenancy

The agent subject layout has no per-tenant slot. For real isolation between tenants or environments, use **NATS accounts** and subject permissions — that's a server-side configuration, not a plugin one. Within a single account, agents with distinct `owner` values coexist cleanly.

## Troubleshooting

- **`config field 'org' is deprecated`** — rename `org` → `owner` in `openclaw.json`. The old name still works, just noisy in logs.
- **`[nats] disconnected from … — retrying…`** — transient. The channel keeps retrying indefinitely (`maxReconnectAttempts: -1` from the SDK's `withAgentReconnectDefaults`), so just leave it — it will recover when the server is reachable again.
- **`[nats] connection closed — agent is off-bus until restart`** — terminal. The client gave up reconnecting; the typical cause is repeated identical auth errors (the one path nats.js does not retry through, regardless of our defaults). Check `url` and (if using credentials) that the `.creds` file exists and is readable by the gateway process, then restart.
- **`nats req` returns only the initial ack and exits** — pass `--reply-timeout 30s` (default is 300 ms, shorter than the gap between the ack chunk and the LLM's first response). See the "Talk to your agent" section above for the full command. `--wait-for-empty` alone isn't enough.
- **`nats req` hangs or returns nothing** — pass `--wait-for-empty`. The protocol ends streams with an empty-body message, not a single response.
- **`400 attachment[N] has invalid base64 content`** — the caller emitted URL-safe base64 or unpadded output. `Buffer.from(bytes).toString("base64")` (Node) produces the right form.
- **`400 attachment[N] has unsafe filename`** — send the basename only (`"pic.png"`), not a path (`"./images/pic.png"`).
- **`plugins.allow is empty` warning** — harmless, plugins still load. To silence it, add `"nats"` (and any other plugins you want enabled) to `plugins.allow`.

## Development

```bash
bun install
bun run build          # compile ./index.ts + ./setup-entry.ts → ./dist (required before publish)
bun run test           # protocol unit tests, no nats-server needed
bun run test:smoke     # wire-level smoke against nats-server on 127.0.0.1:4222
```

The npm tarball ships **compiled** entries under `dist/` (declared via
`openclaw.runtimeExtensions` and `openclaw.runtimeSetupEntry`).
OpenClaw 2026.5.4+ refuses to install plugins that only ship TS source.
`prepublishOnly` runs the build automatically.

The smoke test needs a `nats-server` running on `127.0.0.1:4222` — install per [the upstream docs](https://docs.nats.io/running-a-nats-service/introduction/installation) (`brew install nats-server` on macOS) then start it in another terminal with `nats-server`.

The smoke test drives a minimal spec-compliant service assembled from this repo's own protocol module and verifies `$SRV.INFO` shape, heartbeat fields, the four 400 paths, the `ack → response → terminator` cycle, and attachment staging + cleanup.

The plugin pulls `@synadia-ai/agents` (caller-side primitives) and `@synadia-ai/agent-service` (host-side encoders + heartbeat helpers) via `file:` links to the SDK checkouts in this monorepo. See [`README-DEV.md`](../../README-DEV.md) at the repo root for the build/install dance when iterating locally.

## See also

- Sibling channel plugins: [`pi`](../pi) (PI Agent), [`claude-code`](../claude-code) (Claude Code), [`deerflow`](../deerflow) (DeerFlow), [`flue`](../flue) (Flue), and [`opencode`](../opencode) (OpenCode).
- The wire-level protocol behind it all: [`synadia-ai/synadia-agent-sdk-docs`](https://github.com/synadia-ai/synadia-agent-sdk-docs).

## License

Apache-2.0
