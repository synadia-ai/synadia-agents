# Codex NATS Channel

`@synadia-ai/codex-nats-channel` exposes Codex app-server-backed sessions through the Synadia Agent Protocol for NATS.

The adapter uses `@synadia-ai/agent-service` for service registration, prompt/status endpoints, heartbeats, keepalives, error mapping, and stream terminators. Managed mode starts an adapter-owned, isolated Codex app-server (`CODEX_HOME` under a generated state directory unless configured), creates an adapter-owned thread, and streams Codex text deltas as Synadia response chunks. Manager mode exposes eligible current sessions from an explicit endpoint registry only; it never scans GUI windows, terminal sessions, Desktop state, or private IPC. Fake mode remains available for deterministic protocol smoke tests.

## Package surface

- Package: `@synadia-ai/codex-nats-channel`
- Binary: `codex-agent`
- Type token: `codex`
- Prompt subject: `agents.prompt.codex.<owner>.<session>`
- Status subject: `agents.status.codex.<owner>.<session>`
- Heartbeat subject: `agents.hb.codex.<owner>.<session>`

Public metadata only includes safe labels such as `codex_mode=managed`, `permission_policy=reject`, and manager-derived public session labels. The prompt endpoint advertises `attachments_ok=false` until file/image ingestion is proven end-to-end. Metadata must not include raw app-server endpoints, local paths, thread identifiers, or tokens.

## Prerequisites

- Bun 1.3+ for local development and smoke tests.
- Node/npm for `npm pack --dry-run --json` package verification.
- `nats-server` on `PATH` for protocol and manager smoke tests.
- Codex CLI 0.133+ on `PATH` for managed and real app-server lifecycle checks.
- NATS credentials or context only when connecting to a secured NATS deployment; local smoke tests start disposable loopback NATS servers.

## Install

Install the published package when its protocol dependencies are available from npm:

```sh
npm install -g @synadia-ai/codex-nats-channel
```

For repository development, install from this package directory:

```sh
bun install
```

The package depends on published semver ranges for `@synadia-ai/agents` and `@synadia-ai/agent-service`; it does not require repo-local `file:` dependencies in its public manifest.

## Configuration

Precedence is:

```text
CLI flags > environment variables > TOML config file > defaults
```

Default config path:

```text
~/.config/synadia/codex-nats-channel.toml
```

Generate a template:

```sh
codex-agent configure --print-template
```

Start a managed local adapter:

```sh
codex-agent start --mode managed --owner local --session main
```

Run managed diagnostics:

```sh
codex-agent doctor --mode managed --owner local --session main
```

The doctor reports `codex --version`, NATS source, computed prompt subject, max-payload source, permission-callback mode, and redaction checks. Local-only values such as credentials, `CODEX_HOME`, endpoints, endpoint auth, and raw thread ids are redacted.

## Session manager mode

Manager mode is opt-in and registry-driven. It exposes only Codex app-server endpoints you explicitly configure with `--manager-endpoints`, `SYNADIA_CODEX_MANAGER_ENDPOINTS`, `[manager].endpoints`, or the single `--endpoint`/`SYNADIA_CODEX_ENDPOINT` value. There is no ambient desktop scan.

To use manager mode, first start or choose a Codex app-server endpoint. The Codex desktop app can start its own bundled `codex app-server`, but current evidence shows that child is wired to the GUI over private process-owned IPC rather than a documented third-party attach endpoint. Use one of these known endpoints:

- macOS/Linux local daemon: start Codex remote control with `codex remote-control start`, then use `unix://${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server-control.sock`.
- Cross-platform/local TCP: start an explicit app server with `codex app-server --listen ws://127.0.0.1:8765`, then start Codex sessions with `codex --remote ws://127.0.0.1:8765` and point the manager at `ws://127.0.0.1:8765`.

Use WebSocket endpoints on Windows; `unix://...` socket paths are Unix/macOS-only.

Start a manager over known endpoints and expose already-eligible current sessions:

```sh
codex-agent start \
  --mode manager \
  --owner local \
  --manager-enabled true \
  --auto-expose-current-sessions true \
  --manager-endpoints ws://127.0.0.1:8765
```

Start a manager that keeps current sessions private but exposes future eligible sessions on the same known endpoint set:

```sh
codex-agent start \
  --mode manager \
  --owner local \
  --manager-enabled true \
  --auto-expose-future-sessions true \
  --manager-endpoints ws://127.0.0.1:8765
```

`auto_expose_current_sessions` and `auto_expose_future_sessions` both default to `false`. Future-session watch mode listens for `thread/started` only as a wakeup, then reconciles `thread/loaded/list` plus `thread/list` before registering anything. Bounded polling catches missed events and restart gaps. While the manager is running, type `rescan` on stdin to trigger an immediate manual reconciliation.

