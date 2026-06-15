# Codex NATS Channel

`@synadia-ai/codex-nats-channel` exposes Codex app-server-backed sessions through the Synadia Agent Protocol for NATS.

The adapter uses `@synadia-ai/agent-service` for service registration, prompt/status endpoints, heartbeats, keepalives, error mapping, and stream terminators. Managed mode starts an adapter-owned, isolated Codex app-server (`CODEX_HOME` under a generated state directory unless configured), creates an adapter-owned thread, and streams Codex text deltas as Synadia response chunks. Attached mode exposes one explicitly selected app-server-backed thread by configured endpoint, private thread id, and safe public alias. Manager mode exposes eligible current sessions from an explicit endpoint registry only; it never scans GUI windows, terminal sessions, Desktop state, or private IPC. Fake mode remains available for deterministic protocol smoke tests.

## Package surface

- Package: `@synadia-ai/codex-nats-channel`
- Binary: `codex-agent`
- Type token: `codex`
- Prompt subject: `agents.prompt.codex.<owner>.<session>`
- Status subject: `agents.status.codex.<owner>.<session>`
- Heartbeat subject: `agents.hb.codex.<owner>.<session>`

Public metadata only includes safe labels such as `codex_mode=managed`, `codex_mode=attached`, `permission_policy=reject`, and `permission_mode=external-owner`. The prompt endpoint advertises `attachments_ok=false` until file/image ingestion is proven end-to-end. Metadata must not include raw app-server endpoints, local paths, thread identifiers, or tokens.

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

## Attached endpoint mode

Attached mode is explicit by design. It does not scan GUI windows, terminal sessions, or private desktop IPC. You must provide:

- `--endpoint`: `unix:///absolute/socket` or `ws(s)://host:port/path`;
- `--thread-id`: the private Codex app-server thread id to resume;
- `--alias` / `--public-alias`: the safe public NATS session token to register.

Non-loopback WebSocket endpoints require `--endpoint-auth` or `SYNADIA_CODEX_ENDPOINT_AUTH`. Loopback Unix sockets and loopback WebSockets are accepted without endpoint auth.

Preflight an attached thread before registration:

```sh
codex-agent attach doctor \
  --owner local \
  --endpoint unix:///path/to/codex.sock \
  --thread-id '<private-thread-id>' \
  --alias demo
```

Start the attached adapter after preflight passes:

```sh
codex-agent attach start \
  --owner local \
  --nats-url nats://127.0.0.1:4222 \
  --endpoint unix:///path/to/codex.sock \
  --thread-id '<private-thread-id>' \
  --alias demo
```

Attached preflight checks `initialize`, `thread/loaded/list`, `thread/list`, selected `thread/read`, selected `thread/resume`, a stream round trip, and permission ownership labeling. The public session is always the safe alias; the raw thread id and endpoint are never used in NATS subjects or public metadata.

User-client-created attached threads default to `permission_mode=external-owner`. The adapter does not emit Synadia protocol `query` permission prompts for attached threads unless a future implementation proves the adapter owns the active Codex callback path.

## Session manager mode

Manager mode is opt-in and registry-driven. It exposes only Codex app-server endpoints you explicitly configure with `--manager-endpoints`, `SYNADIA_CODEX_MANAGER_ENDPOINTS`, `[manager].endpoints`, or the single `--endpoint`/`SYNADIA_CODEX_ENDPOINT` value. There is no ambient desktop scan.

Start a manager over known endpoints and expose already-eligible current sessions:

```sh
codex-agent start \
  --mode manager \
  --owner local \
  --manager-enabled true \
  --auto-expose-current-sessions true \
  --manager-endpoints unix:///path/to/codex.sock
```

Start a manager that keeps current sessions private but exposes future eligible sessions on the same known endpoint set:

```sh
codex-agent start \
  --mode manager \
  --owner local \
  --manager-enabled true \
  --auto-expose-future-sessions true \
  --manager-endpoints unix:///path/to/codex.sock
```

`auto_expose_current_sessions` and `auto_expose_future_sessions` both default to `false`. Future-session watch mode listens for `thread/started` only as a wakeup, then reconciles `thread/loaded/list` plus `thread/list` before registering anything. Bounded polling catches missed events and restart gaps. While the manager is running, type `rescan` on stdin to trigger an immediate manual reconciliation.

For each endpoint, the manager reconciles `thread/loaded/list` and `thread/list`, normalizes private rows as the endpoint fingerprint plus private thread id, hides no-turn ephemeral loaded sessions by default, and requires both `thread/read` and `thread/resume` before registering a promptable NATS identity. Public aliases are safe derived tokens unless an explicit alias map is supplied by code; explicit alias collisions fail startup instead of silently routing the wrong session.

Every eligible session gets its own `AgentService` with separate prompt, status, and heartbeat subjects. Prompt routing is session-scoped: one public session cannot receive another session's text, events, or status payloads. If an exposed private session disappears from inventory, the manager marks it stale, stops its service after the configured grace interval, flushes NATS, and reuses the same public alias if the same private key reappears.

## Optional plugin-assisted registration

Plugin-assisted registration is an optional acceleration path for managers over already configured app-server endpoints. A Codex plugin or hook can notify the local registrar when useful lifecycle events occur (`SessionStart`, `SessionStop`, and similar wakeups):

