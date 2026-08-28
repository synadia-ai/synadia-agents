# Flue NATS Channel

Expose a running [Flue](https://flueframework.com/) agent as a [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs) host.

Every running sidecar instance registers one configured Flue target as a NATS micro service. Protocol callers can discover it, send prompts, receive streamed response chunks, and monitor liveness through the standard `status` and heartbeat surfaces.

```text
Synadia Agent Protocol caller
  → NATS
  → Flue NATS Channel
  → @flue/sdk
  → running Flue app / agent
```

This package is a narrow channel wrapper for Flue. It is not a generic NATS toolkit, a Flue fork, or an LLM provider.

## Prerequisites

- [Bun](https://bun.sh/) for local commands.
- A reachable NATS server, or a NATS CLI context.
- A running Flue app with an agent reachable through the Flue SDK HTTP surface.

## Install

From this monorepo:

```bash
cd agents/flue
bun install
```

## Quickstart

Start NATS and a Flue app first, then run the sidecar:

```bash
bun src/cli.ts start \
  --nats-url nats://127.0.0.1:4222 \
  --owner acme \
  --name support \
  --subject-token flue \
  --flue-base-url http://127.0.0.1:3583 \
  --flue-agent assistant \
  --flue-instance customer-123 \
  --flue-session ticket-123
```

Expected startup output:

```text
flue agent listening on agents.prompt.flue.<owner>.<name>
press Ctrl+C to stop
```

With the quickstart values above, callers use:

```text
agents.prompt.flue.acme.support
agents.status.flue.acme.support
agents.hb.flue.acme.support
```

Only `prompt` forwards work to Flue. `status` and `hb` are sidecar-owned protocol liveness surfaces.

## Configuration

The sidecar can be configured with CLI flags, environment variables, or a TOML file.

Effective precedence is:

1. CLI flags
2. Environment variables
3. TOML config file
4. Built-in defaults

Default config path:

```text
~/.config/synadia/flue-nats-channel.toml
```

Print a template:

```bash
bun src/cli.ts configure --print-template
```

Template:

```toml
[nats]
url = "nats://127.0.0.1:4222"
context = "local"
creds = "/path/to/user.creds"

[agent]
owner = "acme"
name = "support"
subject_token = "flue"
heartbeat_interval_s = 30
keepalive_interval_s = 30

[flue]
base_url = "http://127.0.0.1:3583"
agent = "assistant"
instance = "customer-123"
session = "ticket-123"
transport = "http-stream"
```

### NATS settings

| Field | CLI | Environment | TOML | Default | Notes |
| --- | --- | --- | --- | --- | --- |
| URL | `--nats-url` | `NATS_URL` | `[nats].url` | `nats://127.0.0.1:4222` | Direct NATS server URL. |
| Context | `--nats-context` | `NATS_CONTEXT` | `[nats].context` | — | NATS CLI context name. If set, context mode is used. |
| Creds | `--nats-creds` | `NATS_CREDS` / `NATS_CREDENTIALS` | `[nats].creds` | — | Creds file for URL mode. |

If `context` is set, connection details and auth come from the NATS CLI context. If URL mode is used and `creds` is set, the sidecar uses the creds file when opening the NATS connection.

Do not commit real credentials. Prefer contexts or environment-managed secret paths for deployments.

### Agent settings

| Field | CLI | Environment | TOML | Default | Notes |
| --- | --- | --- | --- | --- | --- |
| Owner | `--owner` | `SYNADIA_FLUE_OWNER`, then `SYNADIA_OWNER` (fleet-wide) | `[agent].owner` | `$USER` or `unknown` | Fourth token in `agents.prompt.<agent>.<owner>.<session>`. |
| Name | `--name` | `SYNADIA_FLUE_NAME`, then `SYNADIA_NAME` (fleet-wide) | `[agent].name` | `main` | Fifth token in `agents.prompt.<agent>.<owner>.<session>`. |
| Subject token | `--subject-token` | — | `[agent].subject_token` | `flue` | Third token in `agents.prompt.<agent>.<owner>.<session>`. |
| Heartbeat interval | `--heartbeat-interval-s` | — | `[agent].heartbeat_interval_s` | `30` | Seconds between heartbeat publications. |
| Keepalive interval | `--keepalive-interval-s` | — | `[agent].keepalive_interval_s` | `30` | Seconds between in-flight keepalive chunks. |

Subject tokens are sanitized to the protocol-safe character set.

### Flue settings

| Field | CLI | Environment | TOML | Default | Notes |
| --- | --- | --- | --- | --- | --- |
| Base URL | `--flue-base-url` | `FLUE_BASE_URL` | `[flue].base_url` | `http://127.0.0.1:3583` | Flue app base URL. |
| Agent | `--flue-agent` | `FLUE_AGENT` | `[flue].agent` | `assistant` | Flue agent name. |
| Instance | `--flue-instance` | `FLUE_INSTANCE` | `[flue].instance` | `default` | Flue instance identifier. |
| Session | `--flue-session` | `FLUE_SESSION` | `[flue].session` | `default` | Flue session identifier sent in the prompt payload. |
| Transport | `--flue-transport` | `FLUE_TRANSPORT` | `[flue].transport` | `http-stream` | `http-stream`, `http-sync`, or `websocket`. |

`http-stream` is the default transport. Use `http-sync` when you want a single final response. `websocket` is available for deployments that support Flue's WebSocket agent connection path.

## Commands

| Command | Purpose |
| --- | --- |
| `bun src/cli.ts configure --print-template` | Print a TOML config template. |
| `bun src/cli.ts doctor` | Validate resolved config and probe Flue reachability. |
| `bun src/cli.ts start` | Start the long-running NATS channel sidecar. |

All commands accept the same config override flags.

## Run with a NATS context

Use this when your environment already manages NATS auth through the `nats` CLI:

```bash
bun src/cli.ts start \
  --nats-context prod \
  --owner acme \
  --name support \
  --subject-token flue \
  --flue-base-url http://127.0.0.1:3583 \
  --flue-agent assistant \
  --flue-instance customer-123 \
  --flue-session ticket-123
```

## Run with URL + creds file

Use this when the sidecar should connect directly to a NATS URL with a creds file:

```bash
bun src/cli.ts start \
  --nats-url nats://127.0.0.1:4222 \
  --nats-creds /path/to/user.creds \
  --owner acme \
  --name support \
  --subject-token flue \
  --flue-base-url http://127.0.0.1:3583 \
  --flue-agent assistant \
  --flue-instance customer-123 \
  --flue-session ticket-123
```

## Doctor

Run a diagnostic before starting the sidecar or filing a bug:

```bash
bun src/cli.ts doctor \
  --flue-base-url http://127.0.0.1:3583 \
  --flue-agent echo \
  --flue-instance demo \
  --owner acme \
  --name support
```

Example output for a reachable Flue app:

```text
ok	config	agent flue/acme/support
ok	flue-http	http://127.0.0.1:3583/agents/echo/demo returned HTTP 405 (reachable; GET probe method unsupported)
```

HTTP `405` means the Flue server is reachable but does not accept the doctor's GET probe method at that agent route. It is not a connectivity failure.

## Testing

Run the package checks:

```bash
bun run typecheck
bun test
```

Run a protocol smoke test against a local NATS server:

```bash
nats-server -p 4222
bun run smoke:protocol
```

`smoke:protocol` uses a real local NATS broker and an injected Flue client. It verifies discovery, prompt routing, ack, status, response chunks, and stream termination.

Run a real Flue smoke test when you have a Flue dev server with a deterministic echo-style agent available:

```bash
FLUE_BASE_URL=http://127.0.0.1:3583 \
FLUE_AGENT=echo \
FLUE_INSTANCE=demo \
FLUE_SESSION=demo \
SMOKE_PROMPT=hello \
SMOKE_EXPECTS=echo:hello \
bun run smoke:real-flue
```

`smoke:real-flue` exercises the real `@flue/sdk` and Flue runtime boundary over NATS. The smoke test concatenates streamed response chunks before checking `SMOKE_EXPECTS`, so chunk boundaries do not need to match the expected text exactly.

## Troubleshooting

### `doctor` reports HTTP 405

Treat this as reachable-method-unsupported unless prompt smokes also fail.

### WebSocket fails with `Flue WebSocket connection failed`

Use `http-stream` or `http-sync` unless your Flue deployment supports WebSocket agent connections.

### NATS connection fails with creds

Check whether you are using context mode or URL mode:

- Context mode: `--nats-context` / `NATS_CONTEXT`; auth comes from the NATS context.
- URL mode: `--nats-url` plus optional `--nats-creds`; creds are wired into the connection options.

If both context and URL are configured, context mode wins.

### Environment overrides do not seem to work

Remember the precedence rule:

```text
CLI > environment > config file > defaults
```

For owner specifically:

```text
--owner > SYNADIA_FLUE_OWNER > SYNADIA_OWNER > [agent].owner > USER/default
```

### Attachments fail

Expected. The sidecar currently maps text prompts only and rejects attachments explicitly.

## Limitations

- Text prompts only; attachments are not supported.
- One configured Flue target per sidecar process.
- `websocket` support depends on the Flue deployment's WebSocket agent connection behavior.
- Local faux-echo smoke tests prove runtime/SDK compatibility, not model quality.

## See also

- Sibling channel plugins: [`pi`](../pi), [`openclaw`](../openclaw), [`claude-code`](../claude-code), [`hermes`](../hermes), [`deerflow`](../deerflow), [`eve`](../eve), [`open-agent`](../open-agent), [`opencode`](../opencode), and [`codex`](../codex).
- TypeScript host SDK: [`../../agent-sdk/typescript`](../../agent-sdk/typescript).
- Wire protocol: [`synadia-ai/synadia-agent-sdk-docs`](https://github.com/synadia-ai/synadia-agent-sdk-docs).
