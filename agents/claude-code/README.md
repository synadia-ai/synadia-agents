# NATS Channel for Claude Code

Connect Claude Code to NATS messaging as a spec-compliant
[NATS Agent Protocol](https://github.com/synadia-ai/nats-agent-sdk-docs) v0.2.0 agent.

The MCP server registers an `agents` micro service, exposes a
`prompt` endpoint at `agents.cc.<owner>.<name>`, publishes heartbeats
at `agents.cc.<owner>.<name>.heartbeat`, and bridges prompt requests
into the Claude Code session. Replies stream back as typed JSON chunks
(`{"type":"response","data":"..."}`) terminated by an empty headerless
message - the protocol's uniform end-of-stream signal.

## Prerequisites

- [Bun](https://bun.sh) - the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.
- [NATS CLI](https://github.com/nats-io/natscli) - for managing contexts and testing.
- A NATS server to connect to (local or remote) - the plugin defaults to `demo.nats.io`.

## Quick Setup

**1. Add the marketplace.**

These are Claude Code commands - run `claude` to start a session first.

```
/plugin marketplace add synadia-ai/synadia-agents
```

**2. Install the plugin.**

```
/plugin install nats-channel@synadia-plugins
```

**3. Launch with the channel flag.**

```sh
claude --dangerously-load-development-channels plugin:nats-channel@synadia-plugins
```

By default, the server connects to `demo.nats.io` (no credentials required)
and registers a micro service on `agents.cc.<user>.<name>`, where
`<name>` defaults to the working directory name.

**4. (Optional) Configure the channel.**

The `/nats-channel:configure` skill manages connection, session naming,
and permissions. All state lives in `~/.claude/channels/nats/config.json`.

| Command | Description |
| --- | --- |
| `/nats-channel:configure` | Show current config, list available contexts, and offer to switch |
| `/nats-channel:configure list` | List available NATS CLI contexts |
| `/nats-channel:configure <context-name>` | Select a NATS CLI context to connect to |
| `/nats-channel:configure session <name>` | Override the session name (fourth token in `agents.cc.<user>.<name>`) |
| `/nats-channel:configure session clear` | Remove session name override, revert to CWD basename |
| `/nats-channel:configure permissions terminal` | Prompt for permissions in the terminal (default) |
| `/nats-channel:configure permissions query` | Relay permission prompts as protocol query chunks |
| `/nats-channel:configure permissions clear` | Reset permissions to default |
| `/nats-channel:configure clear` | Remove all configuration |

To connect to your own NATS server, use a NATS CLI context. List your contexts
with `nats context ls`, then:

```
/nats-channel:configure <context-name>
```

This writes the selected context to `~/.claude/channels/nats/config.json`.
The server reads connection details (URL, credentials) from
`~/.config/nats/context/<name>.json`.

**5. Send a prompt.**

With the [`@synadia-ai/agents`](../../client-sdk/typescript)
TypeScript SDK:

```ts
import { connect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const nc = await connect({ servers: "nats://localhost:4222" });
const agents = new Agents({ nc });
const [agent] = await agents.discover();
for await (const msg of await agent!.prompt("hello Claude")) {
  if (msg.type === "response") process.stdout.write(msg.text);
}
await agents.close();
await nc.close();
```

Or directly via the NATS CLI (plain-text shorthand per spec §5.1):

```sh
nats req agents.cc.<user>.<name> "Hello Claude" --replies=0 --timeout=90s
```

Claude's response streams back as typed JSON chunks on the reply subject;
an empty headerless message signals completion.

## Protocol compliance

This plugin implements the **NATS Agent Protocol v0.2.0** end-to-end:

- Registers as an `agents` NATS micro service (§3.1 - the bare subject-safe
  token).
- Service metadata includes `agent`, `owner`, `session`, and
  `protocol_version: "0.2"` (§3.2).
- `prompt` endpoint declares `max_payload: "1MB"`,
  `attachments_ok: "true"` (§2.1), and queue group `"agents"` (§3.3).
- Accepts both plain-text shorthand and JSON envelopes with optional
  base64-encoded attachments (§5.1, §5.2, §5.3). Inbound attachments
  are staged to a per-request temp directory and exposed to Claude via
  file paths.
- Rejects malformed envelopes, empty payloads, oversize requests, and
  invalid base64 with `Nats-Service-Error-Code: 400` (§9).
- Emits typed response chunks `{"type":"response","data":"..."}`
  (§6.3) terminated by an empty headerless message (§6.5). Large
  responses are split into multiple UTF-8-safe chunks that each fit
  under `max_payload`.
- Publishes periodic `{"type":"status","data":"ack"}` keep-alives (§6.4)
  every 30 s while a request is open, resetting the caller's 60-second
  inactivity timeout.
- Publishes heartbeats at `<subject>.heartbeat` every 30 s with the full
  §8.3 payload including `instance_id` (§8).
- Relays Claude Code permission prompts as mid-stream `query` chunks
  (§7) when `permissions.mode = query`.

The caller-side SDK at
[`client-sdk/typescript/`](../../client-sdk/typescript) is the
canonical counterpart.

## Session names

The micro service subject is `agents.cc.<user>.<name>`.

- **Default:** sanitized basename of the working directory (e.g., `my-project`)
- **Override:** set `NATS_SESSION_NAME` env var, or use `/nats-channel:configure session <name>`
- **Multiple sessions:** if the default name is already taken by another
  claude-code instance owned by the same user, the plugin auto-appends
  `-2`, `-3`, etc.

Discover running sessions via the protocol's discovery subjects:

```sh
nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s
nats req '$SRV.PING.agents' '' --replies=0 --timeout=2s
```

Or via the NATS Micro CLI:

```sh
nats micro ls
nats micro info agents
```

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send a response over NATS. Takes `request_id` + `text`. The server wraps the text in a `{"type":"response","data":...}` chunk. Set `done=false` for intermediate replies; `done=true` (default) emits the empty-body terminator. |

## Permissions

When Claude Code needs permission to run a tool, the plugin can either
prompt in the terminal (default) or relay the request as a protocol
query chunk on the active NATS stream. This is controlled by the
`permissions` config.

### Terminal mode (default)

Permission prompts appear directly in the Claude Code terminal. No extra
configuration needed.

### Query mode

Permission requests are emitted as `{"type":"query","data":{...}}`
chunks on the active stream's reply subject (spec §7). The caller
replies on the query's dynamic `_INBOX` with `yes`/`no`, and the plugin
forwards the decision back to the harness.

```
/nats-channel:configure permissions query
```

To switch back to terminal mode:

```
/nats-channel:configure permissions terminal
```

The legacy value `"nats"` is still accepted as an alias for `"query"` so
old configs keep working. The older `permissions.subject` override field
has been removed - query chunks always use a fresh NATS inbox per
request.

If Claude asks for permission while no NATS request is active (for
example from direct terminal input), the plugin denies by default in
`query` mode; use `permissions terminal` instead if you want interactive
approval in that case.

### Handling permission queries with the SDK

```ts
for await (const msg of await remote.prompt("rm -rf /tmp/stale")) {
  if (msg.type === "query") {
    await msg.reply("yes");  // or "no"
  }
  if (msg.type === "response") {
    process.stdout.write(msg.text);
  }
}
```

Or with the NATS CLI, by publishing to the `reply_subject` from the
query chunk:

```sh
nats pub _INBOX.Xj7k9Q2pA "yes"
```

If no reply is received within 2 minutes, the permission defaults to
**deny**.

## Access control

NATS server authentication and authorization handle access control. If a
user can connect and publish to `agents.cc.<user>.<name>`, they can
interact with Claude. No additional pairing or allowlist is needed.

## Configuration

State lives in `~/.claude/channels/nats/`:

| File | Purpose |
| --- | --- |
| `config.json` | Selected NATS context, session name override, and permission settings |
| `attachments/<request_id>/` | Per-request staged attachments; auto-cleaned on reply completion |

NATS CLI contexts live in `~/.config/nats/context/<name>.json`.

### config.json

```json
{
  "context": "my-context",
  "sessionName": "my-session",
  "permissions": {
    "mode": "query"
  }
}
```

| Field | Default | Description |
| --- | --- | --- |
| `context` | *(none - uses demo.nats.io)* | NATS CLI context name |
| `sessionName` | CWD basename | Override the session name |
| `permissions.mode` | `terminal` | `terminal` or `query` (`nats` accepted as legacy alias for `query`) |

### Environment variables

| Variable | Purpose |
| --- | --- |
| `NATS_SESSION_NAME` | Override the session name (fourth token in `agents.cc.<user>.<name>`) |
| `NATS_STATE_DIR` | Override the state directory (default: `~/.claude/channels/nats`) |
