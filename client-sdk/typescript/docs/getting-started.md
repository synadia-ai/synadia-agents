# Getting started

`@synadia/agents` is the TypeScript client SDK for the [NATS Agent Protocol](https://github.com/synadia-ai/nats-agent-sdk-docs). This guide walks through the complete flow: connecting, discovering agents, prompting one with attachments, and handling the three protocol-defined failure modes locally.

## Prerequisites

- Node.js ≥ 20 **or** Bun ≥ 1.2
- A running `nats-server` reachable from the client.
- At least one protocol-compliant agent registered on the NATS system. The `@synadia/agents/testing` subpath ships a spec-compliant reference agent you can run locally:

  ```ts
  import { connect as natsConnect } from "@nats-io/transport-node";
  import { ReferenceAgent } from "@synadia/agents/testing";

  const nc = await natsConnect({ servers: "nats://localhost:4222" });
  const agent = new ReferenceAgent({
    nc,
    agent: "demo-agent",
    owner: process.env.USER ?? "anon",
    name: "example",
    heartbeatIntervalS: 5,
  });
  await agent.start();
  ```

## Install

```sh
bun add @synadia/agents     # or: npm install @synadia/agents
```

## Connect + discover + prompt

```ts
import { connect } from "@synadia/agents";

const client = await connect({
  name: "my-app",
  servers: "nats://localhost:4222",
});

const agents = await client.discover({ timeoutMs: 2000 });
const remote = client.bind(agents[0]!);

for await (const msg of await remote.prompt("hello")) {
  if (msg.type === "response") process.stdout.write(msg.text);
  if (msg.type === "status" && msg.status === "done") process.stdout.write("\n");
}

await client.close();
```

That's the quickstart. Everything else below is depth on specific features.

## Attachments

The boss's scenario - send a photo and ask about it:

```ts
import { AttachmentsNotSupportedError, connect, PayloadTooLargeError } from "@synadia/agents";

try {
  const stream = await remote.prompt("describe this photo", {
    attachments: ["./vacation.jpg"], // also: URL or { filename, content: Uint8Array }
  });
  for await (const msg of stream) {
    /* ... */
  }
} catch (e) {
  if (e instanceof AttachmentsNotSupportedError) {
    // Agent's endpoint metadata said `attachments_ok: false`. NO wire traffic happened.
  }
  if (e instanceof PayloadTooLargeError) {
    console.log(`payload ${e.actual} > agent's ${e.limit} byte limit`);
    // Again: NO wire traffic. The check is done on the serialized envelope before publish.
  }
}
```

Three attachment input forms, picked to match common needs:

| Input                                       | Resolved as                                |
| ------------------------------------------- | ------------------------------------------ |
| `string` (path)                             | `fs.readFile(path)`; filename = `basename` |
| `URL` with `file:` protocol                 | same as above                              |
| `{ filename: string, content: Uint8Array }` | used directly                              |

All paths round-trip through base64 per RFC 4648 §4 (standard alphabet, padded).

## Error handling

Errors split by where they fire:

| Class                            | When                                                          | Where it fires    |
| -------------------------------- | ------------------------------------------------------------- | ----------------- |
| `PromptEmptyError`               | `text === ""`                                                 | sync throw        |
| `AttachmentsNotSupportedError`   | attachments supplied but `attachments_ok === false`           | sync throw        |
| `PayloadTooLargeError`           | encoded envelope exceeds `max_payload` (text-only)            | sync throw        |
| `PayloadTooLargeError`           | same, but with attachments (size known only after file I/O)   | promise rejection |
| `ServiceError`                   | agent responded with a `Nats-Service-Error-Code` header       | from the iterator |
| `StreamStalledError`             | no chunk received within `inactivityTimeoutMs` (default 60 s) | from the iterator |
| `AbortError` (DOMException name) | `opts.signal` or `client.close()` aborted the stream          | from the iterator |

All extend `NatsAgentError` for a single catch-all. Use `instanceof` for targeted handling; the `ServiceError.code` field carries the numeric status (400/401/403/404/409/429/500 per spec §9.2).

## Streaming events

`remote.prompt()` resolves to a `PromptStream` - an `AsyncIterable<StreamMessage>`:

```ts
for await (const msg of stream) {
  switch (msg.type) {
    case "response":
      process.stdout.write(msg.text);
      if (msg.attachments) {
        /* agent returned artifacts */
      }
      break;
    case "status":
      if (msg.status === "ack") {
        /* keep-alive */
      }
      if (msg.status === "done") {
        /* terminator */
      }
      break;
    case "query":
      const answer = await askUser(msg.prompt);
      await msg.reply(answer); // plain text OR { prompt, attachments? }
      break;
  }
}
```

Key guarantees:

- **Terminator → `status: done`.** The SDK always emits a synthetic `{ type: "status", status: "done" }` as the final event before the iterator returns cleanly. Wire-level terminator is "empty body, no headers" per §6.5.
- **Unknown chunk types are silently dropped** per §6.6 - forward-compat: future `type` values don't break the iterator.
- **Per-stream inactivity timeout.** Default 60 s, resettable via `opts.inactivityTimeoutMs`. Resets on every delivered chunk, including `status: ack` keep-alives.
- **Cancellation.** Three ways:
  - `break` out of `for await` (auto-cleanup via `Symbol.asyncIterator.return()`).
  - `stream.cancel()` explicit method.
  - `opts.signal` - any `AbortSignal`. Iterator throws the signal's `reason`.

## Liveness

Heartbeats are published by every agent (spec §8). The SDK tracks them passively:

```ts
client.liveness(instanceId);
// → { lastSeen: Date, intervalS: number, isOnline: boolean } | null

