# @synadia/nats-channel

> Currently published on npm as `@m64/nats-channel`; moving to `@synadia/nats-channel` once Synadia publishing access lands. Install commands below use the current name.

NATS channel plugin for [OpenClaw](https://openclaw.ai), implementing the **[NATS Agent Protocol](https://github.com/synadia-ai/nats-agent-sdk-docs) v0.2.0**.

Every configured OpenClaw agent becomes a discoverable, addressable, streaming agent on NATS. Callers using any SDK that speaks the protocol - e.g. [`@synadia/agents`](../../client-sdk/typescript) - can enumerate running OpenClaw agents, prompt them, and stream responses back.

Sibling implementations sharing the same wire protocol: [`pi`](../pi) (PI), [`claude-code`](../claude-code) (Claude Code).

## What each agent exposes

When OpenClaw starts the channel:

1. Connects to NATS using the configured URL and optional credentials.
2. Registers a NATS micro service named `agents` with spec metadata (`agent`, `owner`, `session`, `protocol_version`).
3. Adds a `prompt` endpoint at `agents.oc.<owner>.<agentName>` advertising `max_payload: 1MB` and `attachments_ok: true`.
4. Publishes heartbeats on `agents.oc.<owner>.<agentName>.heartbeat` every 30 s.
5. On each inbound prompt: decodes any attached files to `~/.openclaw/attachments/<agentName>/<uuid>/<filename>`, prepends their absolute paths to the prompt text, emits a `status: ack` chunk, dispatches the augmented prompt into OpenClaw's direct-DM pipeline, and streams each delivered block back as a typed `{type:"response",data}` chunk, terminating with the spec-mandated empty-body no-headers terminator.
6. Agent-initiated messages (the old `sendText` outbound path) still publish to `agents.oc.<owner>.<agentName>.outbound` - an OpenClaw-specific extension, not part of the spec.

Malformed envelopes, oversized payloads, invalid base64, and unsafe filenames are rejected at the wire with `Nats-Service-Error-Code: 400`. Staging and dispatch failures return `500`.

## Install

```bash
openclaw plugins install @m64/nats-channel
```

Or use the one-line installer with a guided config wizard:

```bash
curl -fsSL https://m64.io/nats-channels/openclaw.sh | bash
```

## Configure

Run the built-in setup wizard:

```bash
openclaw configure --section channels
```

Select **NATS Agent Network** and follow the prompts.

Or set fields via CLI:

```bash
openclaw config set channels.nats.accounts.default.agentName "my-agent"
openclaw config set channels.nats.accounts.default.url "nats://demo.nats.io"
openclaw config set channels.nats.accounts.default.description "My agent"
openclaw config set channels.nats.accounts.default.owner "acme"
```

Or write to `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "nats": {
      "accounts": {
        "default": {
          "url": "nats://demo.nats.io",
          "agentName": "my-agent",
          "description": "My OpenClaw agent",
          "owner": "acme"
        }
      }
    }
  }
}
```

Restart the gateway:

```bash
openclaw gateway restart
```

### Config fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `url` | no | `nats://localhost:4222` | NATS server URL |
| `agentName` | yes | - | 4th subject token (`agents.oc.<owner>.<agentName>`) |
| `description` | no | `OpenClaw agent <agentName>` | Shown via `$SRV.INFO` |
| `credentials` | no | - | Path to `.creds` file for NATS authentication |
| `owner` | no | `default` | 3rd subject token - operator/account namespace. Spec §2 requires a 4-token subject. |

> **Migrating from v0.1:** the old `org` field has been renamed `owner` (§3.2 terminology). The old name is still accepted as an alias with a deprecation warning in logs.

### Environment variables (Docker / containers)

All fields can be overridden via env vars:

| Env Var | Overrides | Example |
|---------|-----------|---------|
| `NATS_URL` | `url` | `nats://prod.example.com:4222` |
| `NATS_AGENT_NAME` | `agentName` | `my-agent` |
| `NATS_DESCRIPTION` | `description` | `Production agent` |
| `NATS_OWNER` | `owner` | `acme` |
| `NATS_ORG` | `owner` (legacy alias) | `acme` |
| `NATS_CREDENTIALS` | `credentials` | `/run/secrets/nats.creds` |

```yaml
# docker-compose.yml
environment:
  NATS_AGENT_NAME: my-agent
  NATS_URL: nats://nats:4222
  NATS_DESCRIPTION: Production agent
  NATS_OWNER: acme
```

## Verify

```bash
# Protocol-level discovery
nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s

# Micro service listing
nats micro list
nats micro info agents

# Watch heartbeats
nats sub 'agents.*.*.*.heartbeat'
```

## Talking to a running OpenClaw agent

Any caller speaking the protocol - a spec-compliant SDK or the `nats` CLI - can:

```bash
# Plain text prompt
nats req agents.oc.<owner>.<agentName> "Hello!" --wait-for-empty --timeout 60s

# JSON envelope (the SDK form)
nats req agents.oc.<owner>.<agentName> '{"prompt":"Hello!"}' --wait-for-empty --timeout 60s

# With an attachment
nats req agents.oc.<owner>.<agentName> '{
  "prompt": "describe this image",
  "attachments": [{"filename":"pic.png","content":"<base64>"}]
}' --wait-for-empty --timeout 120s
```

With the TypeScript SDK:

```ts
import { connect } from "@nats-io/transport-node";
import { Agents } from "@synadia/agents";

const nc = await connect({ servers: "nats://localhost:4222" });
const agents = new Agents({ nc });

const [agent] = await agents.discover({ filter: { agent: "openclaw" } });

for await (const msg of await agent!.prompt("what can you do?")) {
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
- **Terminator**: empty body **and no headers** (§6.5).
- **Errors**: `Nats-Service-Error-Code` header with `400`/`500`, followed by the terminator.

## Attachments

When a request envelope contains `attachments`, each file is decoded and staged at:

```
~/.openclaw/attachments/<agentName>/<uuid>/<filename>
```

The absolute paths are prepended to the prompt as:

```
[Attachments available at the following absolute paths]
- /home/you/.openclaw/attachments/my-agent/abcd-…/pic.png

<original prompt text>
```

OpenClaw's dispatch pipeline sees the list in the user message and the agent can open the files with its file tools. The whole `<agentName>` directory is removed when the gateway stops; within a gateway lifetime, attachments from earlier prompts remain on disk so follow-up turns can reference them.

Caller-side constraints (rejected with `400` if violated):

- `content` must be strict RFC 4648 §4 base64 - standard alphabet, padded, no URL-safe, no whitespace.
- `filename` must be a plain basename. Path separators (`/`, `\`), `..`, absolute paths, and NUL bytes are rejected rather than silently flattened.
- Full encoded envelope must fit within `max_payload` (1 MB).

Spec §5.5 reserves a future `attachments` endpoint at `agents.oc.<owner>.<agentName>.attachments` for chunked large-file upload; that lands in protocol 0.2 and will coexist with inline attachments.

## Agent-initiated messages (OpenClaw-specific)

When OpenClaw's outbound `sendText` fires, the channel publishes to:

```
agents.oc.<owner>.<agentName>.outbound
```

This is a pub/sub subject (fire-and-forget), not part of the spec. External listeners can subscribe with `nats sub agents.oc.<owner>.<agentName>.outbound`. The subject is deliberately under the agent root so it's easy to locate relative to the prompt subject.

## Tenant isolation

The spec reserves the four-token subject structure; there is no additional namespace slot. For multi-tenant isolation, use NATS accounts and subject permissions (spec §10.1). Within an account, agents with distinct `owner` tokens coexist cleanly.

## Discovery

Spec-compliant SDKs discover via `$SRV.PING.agents` / `$SRV.INFO.agents`. No custom `.inspect` endpoint (the pre-0.3 channel had one; it's gone - $SRV.INFO replaces it).

## Troubleshooting

- **`[nats] config field 'org' is deprecated`.** Rename `org` → `owner` in your `openclaw.json`. The old name still works but the warning will stay until you update.
- **Gateway fails with `NATS: disconnected`.** Check the configured URL and, if using credentials, that the `.creds` file exists and is readable.
- **`nats req` returns nothing or hangs.** Pass `--wait-for-empty`; the protocol signals end-of-stream with an empty-body message, not a single response.
- **`400 attachment[N] has invalid base64 content`.** The caller emitted URL-safe base64 or unpadded output. Switch to RFC 4648 §4 (standard alphabet, padded) - Node's `Buffer.from(bytes).toString("base64")` produces the correct form.
- **`400 attachment[N] has unsafe filename`.** Send the basename only (e.g. `"pic.png"`, not `"./images/pic.png"`).

## Development

```bash
bun install
bun run test           # protocol unit tests (no nats-server required)
bun run test:smoke     # wire-level smoke against nats-server on 127.0.0.1:4222
```

The smoke test drives a minimal spec-compliant service assembled from the repo's own `protocol.ts` + `attachments.ts` and verifies `$SRV.INFO` shape, heartbeat fields, four 400 paths, the `ack → response → terminator` cycle, and attachment staging + cleanup.

## License

MIT
