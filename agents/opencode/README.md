# OpenCode NATS channel

`@synadia-ai/opencode-nats-channel` is a TypeScript/Bun adapter that exposes OpenCode server sessions through the Synadia Agent Protocol for NATS.

Status: bridge implementation. The package starts or attaches to an OpenCode server, registers an `AgentService` host on NATS, routes prompt envelopes into OpenCode sessions, streams OpenCode SSE text events as protocol response chunks, bridges permission requests through protocol `query` chunks when configured, and rejects attachments for v1 (`attachments_ok=false`).

## Package

- Package: `@synadia-ai/opencode-nats-channel`
- Binary: `opencode-agent`
- Type token: `opencode`
- Prompt subject: `agents.prompt.opencode.<owner>.<session>`
- Attachments: `attachments_ok=false` for v1
- Host SDK: `@synadia-ai/agent-service` / `AgentService`

## Modes

Managed mode starts and owns `opencode serve` through `@opencode-ai/sdk`:

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

Permission policies:

- `query` (default): OpenCode permission events become protocol `query` chunks; replies map to `once`, `always`, or `reject`.
- `reject`: permission events are rejected immediately.
- `local`: permission handling is delegated to the local OpenCode UI/policy surface; the adapter reports that delegation as a status chunk.

## Development

```sh
bun install
bun run typecheck
bun test
```

Smoke scripts exercise three layers:

```sh
# Real disposable nats-server + injected fake OpenCode client.
bun run smoke:protocol

# Real OpenCode SDK server lifecycle, attached doctor probe, and no-second-server attached mode check.
bun run smoke:opencode-lifecycle

# Credentialed real OpenCode runtime smoke. Loads only the scoped env file below unless overridden.
bun run smoke:opencode-runtime
```

The runtime smoke expects a local env file outside the repo:

```text
$HOME/.hermes/projects/synadia-agents-opencode/secrets/opencode-openrouter.env
```

Allowed keys in that file are deliberately narrow:

```text
OPENROUTER_API_KEY=...
OPENCODE_TEST_MODEL=openrouter/anthropic/claude-3.5-haiku
```

Do not source a broad Hermes profile `.env` for this smoke. The script refuses unexpected keys and never prints secret values.

## Current limitations

- Attachments are rejected until OpenCode file ingestion is mapped end-to-end.
- Attached mode targets the OpenCode server/session surface; it should not be described as a TUI-specific API unless OpenCode exposes one.
- Permission-query bridging depends on OpenCode emitting permission events with session and permission ids.
