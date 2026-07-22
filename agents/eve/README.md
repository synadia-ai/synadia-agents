# Eve NATS Channel

Expose a running [Vercel Eve](https://github.com/vercel/eve) agent as a [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs) host.

Eve is an agent *framework*: you build your own agent in it, and every Eve agent serves a default HTTP session API (`/eve/v1/session*`, NDJSON streaming). Eve's own channel system cannot hold a long-lived NATS connection (no lifecycle hook; serverless deploys), so this package runs as a **sidecar**: a standalone process that registers on NATS and drives the Eve agent over HTTP via Eve's typed client (`eve/client`).

```text
Synadia Agent Protocol caller
  → NATS
  → Eve NATS Channel (this sidecar)
  → eve/client (HTTP, NDJSON stream)
  → your Eve agent (eve dev or a deployment)
```

Protocol callers can discover the agent, send prompts (with attachments), receive streamed response chunks, answer Eve's human-in-the-loop input requests via §7 mid-stream queries, and monitor liveness through the standard `status` and heartbeat surfaces.

This package is a narrow channel wrapper for Eve. It is not a generic NATS toolkit, an Eve fork, or an LLM provider.

## Prerequisites

- [Bun](https://bun.sh/) for the sidecar itself.
- A reachable NATS server, or a NATS CLI context.
- A running Eve agent — `npx eve dev` locally (Node ≥ 24), or a deployed Eve app.

## Install

From this monorepo:

```bash
cd agents/eve
bun install
```

## Quickstart

Start NATS and an Eve agent first, then run the sidecar:

```bash
bun src/cli.ts start \
  --nats-url nats://127.0.0.1:4222 \
  --owner acme \
  --name support \
  --eve-base-url http://127.0.0.1:2000
```

Expected startup output:

```text
eve agent listening on agents.prompt.eve.<owner>.<name>
press Ctrl+C to stop
```

With the quickstart values above, callers use:

```text
agents.prompt.eve.acme.support
agents.status.eve.acme.support
agents.hb.eve.acme.support
```

Only `prompt` forwards work to Eve. `status` and `hb` are sidecar-owned protocol liveness surfaces.

## How prompts map to Eve

- One sidecar process drives **one Eve conversation**. The Eve session is created lazily on the first prompt and continued on every following prompt (`session.waiting` parks between turns). When Eve ends the session (`session.completed` / `session.failed`), the sidecar's client resets and the next prompt starts a fresh Eve session — the stream announces this with a status chunk.
- Attachments are supported (`attachments_ok=true`). Protocol attachments become inline `data:` URL file parts on the Eve user message; the media type is derived from the filename extension.
- Eve stream events map to protocol chunks: assistant text deltas become `response` chunks; tool/action activity, subagent calls, compaction, and authorization events become `status` chunks; `result.completed` structured outputs are emitted as JSON `response` chunks at the end of the turn.
- Eve `input.requested` (HITL approvals/questions) becomes a §7 `query` chunk per request: the caller replies with an option number, id, label, or freeform text on the query's reply subject. On timeout (default 120 s) or an unresolvable reply, the sidecar auto-answers a deny-shaped option when one exists, otherwise the turn fails.

## Configuration

The sidecar can be configured with CLI flags, environment variables, or a TOML file.

Effective precedence is:

1. CLI flags
2. Environment variables
3. TOML config file
4. Built-in defaults

Default config path (override with `SYNADIA_EVE_CONFIG`):

```text
~/.config/synadia/eve-nats-channel.toml
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
subject_token = "eve"
heartbeat_interval_s = 30
keepalive_interval_s = 30

[eve]
base_url = "http://127.0.0.1:2000"
# auth_token = "bearer-token-for-deployed-agents"
ask_timeout_s = 120
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
| Owner | `--owner` | `SYNADIA_EVE_OWNER`, then `SYNADIA_OWNER` (fleet-wide) | `[agent].owner` | `$USER` or `unknown` | Fourth token in `agents.prompt.<agent>.<owner>.<session>`. |
| Name | `--name` | `SYNADIA_EVE_NAME`, then `SYNADIA_NAME` (fleet-wide) | `[agent].name` | `main` | Fifth token in `agents.prompt.<agent>.<owner>.<session>`. |
| Subject token | `--subject-token` | — | `[agent].subject_token` | `eve` | Third token in `agents.prompt.<agent>.<owner>.<session>`. |
| Heartbeat interval | `--heartbeat-interval-s` | — | `[agent].heartbeat_interval_s` | `30` | Seconds between heartbeat publications. |
| Keepalive interval | `--keepalive-interval-s` | — | `[agent].keepalive_interval_s` | `30` | Seconds between in-flight keepalive chunks. |

Subject tokens are sanitized to the protocol-safe character set.

### Eve settings

| Field | CLI | Environment | TOML | Default | Notes |
| --- | --- | --- | --- | --- | --- |
| Base URL | `--eve-base-url` | `EVE_BASE_URL` | `[eve].base_url` | `http://127.0.0.1:2000` | Eve agent server base URL (`eve dev` default port). |
| Auth token | `--eve-auth-token` | `EVE_AUTH_TOKEN` | `[eve].auth_token` | — | Bearer token for deployed Eve agents. Local `eve dev` needs none. |
| Ask timeout | `--ask-timeout-s` | `EVE_ASK_TIMEOUT_S` | `[eve].ask_timeout_s` | `120` | Seconds a §7 HITL query waits for the caller's reply. |

The auth token is used for the `Authorization: Bearer` header only; it never appears in NATS service metadata (the metadata advertises `eve_auth: bearer|none`). Vercel OIDC deployment protection is out of scope for v1 — use a bearer-capable route or run against `eve dev`.

## Commands

| Command | Purpose |
| --- | --- |
| `bun src/cli.ts configure --print-template` | Print a TOML config template. |
| `bun src/cli.ts doctor` | Validate resolved config and probe Eve reachability. |
| `bun src/cli.ts start` | Start the long-running NATS channel sidecar. |

All commands accept the same config override flags.

## Run with a NATS context

Use this when your environment already manages NATS auth through the `nats` CLI:

```bash
bun src/cli.ts start \
  --nats-context prod \
  --owner acme \
  --name support \
  --eve-base-url http://127.0.0.1:2000
```

## Run with URL + creds file

Use this when the sidecar should connect directly to a NATS URL with a creds file:

```bash
bun src/cli.ts start \
  --nats-url nats://127.0.0.1:4222 \
  --nats-creds /path/to/user.creds \
  --owner acme \
  --name support \
  --eve-base-url http://127.0.0.1:2000
```

## Doctor

Run a diagnostic before starting the sidecar or filing a bug:

```bash
bun src/cli.ts doctor --eve-base-url http://127.0.0.1:2000
```

Example output for a reachable local Eve dev server:

```text
ok	config	agent eve/acme/support → http://127.0.0.1:2000 (auth: none)
ok	eve-health	http://127.0.0.1:2000/eve/v1/health returned HTTP 200
ok	eve-info	agent "my-agent" (model anthropic/claude-sonnet-5)
```

`eve-health` probes `GET /eve/v1/health`; `eve-info` reads `GET /eve/v1/info` best-effort for the agent name and model.

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

`smoke:protocol` uses a real local NATS broker and an injected fake Eve client. It verifies discovery metadata (`attachments_ok=true`), prompt streaming, the §7 HITL query round-trip, attachment mapping, ack, and stream termination.

Run a real Eve smoke test locally (needs Node ≥ 24 on PATH for `eve dev`; the fixture uses a deterministic `mockModel`, so no provider key is required):

```bash
( cd test/fixtures/eve-agent && npm install )   # once
bun run smoke:real-eve
```

`smoke:real-eve` spawns `npx eve dev --no-ui` on the fixture, waits for `/eve/v1/health`, then discovers and prompts the sidecar twice over NATS — asserting the echo text and that the second prompt continues the same Eve session.

## Troubleshooting

### `eve server unreachable at <url>`

The sidecar could not POST to the Eve session route. Check that the Eve agent is running (`npx eve dev`, or your deployment URL), that `--eve-base-url` matches, and run `bun src/cli.ts doctor`.

### `doctor` reports `reachable but unauthorized`

The Eve server answered `401`/`403`. Deployed Eve agents require auth — set `[eve] auth_token` (or `EVE_AUTH_TOKEN`) to a bearer token the deployment accepts. Local `eve dev` is unauthenticated.

### HITL queries time out

Eve asked for operator input, but no caller reply arrived within `ask_timeout_s`. If the request had a deny-shaped option (`deny` / `no` / `cancel` / `reject` / `decline`), the sidecar auto-answered it and the turn continued; otherwise the turn failed with a 500. Raise `--ask-timeout-s` if your operators need longer.

### `eve authorization required: …` then the stream ends

An Eve connection/tool needs user authorization (e.g. an OAuth webhook). The turn parks on Eve's side; complete the authorization (the status chunk includes the webhook URL when there is one) and send the next prompt to continue the session.

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
--owner > SYNADIA_EVE_OWNER > SYNADIA_OWNER > [agent].owner > USER/default
```

## Limitations

- One Eve conversation per sidecar process; concurrent prompts are serialized into it (the protocol envelope has no session field to multiplex on).
- No cancellation bridging — protocol v0.3 has no host-side cancel signal, so a caller-side cancel does not cancel the Eve turn.
- Eve reasoning deltas are not forwarded (candidate for an opt-in flag later).
- Vercel OIDC deployment protection is not supported in v1; bearer tokens only.
- The mockModel smoke proves runtime/wire compatibility, not model quality.

## See also

- Sibling channel plugins: [`pi`](../pi), [`openclaw`](../openclaw), [`claude-code`](../claude-code), [`hermes`](../hermes), [`deerflow`](../deerflow), [`open-agent`](../open-agent), [`opencode`](../opencode), [`codex`](../codex), [`acp`](../acp), and [`flue`](../flue).
- TypeScript host SDK: [`../../agent-sdk/typescript`](../../agent-sdk/typescript).
- Wire protocol: [`synadia-ai/synadia-agent-sdk-docs`](https://github.com/synadia-ai/synadia-agent-sdk-docs).
