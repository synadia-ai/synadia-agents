# @synadia/agents

**TypeScript SDK for the [NATS Agent Protocol](https://github.com/synadia-ai/nats-agent-sdk-docs).** Discover, prompt, and stream from AI agents over NATS.

- **Spec-first.** Built to protocol `0.2.0-draft` — see [`docs/protocol-mapping.md`](./docs/protocol-mapping.md) for every SDK call traced to its spec section.
- **Fail locally first.** Oversized payloads and unsupported attachments are rejected before they hit the wire, per spec §5.4.
- **Runtime-agnostic core.** Pure wire-shape / validation logic has no NATS or file-system dependencies; a browser/WS build is additive, not a rewrite.
- **Node.js ≥ 20 and Bun ≥ 1.2.**

> **Status:** pre-release. API may shift until `1.0`.

## Install

```sh
bun add @synadia/agents
# or: npm install @synadia/agents
# or: pnpm add @synadia/agents
```

## 30-second quickstart

Local dev — pick up whichever NATS context `nats context select` has active:

```ts
import { connect } from "@synadia/agents";

const client = await connect({ name: "my-app", context: "current" });

const agents = await client.discover({ timeoutMs: 2_000 });
const remote = client.bind(agents[0]!);

for await (const msg of await remote.prompt("describe this photo", {
  attachments: ["./vacation.jpg"],
})) {
  if (msg.type === "response") process.stdout.write(msg.text);
}

await client.close();
```

Or connect directly without a context:

```ts
const client = await connect({
  name: "my-app",
  servers: "nats://localhost:4222",
});
```

## The demo scenario

From the design brief:

> ```
> response, error := agent.prompt("describe this photo", WithAttachment("vacation.jpg"));
> ```
>
> If the harness metadata indicates no attachments, this fails. If the size of the prompt + my photo exceeds max_payload, it fails. All locally.

In TypeScript:

```ts
import { AttachmentsNotSupportedError, connect, PayloadTooLargeError } from "@synadia/agents";

try {
  const stream = await remote.prompt("describe this photo", {
    attachments: ["./vacation.jpg"],
  });
  for await (const msg of stream) {
    /* ... */
  }
} catch (e) {
  if (e instanceof AttachmentsNotSupportedError) {
    // agent's attachments_ok === false. No wire traffic.
  } else if (e instanceof PayloadTooLargeError) {
    console.log(`${e.actual} > ${e.limit} bytes`);
    // Again: no wire traffic.
  } else throw e;
}
```

Both error types extend `ValidationError` → `NatsAgentError`. See [Error handling](./docs/getting-started.md#error-handling) for the full taxonomy.

## What's in the box

| API                                                               | Purpose                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| `connect(options)` / `attach({nc})`                               | Open (or wrap) a NATS connection.                                |
| `client.discover({timeoutMs, filter})`                            | Enumerate protocol-compliant agents; auto subscribe-before-ping. |
| `client.bind(agent)`                                              | Get a `RemoteAgent` handle.                                      |
| `remote.prompt(text, {attachments, signal, inactivityTimeoutMs})` | Return a `PromptStream`.                                         |
| `client.liveness(id)` / `onHeartbeat(id, cb)` / `ping(id)`        | Heartbeat tracking + on-demand ping (§8).                        |
| `client.close()`                                                  | Tear down; aborts all in-flight streams.                         |

Subpath exports:

- **`@synadia/agents/errors`** — the error class hierarchy, for targeted `instanceof` branches.
- **`@synadia/agents/testing`** — a spec-compliant `ReferenceAgent` to run against in your own test suite.

## Documentation

- [Getting started](./docs/getting-started.md) — end-to-end walk-through with error handling, cancellation, liveness.
- [Protocol mapping](./docs/protocol-mapping.md) — every SDK call cross-referenced to the spec.
- [`examples/`](./examples) — five runnable scripts (discover, prompt-text, prompt-attachment, query-reply, liveness).

## Runtime support

- Node.js ≥ 20
- Bun ≥ 1.2
- Browser: architected for (transport-swappable) but not shipped in the 0.1.x line.

## Contributing

```sh
bun install          # or: npm install
bun run typecheck
bun run lint
bun run test:unit         # no NATS required
bun run test:integration  # spawns nats-server — install via brew / apt / https://github.com/nats-io/nats-server/releases
```

Integration tests skip cleanly with a friendly message if `nats-server` isn't on PATH.

## License

Apache-2.0
