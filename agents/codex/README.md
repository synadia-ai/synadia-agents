# Codex NATS Channel

`@synadia-ai/codex-nats-channel` exposes Codex app-server-backed sessions through the Synadia Agent Protocol for NATS.

The adapter uses `@synadia-ai/agent-service` for service registration, prompt/status endpoints, heartbeats, keepalives, error mapping, and stream terminators. Managed mode starts an adapter-owned, isolated Codex app-server (`CODEX_HOME` under a generated state directory unless configured), creates an adapter-owned thread, and streams Codex text deltas as Synadia response chunks. Fake mode remains available for deterministic protocol smoke tests.

## Package surface

- Package: `@synadia-ai/codex-nats-channel`
- Binary: `codex-agent`
- Type token: `codex`
- Prompt subject: `agents.prompt.codex.<owner>.<session>`
- Status subject: `agents.status.codex.<owner>.<session>`
- Heartbeat subject: `agents.hb.codex.<owner>.<session>`

Public metadata only includes safe labels such as `codex_mode=managed` and `permission_policy=reject`. The prompt endpoint advertises `attachments_ok=false` until file/image ingestion is proven end-to-end. Metadata must not include raw app-server endpoints, local paths, thread identifiers, or tokens.

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

Run diagnostics:

```sh
codex-agent doctor --mode managed --owner local --session main
```

The doctor reports `codex --version`, NATS source, computed prompt subject, max-payload source, permission-callback mode, and redaction checks. Local-only values such as credentials, `CODEX_HOME`, endpoints, and raw thread ids are redacted.

## Validate

```sh
bun install
bun run typecheck
bun test
bun run smoke:protocol
bun run smoke:codex-appserver-lifecycle
bun run smoke:codex-runtime
bun run smoke:codex-permission
```

The protocol smoke starts a disposable local `nats-server`, registers a fake Codex-backed service with `AgentService`, and proves `$SRV.INFO`, status, heartbeat, prompt `ack -> response -> terminator`, attachment `400`, and handler `500` behavior.

The app-server lifecycle smoke initializes a real `codex app-server --listen stdio://` inside an isolated temporary `CODEX_HOME`. Runtime and permission smokes use a deterministic fake app-server process to prove JSON-RPC framing, text-delta streaming, managed lifecycle, and default-deny permission handling without spending model tokens or requiring credentials.

## Limitations

- Managed mode owns only the app-server process and thread it starts. It does not discover or control arbitrary Codex GUI/TUI sessions.
- Attached endpoint/session-manager modes are not enabled yet.
- Permission prompts default to deny/cancel unless the adapter owns the active app-server callback path.
- Attachments are rejected until Codex file/image ingestion is mapped end-to-end.
- Public examples intentionally use safe aliases and loopback NATS only; do not use raw Codex thread IDs, endpoints, socket paths, or credentials as subject tokens.
