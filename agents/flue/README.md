# Flue NATS channel

TypeScript sidecar that exposes a running Flue agent as a Synadia Agent Protocol for NATS agent.

The sidecar sits between Synadia/NATS callers and Flue:

```text
Synadia client / nats req
  → NATS
  → AgentService
  → agents/flue sidecar
  → @flue/sdk
  → running Flue app / agent
```

This package is intentionally **Bun-first** for local commands. Flue's `--target node` flag is a Flue server compatibility target for the attached HTTP/WebSocket surface, not a preference for npm/Node tooling.

## Status and defaults

- Host-side protocol SDK: `AgentService` from `@synadia-ai/agent-service`.
- No hand-rolled Synadia Agent Protocol subject plumbing.
- Default Flue transport: `http-stream`.
- `websocket` is available as an explicit diagnostic option only.
- Attachments are rejected (`attachmentsOk: false`).
- NATS auth supports either a NATS context or URL mode with optional creds file.

`http-stream` is the default because the real Flue faux-echo smoke test verified it against a live Flue dev server. Flue 0.9.1's local Node WebSocket path returned server-side 500s during verification, so WebSocket is not the safe default.

## Install

```bash
cd agents/flue
bun install
```

## Configuration model

The sidecar can be configured by CLI flags, environment variables, or a small TOML file.

Precedence is:

```text
CLI flags > environment variables > config file > defaults
```

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
owner = "rene"
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

| Field | CLI | Environment | TOML | Notes |
|---|---|---|---|---|
| URL | `--nats-url` | `NATS_URL` | `[nats].url` | Defaults to `nats://127.0.0.1:4222`. |
| Context | `--nats-context` | `NATS_CONTEXT` | `[nats].context` | Preferred when auth is managed by the `nats` CLI. |
| Creds | `--nats-creds` | `NATS_CREDS` / `NATS_CREDENTIALS` | `[nats].creds` | Used in URL mode via `credsAuthenticator`. |

If `context` is set, the NATS CLI context is used and carries its own auth. If URL mode is used and `creds` is set, the sidecar wires the creds file into the NATS connection authenticator.

Never commit real creds files or seed-shaped dummy values. Tests deliberately use non-secret-shaped fixture text.

### Agent settings

| Field | CLI | Environment | TOML | Notes |
|---|---|---|---|---|
| Owner | `--owner` | `SYNADIA_FLUE_OWNER` | `[agent].owner` | Subject owner token; defaults to `$USER` or `unknown`. |
| Name | `--name` | `SYNADIA_FLUE_NAME` | `[agent].name` | Agent service name; defaults to `main`. |
| Subject token | `--subject-token` | — | `[agent].subject_token` | Protocol subject token; defaults to `flue`. |
| Heartbeat | `--heartbeat-interval-s` | — | `[agent].heartbeat_interval_s` | Defaults to `30`. |
| Keepalive | `--keepalive-interval-s` | — | `[agent].keepalive_interval_s` | Defaults to `30`. |

Subject tokens are sanitized to the protocol-safe character set.

### Flue settings

| Field | CLI | Environment | TOML | Notes |
|---|---|---|---|---|
| Base URL | `--flue-base-url` | `FLUE_BASE_URL` | `[flue].base_url` | Defaults to `http://127.0.0.1:3583`. |
| Agent | `--flue-agent` | `FLUE_AGENT` | `[flue].agent` | Flue agent name, e.g. `assistant` or `echo`. |
| Instance | `--flue-instance` | `FLUE_INSTANCE` | `[flue].instance` | Flue instance identifier. |
| Session | `--flue-session` | `FLUE_SESSION` | `[flue].session` | Flue session identifier. |
| Transport | `--flue-transport` | `FLUE_TRANSPORT` | `[flue].transport` | `http-stream`, `http-sync`, or `websocket`. Defaults to `http-stream`. |

## Run with a NATS context

Use this when your local or deployment environment already manages NATS auth through the `nats` CLI.

```bash
bun src/cli.ts start \
  --nats-context local \
  --owner rene \
  --name support \
  --subject-token flue \
  --flue-base-url http://127.0.0.1:3583 \
  --flue-agent assistant \
  --flue-instance customer-123 \
  --flue-session ticket-123
```

## Run with URL + creds file

Use this when you want the sidecar to connect directly to a NATS URL with a creds file.

