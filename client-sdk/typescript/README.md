# @synadia-ai/agents

**Caller-side TypeScript SDK for the [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs).** Discover, prompt, and stream from AI agents over NATS.

- **Catch errors before they hit the wire.** Oversized payloads and unsupported attachments are validated locally against the agent's advertised limits — and against the caller's own `nc.info.max_payload`, so the smaller of the two binds (a caller behind a smaller-cap broker fails fast instead of waiting for `MAX_PAYLOAD_VIOLATION`).
- **Stream responses with `for await`.** Prompts return typed chunks (`response`, `status`, `query`) you iterate asynchronously.
- **Runs on Node ≥ 20 and Bun ≥ 1.2.**

> **Hosting an agent?** Install the sister package
> [`@synadia-ai/agent-service`](../../agent-sdk/typescript/) for `AgentService`,
> `ReferenceAgent`, and the host-side wire helpers. The two packages release
> in lockstep.

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

| API                                                                                                                | Purpose                                                                                  |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `new Agents({ nc, ... })`                                                                                          | Construct from a caller-owned `NatsConnection`.                                          |
| `agents.discover({filter?, timeoutMs?})`                                                                           | Return a live `Agent[]`; auto subscribe-before-ping (§8.5).                              |
| `agent.prompt(text, {attachments, signal, inactivityTimeoutMs})`                                                   | Return a `PromptStream`.                                                                 |
| `agents.liveness(id)` / `onHeartbeat(id, cb)` / `ping(id)`                                                         | Heartbeat tracking and on-demand ping.                                                   |
| `agent.status({ subject?, sub?, timeoutMs? })`                                                                     | §8.7 status probe; returns the agent's heartbeat payload.                                |
| `agents.close()`                                                                                                   | Tear down SDK state; aborts all in-flight streams.                                       |
| `loadContextOptions(name)` / `parseNatsUrl(url)`                                                                   | Bridge `nats` CLI context files / URLs into `NodeConnectionOptions` for `connect()`.     |
| `withAgentReconnectDefaults(opts?)`                                                                                | Opt-in resilient reconnect defaults for agent runtimes — see below. Pure transform.      |
| `new Agents({ nc, identity: { signer, name } })`                                                                   | Sender identity: sign every `prompt` / `status` with the connection's NKEY — see below.  |
| `agents.selfId()` / `refreshSelfId()`                                                                              | Resolve the connection's own agent ID (`{account}.{user}`).                              |
| `agents.signSender` / `publishSigned` / `requestSigned`                                                            | Signed publishes for any subject, JetStream included.                                    |
| `agents.resolveSender(id)`                                                                                         | Reverse lookup: agent ID → the agent that registered it (`id_sig` verified, TTL-cached). |
| `signerFromSeed` / `signerFromCreds` / `signerFromCredsFile` / `signerFromContext`                                 | Build a `SenderSigner`; custom HSM / KMS signers implement the interface.                |
| `verifySender(msg, mode)`, `verifySenderHeader`, `parseSenderHeader`, `formatSender`, `newAgentId`, `parseAgentId` | The shared identity codec (also used by the host package).                               |

### Resilient reconnect defaults

`@nats-io/transport-node` gives up after ~10 reconnect attempts (~20 seconds) by default, which is too aggressive for an agent process that's supposed to outlive laptop sleeps and intermittent broker reachability. Wrap your options with `withAgentReconnectDefaults` to keep retrying indefinitely (and to retry from the very first connect attempt, instead of throwing if the broker is down at startup):

```ts
import { connect } from "@nats-io/transport-node";
import { withAgentReconnectDefaults } from "@synadia-ai/agents";

const nc = await connect(withAgentReconnectDefaults({ servers: "nats://localhost:4222" }));
```

The helper merges defaults into caller-provided options, preserving any field the caller explicitly set (including `0` and `false`). The defaults — `maxReconnectAttempts: -1`, `reconnectTimeWait: 2000`, `reconnectJitter: 200`, `waitOnFirstConnect: true` — are also exported as `AGENT_RECONNECT_DEFAULTS` for introspection or selective override.

When you adopt these defaults, also handle the terminal `close` status event in your `for await (const s of nc.status())` loop — it still fires on repeated identical auth errors and on explicit `nc.close()` / `nc.drain()`, and a stuck "reconnecting…" UI on a truly dead connection is worse than an honest "disconnected" one.

### Sender identity

The optional sender-identity extension lets a receiving agent know _who_ prompted it, verified per message: the caller attaches an `Agent-Sender` header that names its agent ID — the `(account, user)` NKEY pair authenticated on that connection — and, with a signer, an ed25519 signature bound to the subject, payload, timestamp, and nonce. Nothing in it changes protocol `0.3`: support is advertised by `min_sender_trust` on the prompt endpoint (`agent.supportsSenderIdentity`). Identity is off when the `identity` option is omitted.