client.onHeartbeat(instanceId, (hb) => {
  console.log(`${hb.agent} beats every ${hb.intervalS}s`);
});

await client.ping(instanceId, { timeoutMs: 2000 });
// On-demand reachability via $SRV.PING.agents.{id}
```

"Online" means a heartbeat arrived within `3 × interval_s` (spec §8.2). Multiple instances of the same logical agent are tracked separately, keyed on `instance_id` from the heartbeat payload.

## Subscribe-before-discover

The SDK enforces spec §8.5 automatically: the first call to `discover()` implicitly subscribes the heartbeat wildcard before publishing `$SRV.PING`, so you never miss a beat on a just-started agent. If you need to start tracking before your first discover, call `client.startTracking()` explicitly.

## Using NATS contexts

If you already manage connection settings with the `nats` CLI (`nats context add`, `nats context select`), the SDK can pick them up directly - no need to re-specify URL, credentials, or auth options:

```ts
import { connect } from "@synadia/agents";

// Whatever `nats context select` last chose (also honors $NATS_CONTEXT):
const client = await connect({ name: "my-app", context: "current" });

// Load a specific context by name:
const client = await connect({ name: "my-app", context: "prod" });

// Override individual fields while keeping the context's auth:
const client = await connect({
  name: "my-app",
  context: "prod",
  servers: "nats://local-proxy:4222", // replaces the context's URL
});
```

**Precedence** when both `context` and explicit options are passed: explicit `servers` wins over the context's `url`; fields in `opts.nats` shallow-merge over context-derived fields (per-field override).

**Selector shapes:**

| Form                 | Meaning                                                   |
| -------------------- | --------------------------------------------------------- |
| `context: "prod"`    | Load `<baseDir>/context/prod.json`.                       |
| `context: "current"` | Use `$NATS_CONTEXT` if set, else `<baseDir>/context.txt`. |
| `context: true`      | Alias for `"current"`.                                    |

**Base directory resolution** (first match wins): `$NATS_CONFIG_HOME` → `$XDG_CONFIG_HOME/nats` → `$HOME/.config/nats` → `%APPDATA%/nats` on Windows (best-effort).

**Supported context fields** in v0.1: `url`, `creds`, `token`, `user`/`password`, `user_jwt`, `inbox_prefix`, `description`. `nkey`, TLS `cert`/`key`/`ca`, and `nsc` integration are tracked in [`TODO.md`](../TODO.md).

**Power-user form** - load without connecting:

```ts
import { loadNatsContext } from "@synadia/agents";

const ctx = await loadNatsContext("current");
console.log(ctx.description, ctx.servers);
```

**Error classes** (all extend `NatsContextError`):

- `NatsContextNotFoundError` - named context file doesn't exist.
- `NatsContextNotSelectedError` - `current`/`true` asked for but nothing is selected.
- `NatsContextInvalidError` - file is malformed, missing `url`, or a referenced creds file is absent.

## Bun usage

`@synadia/agents` runs unchanged on Bun 1.2+:

```sh
bun add @synadia/agents
bun run examples/01-discover.ts
```

The underlying transport (`@nats-io/transport-node`) is explicitly supported on both Node and Bun by the NATS maintainers.

## Next steps

- [`docs/protocol-mapping.md`](./protocol-mapping.md) - every SDK call mapped to its spec section.
- [`examples/`](../examples) - 5 runnable scripts covering each major feature.
- [NATS Agent Protocol spec](https://github.com/synadia-ai/nats-agent-sdk-docs) - the authoritative wire contract.
