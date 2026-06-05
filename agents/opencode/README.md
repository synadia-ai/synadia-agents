# OpenCode NATS channel

`@synadia-ai/opencode-nats-channel` is the planned TypeScript/Bun adapter that exposes OpenCode sessions through the Synadia Agent Protocol for NATS.

Status: scaffold. The package has config parsing, CLI/doctor shell, protocol metadata construction, and unit-test seams. It intentionally refuses to serve prompts until the real OpenCode SDK lifecycle, SSE event stream, and permission bridge are wired. No fake bridge pretends to be conformant. Tiny mercy in a repo full of sharp objects.

## Package

- Package: `@synadia-ai/opencode-nats-channel`
- Binary: `opencode-agent`
- Type token: `opencode`
- Prompt subject: `agents.prompt.opencode.<owner>.<session>`
- Attachments: `attachments_ok=false` for v1
- Host SDK: `@synadia-ai/agent-service` / `AgentService`

## Modes

Managed mode starts and owns `opencode serve`:

```sh
opencode-agent start \
  --owner rene \
  --session labrowser \
  --directory /path/to/repo \
  --nats-url nats://127.0.0.1:4222
```

Attached mode connects to an existing OpenCode server/session surface and must not spawn a second server:

```sh
opencode serve --hostname 127.0.0.1 --port 4096
opencode-agent start \
  --base-url http://127.0.0.1:4096 \
  --owner rene \
  --session labrowser \
  --directory /path/to/repo
```

## Configuration

Default config path:

```text
~/.config/synadia/opencode-nats-channel.toml
```

Precedence is locked by tests:

```text
CLI flags > environment variables > config file > defaults
```

Print a template:

```sh
bun src/cli.ts configure --print-template
```

Run doctor:

```sh
bun src/cli.ts doctor --base-url http://127.0.0.1:4096 --owner rene --session labrowser
```

## Development

```sh
bun install
bun run typecheck
bun test
```

Smoke scripts exist now but intentionally fail until Phase 5 supplies the real fake-client + NATS protocol smoke, OpenCode lifecycle smoke, and deterministic runtime smoke:

```sh
bun run smoke:protocol
bun run smoke:opencode-lifecycle
bun run smoke:opencode-runtime
```

## Implementation work still required

- Verify exact `@opencode-ai/sdk` method names and generated types.
- Implement managed `opencode serve` lifecycle and attached `--base-url` mode.
- Subscribe to `/event` before prompt submission and map deltas without duplicate full-part text.
- Bridge OpenCode permission events to protocol `query` chunks for `permission_policy=query`.
- Keep `attachments_ok=false` and reject non-empty attachment envelopes with `ProtocolError` until file ingestion is proven end-to-end.