```ts
import { Agents, signerFromCredsFile } from "@synadia-ai/agents";

const agents = new Agents({
  nc,
  identity: { signer: await signerFromCredsFile("~/.config/nats/user.creds"), name: "claude-code" },
});
console.log(await agents.selfId()); // "AABY….UAWW…" — 113 chars on NGS, "$G.U…" / "ACME.U…" on a config-file server
for await (const msg of await agent.prompt("hello")) {
  /* the receiver sees a VerifiedSender */
}
```

What to know:

- **Identity is opt-in.** Omit `identity` for no lookup and no header. Pass `identity: {}` explicitly for an unsigned claim, or set `sendUnsignedClaim: false` to perform no automatic identity work. An unsigned claim discloses your user NKEY to the receiver.
- **Use the connection's credentials.** The SDK cannot extract a private seed from an already-open connection, so the signer is supplied explicitly. Build the NATS authenticator and `signerFromCreds` from the same credentials snapshot (or otherwise ensure `signerFromSeed` / `signerFromContext` represents that connection). Before a signed send, the SDK compares the signer's user and account with live `$SYS.REQ.USER.INFO`; a mismatch or unavailable binding fails and never downgrades to unsigned or headerless delivery.
- **Cost.** Identity lookup has a 2 s timeout. TypeScript memoises by connection and public identity-source fingerprint, clears all entries on reconnect, negative-caches failures for 30 s, and never lets an unsigned lookup satisfy a signer's validation. A signed header is ~400 bytes and counts against `max_payload` (header framing included — `PayloadTooLargeError.headerBytes`).
- **Behind a service import that remaps the subject** — an export that inserts the caller's account token (`account_token_position`), or a `to:` / `local_subject` rename by your own account — discovery reports the exporter's subject, which you cannot publish to. Pass `prompt(text, { subject })` / `status({ subject })` with the local name; the receiver strips an inserted token by itself. Only for a rename by **your own** account also pass `sub: agent.promptEndpoint.subject` (sign the exporter's subject). `signSender` / `publishSigned` / `requestSigned` take the same `sub` option.
- **A trusted server over TLS is a precondition.** The NATS handshake signs a server-chosen nonce with the same seed that signs `Agent-Sender`; a server you should not have trusted could obtain a signature valid for 30 s. Identity is meaningful only over TLS to a server whose certificate you verify.
- The verified identity is the **user** key; `account` is the sender's signed claim (`formatSender` renders `… (verified user, claimed account)`). Which verified senders a receiver accepts is the receiver's business — see the host package's `acceptSender`. A receiver whose deployment has _closed_ its endpoint can turn on the host package's `operatorAttested` mode, which cross-checks the signed pair against the server's `Nats-Request-Info` stamp and renders an agreeing account as `(verified)`.
- **Only the request is signed.** Prompt response chunks and mid-stream query replies are not independently authenticated; do not infer the actor answering a query from the original prompt sender.
- **Reverse lookup.** `agents.resolveSender(id)` (also `new SenderResolver(nc, { ttlMs })` and the uncached `resolveSender(nc, id)`) turns a verified agent ID back into the `AgentInfo` that registered it: `$SRV.INFO.agents` is enumerated, every candidate's `id_sig` verified against its own prompt subject, and the index cached for `resolveTtlMs` (default 10 s; concurrent callers share one enumeration). `undefined` means "not a reachable agent" — a human user, a plain service, or an agent that is offline. Discovery is account-local, and the lookup identifies, never authorizes. On the host side the same lookup is bound to `response.sender.resolve()`.
- **`verifySender(msg, "live" | "stored")`** is the spec's `VerifySender` over anything shaped `{ subject, data, headers? }` — a core `Msg`, a `ServiceMsg`, a JetStream `JsMsg`. `live` runs the freshness checks (the nonce is only _looked up_ — the receiver records it); `stored` proves authorship of a stored record against its stored subject and skips freshness, so consumers dedupe on `(user, nonce)` themselves.

Subpath exports:

- **`@synadia-ai/agents/errors`** - the error class hierarchy, for targeted `instanceof` branches.

The host-side `ReferenceAgent` previously available at `@synadia-ai/agents/testing` moved to [`@synadia-ai/agent-service/testing`](../../agent-sdk/typescript/) when the SDK split into caller + host packages. Anything you used to import from there is in the new sister package now.

## Documentation

- [Getting started](./docs/getting-started.md) - end-to-end walkthrough with error handling, cancellation, and liveness.
- [Protocol mapping](./docs/protocol-mapping.md) - every SDK call cross-referenced to the spec.
- [`examples/`](./examples) - six runnable scripts (discover, prompt-text, prompt-attachment, query-reply, liveness, chat).

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