```bash
bun src/cli.ts start \
  --nats-url nats://127.0.0.1:4222 \
  --nats-creds /path/to/user.creds \
  --owner rene \
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

For example, `--subject-token flue --owner rene --name support` listens on:

```text
agents.prompt.flue.rene.support
```

The sidecar registers a Synadia `AgentService` with:

- `agent: "flue"`
- configured owner/name/subject token
- `attachmentsOk: false`
- metadata describing the configured Flue target

`AgentService` handles ack, keepalive, error mapping, heartbeat/status endpoints, and stream termination.

## Doctor

Run a local diagnostic before starting or before filing a bug:

```bash
bun src/cli.ts doctor \
  --flue-base-url http://127.0.0.1:3583 \
  --flue-agent echo \
  --flue-instance real-smoke-dev \
  --owner rs \
  --name main
```

Expected reachable-Flue output can include HTTP `405`:

```text
ok	config	agent flue/rs/main
ok	flue-http	http://127.0.0.1:3583/agents/echo/real-smoke-dev returned HTTP 405 (reachable; GET probe method unsupported)
```

That `405` means the Flue server is reachable but does not accept the doctor's GET probe method at that agent route. It is not a connectivity failure.

## Verification

Run the full local ladder before PR handoff:

```bash
bun run typecheck
bun test
bun run smoke:protocol
FLUE_BASE_URL=http://127.0.0.1:3583 \
FLUE_AGENT=echo \
FLUE_INSTANCE=real-smoke-dev \
FLUE_SESSION=real-smoke-dev \
SMOKE_PROMPT=hello-real-flow \
SMOKE_EXPECTS=echo:hello-real-flow \
bun run smoke:real-flue
```

### Protocol smoke

`smoke:protocol` uses a real local NATS broker and an injected fake Flue client. It verifies the Synadia side: subject shape, discovery, ack, status, response, and terminator behavior.

Start NATS first if it is not already running:

```bash
nats-server -p 4222
bun run smoke:protocol
```

Expected message shape:

```json
[
  { "type": "status", "status": "ack" },
  { "type": "status", "status": "connected to Flue assistant/fake-instance via http-stream" },
  { "type": "response", "text": "fake Flue response to hello smoke for assistant/fake-instance/smoke-session" },
  { "type": "status", "status": "done" }
]
```

### Real Flue faux-echo smoke

`smoke:real-flue` exercises the real Flue runtime boundary without using a paid or nondeterministic LLM. The project-level testing docs describe the local probe app in detail, but the short version is:

1. Start NATS on `4222`.
2. Start a Flue dev server on `3583` with an `echo` agent backed by the Flue faux provider.
3. Run `bun run smoke:real-flue` with `SMOKE_EXPECTS=echo:hello-real-flow`.

Expected response:

```json
{ "type": "response", "text": "echo:hello-real-flow" }
```

The real-Flue smoke is not optional theater. The first real-runtime probe caught the WebSocket compatibility failure that the mock-only smoke could not see.

## Troubleshooting

### `doctor` reports HTTP 405

This is okay for the current Flue agent route GET probe. Treat it as reachable-method-unsupported unless the smoke test also fails.

### WebSocket fails with `Flue WebSocket connection failed`

Use `http-stream`. WebSocket remains diagnostic-only until the Flue local Node WebSocket upgrade failure is fixed upstream or proven deployment-specific.

### NATS connection fails with creds

Check whether you are using context mode or URL mode:

- context mode: `--nats-context` / `NATS_CONTEXT`; auth comes from the NATS context.
- URL mode: `--nats-url` plus optional `--nats-creds`; creds are wired through `credsAuthenticator`.

If both context and URL are configured, context mode wins.

### Environment overrides do not seem to work

Remember the precedence rule:

```text
CLI > environment > config file > defaults
```

For owner specifically:

```text
--owner > SYNADIA_FLUE_OWNER > [agent].owner > USER/default
```

### Attachments fail

Expected. The adapter currently rejects attachments explicitly because the Flue prompt bridge only maps text prompts.

## Limitations

- Text prompts only; attachments are not supported.
- One configured Flue target per sidecar process.
- WebSocket transport is diagnostic-only in the verified local Flue 0.9.1 setup.
- Real-Flue smoke uses a local faux echo agent; it proves runtime/SDK compatibility, not LLM quality.
- NATS contexts and URL+creds are supported; do not commit actual credentials or seed-shaped test material.

## Current verified state

Last verified before Phase 6 docs handoff:

```text
bun run typecheck
PASS

bun test
19 pass
0 fail
42 expect() calls

bun run smoke:protocol
PASS

bun run smoke:real-flue
PASS — echo:hello-real-flow

bun src/cli.ts doctor ...
PASS — Flue HTTP 405 treated as reachable-method-unsupported
```
