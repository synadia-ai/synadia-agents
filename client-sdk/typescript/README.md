# @synadia-ai/agents

**TypeScript SDK for the [NATS Agent Protocol](https://github.com/synadia-ai/nats-agent-sdk-docs).** Discover, prompt, and stream from AI agents over NATS.

- **Catch errors before they hit the wire.** Oversized payloads and unsupported attachments are validated locally against the agent's advertised limits.
- **Stream responses with `for await`.** Prompts return typed chunks (`response`, `status`, `query`) you iterate asynchronously.
- **Runs on Node ≥ 20 and Bun ≥ 1.2.**

## Install

```sh
bun add @synadia-ai/agents
# or: npm install @synadia-ai/agents
# or: pnpm add @synadia-ai/agents
```

## 30-second quickstart

You bring a `NatsConnection`; the SDK uses it. Use `@nats-io/transport-node` for
TCP (`nats://`, `tls://`) or `wsconnect` from `@nats-io/nats-core` for WebSocket
(`ws://`, `wss://`) — the same connection can then be shared with JetStream, KV,
services, and anything else in the `@nats-io/*` ecosystem.

```ts
import { connect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const nc = await connect({ servers: "nats://localhost:4222" });
const agents = new Agents({ nc });

const found = await agents.discover(); // stall strategy — returns as soon as replies quiet down

for await (const msg of await found[0]!.prompt("describe this photo", {
  attachments: ["./vacation.jpg"],
})) {
  if (msg.type === "response") process.stdout.write(msg.text);
}

await agents.close();
await nc.close(); // caller owns the NATS connection
```

## Local validation in action

If the target agent doesn't accept attachments, or if the envelope exceeds its `max_payload`, the SDK fails your call _before_ publishing:

```ts
import { AttachmentsNotSupportedError, PayloadTooLargeError } from "@synadia-ai/agents";

try {
  const stream = await remote.prompt("describe this photo", {
    attachments: ["./vacation.jpg"],
  });
  for await (const msg of stream) {
    /* ... */
  }
} catch (e) {
  if (e instanceof AttachmentsNotSupportedError) {
    // agent's attachments_ok === false - no wire traffic.
  } else if (e instanceof PayloadTooLargeError) {
    console.log(`${e.actual} > ${e.limit} bytes`);
    // Again: no wire traffic.
  } else throw e;
}
```

Both error types extend `ValidationError` → `NatsAgentError`. See [Error handling](./docs/getting-started.md#error-handling) for the full taxonomy.

## What's in the box

| API                                                              | Purpose                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| `new Agents({ nc, ... })`                                        | Construct from a caller-owned `NatsConnection`.             |
| `agents.discover({filter?, timeoutMs?})`                         | Return a live `Agent[]`; auto subscribe-before-ping (§8.5). |
| `agent.prompt(text, {attachments, signal, inactivityTimeoutMs})` | Return a `PromptStream`.                                    |
| `agents.liveness(id)` / `onHeartbeat(id, cb)` / `ping(id)`       | Heartbeat tracking and on-demand ping.                      |
| `agents.close()`                                                 | Tear down SDK state; aborts all in-flight streams.          |

Subpath exports:

- **`@synadia-ai/agents/errors`** - the error class hierarchy, for targeted `instanceof` branches.
- **`@synadia-ai/agents/testing`** - a `ReferenceAgent` helper for your own test suite.

## Documentation

- [Getting started](./docs/getting-started.md) - end-to-end walkthrough with error handling, cancellation, and liveness.
- [Protocol mapping](./docs/protocol-mapping.md) - every SDK call cross-referenced to the spec.
- [`examples/`](./examples) - five runnable scripts (discover, prompt-text, prompt-attachment, query-reply, liveness).

Browser support is planned but not shipped yet - the core validation and parsing layers are already runtime-agnostic.

## Contributing

```sh
bun install          # or: npm install
bun run typecheck
bun run lint
bun run test:unit         # no NATS required
bun run test:integration  # spawns nats-server - install via brew / apt / https://github.com/nats-io/nats-server/releases
```

Integration tests skip cleanly with a friendly message if `nats-server` isn't on PATH.

## License

Apache-2.0
