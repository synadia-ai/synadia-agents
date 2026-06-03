# Flue NATS channel

TypeScript sidecar that exposes a running Flue attached agent as a Synadia Agent Protocol for NATS agent.

This package is intentionally Bun-first for local commands. Flue's `--target node` flag is a Flue server compatibility target for the attached HTTP/WebSocket surface, not a preference for npm/Node tooling.

## Install

```bash
cd agents/flue
bun install
```

## Configure

Print a TOML template:

```bash
bun src/cli.ts configure --print-template
```

Core precedence is CLI flags, then environment variables, then config file, then defaults.

Environment variables:

- `NATS_URL`
- `NATS_CONTEXT`
- `SYNADIA_FLUE_OWNER`
- `SYNADIA_FLUE_NAME`
- `SYNADIA_FLUE_CONFIG`
- `FLUE_BASE_URL`
- `FLUE_AGENT`
- `FLUE_INSTANCE`
- `FLUE_SESSION`
- `FLUE_TRANSPORT`

## Run

```bash
bun src/cli.ts start \
  --nats-url nats://127.0.0.1:4222 \
  --owner rene \
  --name support \
  --subject-token flue \
  --flue-base-url http://127.0.0.1:3583 \
  --flue-agent assistant \
  --flue-instance customer-123 \
  --flue-session ticket-123
```

The sidecar registers a Synadia `AgentService` with:

- `agent: "flue"`
- `subjectToken: "flue"`
- `attachmentsOk: false`
- metadata describing the configured Flue target

The v1 transport opens a Flue SDK attached-agent connection per prompt, emits lifecycle status chunks, sends one final response chunk, and lets `AgentService` handle ack, keepalive, error mapping, heartbeat/status endpoints, and stream termination. No hand-rolled protocol service plumbing lives here.

## Doctor

```bash
bun src/cli.ts doctor --flue-base-url http://127.0.0.1:3583
```

## Verification

```bash
bun run typecheck
bun test
```

If `nats-server` is available locally, run a protocol smoke test with a fake Flue client and real NATS broker:

```bash
nats-server -p 4222
bun run smoke:protocol
```

The smoke test verifies the protocol stream includes the leading `ack`, a Flue bridge status chunk, a response chunk, and the final SDK `done` terminator status.