```sh
codex-agent start \
  --mode manager \
  --manager-enabled true \
  --auto-expose-future-sessions true \
  --manager-endpoints unix:///path/to/codex.sock \
  --plugin-enabled true \
  --plugin-registrar-token '<shared-local-token>'
```

A hook can emit a local notification with:

```sh
bun run plugin:notify -- \
  --registrar-url http://127.0.0.1:8717 \
  --token '<shared-local-token>' \
  --event SessionStart \
  --endpoint unix:///path/to/codex.sock \
  --thread-id '<private-thread-id>'
```

The registrar only records private metadata and wakes reconciliation. Plugin-origin events remain `metadata-only` until the manager proves app-server control with the normal `thread/read` plus `thread/resume` gate. The plugin does not expose GUI/TUI sessions by itself, does not bypass configured endpoint policy, and does not make a session promptable on NATS without app-server proof. `codex-agent doctor` reports plugin installed/configured status, hook trust, registrar reachability, the last redacted event, and whether the last event is still metadata-only or became promptable after reconciliation.

## NATS CLI examples

Discover registered Codex agents:

```sh
nats req '$SRV.INFO.agents' '' --wait-for-empty --reply-timeout=30s --timeout=5m
```

Prompt a managed or attached session:

```sh
nats req agents.prompt.codex.local.demo 'say hello' --wait-for-empty --reply-timeout=30s --timeout=5m
```

Read status:

```sh
nats req agents.status.codex.local.demo '' --wait-for-empty --reply-timeout=30s --timeout=5m
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
bun run smoke:attached-endpoint
bun run smoke:codex-session-manager
bun run smoke:codex-future-watch
bun run smoke:codex-permission
```

The protocol smoke starts a disposable local `nats-server`, registers a fake Codex-backed service with `AgentService`, and proves `$SRV.INFO`, status, heartbeat, prompt `ack -> response -> terminator`, a successful JSON prompt envelope with no attachments, attachment `400`, and handler `500` behavior.

The app-server lifecycle smoke initializes a real `codex app-server --listen stdio://` inside an isolated temporary `CODEX_HOME`; it proves the real Codex process and JSON-RPC initialize/initialized boundary without sending a model prompt. The fake-runtime smoke uses a deterministic fake app-server process to prove prompt/stream framing, text-delta streaming, managed lifecycle, and no empty response chunks without spending model tokens or requiring credentials. `smoke:codex-runtime` intentionally runs both checks so the final ladder contains real app-server process evidence plus deterministic fake-runtime prompt/stream evidence. Permission smokes use the same deterministic fake app-server process to prove default-deny permission handling. The attached endpoint smoke uses an explicit Unix-socket app-server fixture to prove endpoint/thread/alias preflight and NATS prompt routing. The session-manager smoke uses an explicit Unix-socket endpoint fixture to prove two eligible current sessions become separate discoverable NATS identities, duplicate inventory rows do not double-register, ineligible ephemeral no-turn sessions stay private, prompts are isolated, and public protocol surfaces stay redacted. The future-watch smoke starts with no exposed sessions, registers one future eligible thread exactly once, keeps a future non-eligible thread private, proves manual `rescan` idempotence, and verifies endpoint loss marks stale then removes the service.

## Troubleshooting

- `codex-agent attach doctor` or `codex-agent attach start` exits with `attached mode requires ...`: provide `--endpoint`, `--thread-id`, and a safe `--alias`; the alias becomes the public NATS session token.
- Non-loopback WebSocket endpoints fail preflight without auth: add `--endpoint-auth` or `SYNADIA_CODEX_ENDPOINT_AUTH`, or use a loopback Unix socket while developing locally.
- Protocol smoke cannot start NATS: install `nats-server`, or set `CODEX_SMOKE_USE_EXTERNAL_NATS=1` with `NATS_URL` pointing at a reachable server.
- `codex-agent doctor` shows `Codex unavailable`: check that `codex` is on `PATH`, or pass `--codex-bin /absolute/path/to/codex`.
- Manager mode exposes no sessions: confirm `--manager-enabled true`, at least one configured endpoint, and either `--auto-expose-current-sessions true` or `--auto-expose-future-sessions true`. Manager mode never scans GUI windows, terminal sessions, or desktop state.
- Prompts with attachments return `400`: this is expected for the current package; discovery advertises `attachments_ok=false` until Codex file/image ingestion is implemented end-to-end.

## Limitations

- Managed mode owns only the app-server process and thread it starts. It does not discover or control arbitrary Codex GUI/TUI sessions.
- Attached mode exposes only the explicitly configured app-server endpoint and selected thread. It does not claim arbitrary GUI/TUI auto-discovery.
- Session-manager mode only watches explicitly configured app-server endpoints; `auto_expose_current_sessions` and `auto_expose_future_sessions` are both opt-in.
- Permission prompts default to deny/cancel for managed mode unless the adapter owns the active app-server callback path; attached mode defaults to `external-owner`.
- Attachments are rejected until Codex file/image ingestion is mapped end-to-end.
- Public examples intentionally use safe aliases and loopback NATS only; do not use raw Codex thread IDs, endpoints, socket paths, or credentials as subject tokens.