For each endpoint, the manager reconciles `thread/loaded/list` and `thread/list`, hides no-turn ephemeral loaded sessions by default, and requires both `thread/read` and `thread/resume` before registering a promptable NATS identity. It derives a safe public session token for each private Codex thread; that token is the last segment in subjects such as `agents.prompt.codex.local.<session-token>`.

Every eligible session gets its own `AgentService` with separate prompt, status, and heartbeat subjects. Prompt routing is session-scoped: one public session cannot receive another session's text, events, or status payloads. If an exposed private session disappears from inventory, the manager marks it stale, stops its service after the configured grace interval, flushes NATS, and reuses the same public session token if the same private session reappears.

## NATS CLI examples

Discover registered Codex agents:

```sh
nats --no-context --server nats://127.0.0.1:4222 req '$SRV.INFO.agents' '' --replies=1 --timeout=5s
```

Prompt a managed session:

```sh
nats --no-context --server nats://127.0.0.1:4222 req agents.prompt.codex.local.demo 'say hello' --wait-for-empty --reply-timeout=30s --timeout=5m
```

Read status:

```sh
nats --no-context --server nats://127.0.0.1:4222 req agents.status.codex.local.demo '' --replies=1 --timeout=5s
```

## Validate

```sh
bun install
bun run typecheck
bun test
bun run smoke:protocol
bun run smoke:codex-appserver-lifecycle
bun run smoke:codex-fake-runtime
bun run smoke:codex-runtime
bun run smoke:codex-session-manager
bun run smoke:codex-future-watch
bun run smoke:codex-permission
```

The protocol smoke starts a disposable local `nats-server`, registers a fake Codex-backed service with `AgentService`, and proves `$SRV.INFO`, status, heartbeat, prompt `ack -> response -> terminator`, a successful JSON prompt envelope with no attachments, attachment `400`, and handler `500` behavior.

The app-server lifecycle smoke initializes a real `codex app-server --listen stdio://` inside an isolated temporary `CODEX_HOME`; it proves the real Codex process and JSON-RPC initialize/initialized boundary without sending a model prompt. The fake-runtime smoke uses a deterministic fake app-server process to prove prompt/stream framing, text-delta streaming, managed lifecycle, and no empty response chunks without spending model tokens or requiring credentials. `smoke:codex-runtime` intentionally runs both checks so the final ladder contains real app-server process evidence plus deterministic fake-runtime prompt/stream evidence. Permission smokes use the same deterministic fake app-server process to prove default-deny permission handling. The session-manager smoke uses an explicit Unix-socket endpoint fixture to prove two eligible current sessions become separate discoverable NATS identities, duplicate inventory rows do not double-register, ineligible ephemeral no-turn sessions stay private, prompts are isolated, and public protocol surfaces stay redacted. The future-watch smoke starts with no exposed sessions, registers one future eligible thread exactly once, keeps a future non-eligible thread private, proves manual `rescan` idempotence, and verifies endpoint loss marks stale then removes the service.

## Troubleshooting

- Protocol smoke cannot start NATS: install `nats-server`, or set `CODEX_SMOKE_USE_EXTERNAL_NATS=1` with `NATS_URL` pointing at a reachable server.
- `codex-agent doctor` shows `Codex unavailable`: check that `codex` is on `PATH`, or pass `--codex-bin /absolute/path/to/codex`.
- Managed prompts fail with `401 Unauthorized` from the model provider: managed mode uses an isolated generated `CODEX_HOME` unless configured. Either authenticate Codex in that isolated home, or pass `--code-home /path/to/an/already-authenticated/codex-home` for local testing.
- Manager mode exposes no sessions: confirm `--manager-enabled true`, at least one configured endpoint, and either `--auto-expose-current-sessions true` or `--auto-expose-future-sessions true`. Manager mode never scans GUI windows, terminal sessions, or desktop state.
- Prompts with attachments return `400`: this is expected for the current package; discovery advertises `attachments_ok=false` until Codex file/image ingestion is implemented end-to-end.

## Limitations

- Managed mode owns only the app-server process and thread it starts. It does not discover or control arbitrary Codex GUI/TUI sessions.
- Session-manager mode only watches explicitly configured app-server endpoints; `auto_expose_current_sessions` and `auto_expose_future_sessions` are both opt-in.
- Permission prompts default to deny/cancel for managed mode unless the adapter owns the active app-server callback path.
- Attachments are rejected until Codex file/image ingestion is mapped end-to-end.
- Public examples intentionally use safe session tokens and loopback NATS only; do not use raw Codex thread IDs, endpoints, socket paths, or credentials as subject tokens.
