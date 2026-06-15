# Codex NATS Channel

`@synadia-ai/codex-nats-channel` exposes Codex app-server-backed sessions through the Synadia Agent Protocol for NATS.

Initial scaffold is a protocol scaffold: it registers a Codex-shaped agent using `@synadia-ai/agent-service`, rejects attachments honestly with `attachments_ok=false`, and uses an injected fake Codex bridge client for deterministic protocol smoke tests. Managed and attached real Codex app-server runtimes land in later work.

## Package surface

- Package: `@synadia-ai/codex-nats-channel`
- Binary: `codex-agent`
- Type token: `codex`
- Prompt subject: `agents.prompt.codex.<owner>.<session>`
- Status subject: `agents.status.codex.<owner>.<session>`
- Heartbeat subject: `agents.hb.codex.<owner>.<session>`

Public metadata only includes safe labels such as `codex_mode=fake` and `permission_policy=reject`. It must not include raw app-server endpoints, local paths, thread identifiers, or tokens.

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

## Validate

```sh
bun install
bun run typecheck
bun test
bun run smoke:protocol
```

The protocol smoke starts a disposable local `nats-server`, registers a fake Codex-backed service with `AgentService`, and proves `$SRV.INFO`, status, heartbeat, prompt `ack -> response -> terminator`, attachment `400`, and handler `500` behavior.

## Limitations

- Phase 1 does not start or attach to a real Codex app server.
- Attachments are rejected until Codex file/image ingestion is mapped end-to-end.
- Public examples intentionally use safe aliases and loopback NATS only; do not use raw Codex thread IDs, endpoints, socket paths, or credentials as subject tokens.
