# @synadia-ai/agent-service

**Server-side TypeScript SDK for the [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs).** Host an agent — register the `agents` micro service, serve the `prompt` and `status` endpoints, publish heartbeats, and stream typed chunks back to callers.

Pairs with [`@synadia-ai/agents`](../../client-sdk/typescript/) (the caller-side SDK). Agent harness authors install both — caller imports stay on `@synadia-ai/agents` (subjects, envelope types, errors), host imports come from `@synadia-ai/agent-service` (`AgentService`, `ReferenceAgent`, server-side wire helpers). The two packages release in lockstep.

- **`AgentService`** handles the §12 agent-checklist boilerplate: registration, prompt + status endpoints, heartbeat loop, per-request keep-alive, terminator emission, 400/500 error handling.
- **`extraEndpoints`** + **`.service` getter** — register custom endpoints (e.g. `spawn` / `stop` / `list` on a controller agent) alongside the protocol-required ones, with collision validation. The getter is an escape hatch for runtime-dynamic registration.
- **`ReferenceAgent`** — spec-compliant test counterparty exposed via the `/testing` subpath.
- **Runs on Node ≥ 20 and Bun ≥ 1.2.**

## Install

```sh
bun add @synadia-ai/agents @synadia-ai/agent-service
# or: npm install @synadia-ai/agents @synadia-ai/agent-service
# or: pnpm add @synadia-ai/agents @synadia-ai/agent-service
```

## 30-second quickstart — host an agent

You bring a `NatsConnection`; the SDK uses it. Use `@nats-io/transport-node` for TCP (`nats://`, `tls://`) or `wsconnect` from `@nats-io/nats-core` for WebSocket (`ws://`, `wss://`).

```ts
import { connect } from "@nats-io/transport-node";
import { AgentService } from "@synadia-ai/agent-service";

const nc = await connect({ servers: "nats://localhost:4222" });

const service = new AgentService({
  nc,
  agent: "echo", // metadata.agent — canonical harness identifier
  owner: "demo", // metadata.owner — operator / account namespace
  name: "main", // 5th subject token — instance name
  description: "Echo agent demo",
  heartbeatIntervalS: 30,
});

service.onPrompt(async (envelope, response) => {
  // The handler can stream as many chunks as it wants — terminator is automatic.
  await response.send(`echo: ${envelope.prompt}`);
});

await service.start();
console.log(`listening on ${service.subject.prompt}`);
```

**Try it now:** [`examples/01-echo.ts`](examples/01-echo.ts) is this same code packaged as a runnable script — `bun examples/01-echo.ts` (with `$NATS_CONTEXT`, `$NATS_URL`, or localhost fallback).

`service.start()` is everything: it adds the `prompt` and `status` endpoints with the right queue groups, advertises the broker-derived `max_payload`, kicks off the heartbeat publisher (with an immediate first beat so discovery is prompt), and stays running until you call `service.stop()`.

The matching caller-side code lives next to [`@synadia-ai/agents`](../../client-sdk/typescript/) — see its README for `discover()` / `prompt()`.

## Custom endpoints

A controller-style agent often needs more than the protocol-required `prompt` + `status`. Declare them upfront with `extraEndpoints`:

```ts
import { AgentService, type AgentServiceExtraEndpoint } from "@synadia-ai/agent-service";

const spawn: AgentServiceExtraEndpoint = {
  name: "spawn",
  subject: "agents.spawn.echo.demo.main",
  queue: "echo-controllers",
  handler: (err, msg) => {
    if (err) return;
    msg.respond(new TextEncoder().encode(`spawned`));
  },
  metadata: { role: "controller" },
};

const service = new AgentService({
  nc,
  agent: "echo",
  owner: "demo",
  name: "main",
  extraEndpoints: [spawn /*, stop, list, … */],
});
```

`start()` validates names against `prompt`, `status`, and other `extraEndpoints` entries, so a collision fails fast before any registration happens. Subjects are advertised verbatim — the SDK does not prefix them.

For runtime-dynamic registration, use the `.service` getter as an escape hatch:

```ts
await service.start();
service.service.addEndpoint("late-bound", {/* … */});
```

The getter throws if accessed before `start()`, and direct calls bypass `extraEndpoints`'s duplicate-name guard — prefer the declarative form.

## Wire helpers

The SDK exports the chunk and heartbeat encoders for harnesses that need them outside the `AgentService` flow (e.g. an event-driven streamer that doesn't fit the closed-handler shape):

| Export                                                         | Purpose                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `encodeChunk(chunk)`                                           | Encode a typed chunk (`response` / `status` / `query`) to wire JSON bytes. |
| `splitResponseText(text, maxBytes, opts?)`                     | UTF-8-safe chunker for long response payloads.                             |
| `buildHeartbeatPayload(subject, intervalS, instanceId, opts?)` | Build a §8.3 heartbeat / status payload.                                   |
| `encodeHeartbeatPayload(payload)`                              | Encode that payload to wire JSON bytes.                                    |
| `DEFAULT_MAX_PAYLOAD` / `DEFAULT_*` constants                  | Fallback values when no broker `INFO.max_payload` is reported, etc.        |

The `agents/openclaw`, `agents/pi`, and `agents/claude-code` harnesses in this monorepo use these primitives directly today; `agents/codex`, `agents/opencode`, `agents/flue`, `agents/eve`, and `agents/open-agent` use `AgentService` directly, and the controller agents in `examples/pi-headless` and `examples/claude-code-headless` are obvious migration candidates for `AgentService`.

## Sender identity

`AgentService` implements the receiver side of the
[sender-identity extension](https://github.com/synadia-ai/synadia-agent-fabric-docs/blob/master/docs/agent-protocol-sender-identity.md):
every `prompt` request is classified **before** the §6.4 ack, and the handler sees the result as `response.sender`.

```ts
import { formatSender, signerFromSeed } from "@synadia-ai/agents";
import { AgentService } from "@synadia-ai/agent-service";

const service = new AgentService({
  nc,
  agent: "echo",
  owner: "demo",
  name: "main",
  identity: { signer: signerFromSeed(await readFile(process.env.NATS_NKEY_SEED_FILE!, "utf8")) },
  minSenderTrust: "signed", // default "any"
  acceptSender: (sender) => sender?.trust === "verified" && allowlist.has(sender.id),
  logger,
});
service.onPrompt(async (envelope, response) => {
  await response.send(`hello from ${formatSender(response.sender)}`);
});
```

| Outcome                                                                            | Wire                                                                               |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| No `Agent-Sender`, or an unknown `v`                                               | served; `response.sender === undefined`                                            |
| Malformed header                                                                   | `400`                                                                              |
| Failing signature, replayed nonce, stale `ts`, `sub` not the arrival subject       | `401` — in every mode                                                              |
| Unsigned / header-less request on a `min_sender_trust: signed` endpoint            | `401` (`signature required`)                                                       |
| `acceptSender` returns `false` for a verified sender / for a claimed or absent one | `403` / `401`                                                                      |
| `acceptSender` throws                                                              | `500`, logged, never served                                                        |
| Verified sender                                                                    | served; `response.sender.trust === "verified"`, `.id` is the agent ID              |
| Unsigned claim                                                                     | served; `response.sender.trust === "claimed"` — **no `id`**, never authorize on it |

What to know:

- **Registration.** When the connection has an NKEY identity the service registers `user_nkey` and `account`; with `identity.signer` it also registers `id_sig` (`AGENT-ID-V1` over the prompt subject) so callers can verify the claim (`agent.idSigVerified`). `min_sender_trust` is **always** emitted on the prompt endpoint — its presence is what advertises the extension — and never on `status`. A signer that is not the connection's user makes `start()` throw `IdentityMismatchError`; a connection without an identity starts without the keys (logged) — verifying _senders_ needs no host identity.
- **The verified identity is `user`.** `account` is the sender's signed claim; `formatSender` renders `… (verified user, claimed account)`. Which verified senders to accept is authorization — the `acceptSender` hook is where a harness consults a list it provisions or, later, the fabric's agent registry. The hook runs for every classified prompt (never for `status`); per-request network I/O in it delays the ack and is an amplification vector on `any` endpoints.
- **Replay protection** is a per-instance nonce set (`replayWindowMs`, default 30 s; entries expire at `ts + window`, bounded by a hard cap). Instances behind the `agents` queue group do not share it and a restart empties it; the `ts` window bounds both.
- **`status`** is classified and logged, never rejected — a liveness probe must not depend on the prober's credentials.
- **`accountTokenPosition`** is for a service behind an export that inserts the caller's account token (`account_token_position`, the ScratchPad shape): the receiver checks the token against the header's `account` and accepts `sub` with the token removed. The inserted token is a server stamp only on a **closed** endpoint. Note that `AgentService` hosts five-token `agents.{verb}.a.o.n` subjects, which such an export turns into six-token arrivals its subscription never sees — the option is validated and honoured by the classifier, but hosting _behind_ such an export today means a hand-rolled service on the wildcard subject calling `verifySenderHeader(…, { accountTokenPosition })` (see `test/integration/identity-accounts.test.ts` in the caller package).
- **Cross-account callers** need the deployment's help: export the prompt subject with `response_type: stream` (a response is many messages — without it every reply after the first is dropped silently), export `$SRV.>` for discovery, and export the inbox prefix if the agent asks mid-stream queries. Callers behind a renaming import (`to:` / `local_subject`) publish the local name and sign the exporter's subject (`prompt(text, { subject, sub })`); nothing to configure on this side.
- **Operator-attested mode** (reading `Nats-Request-Info` on a closed endpoint to attest the account) is a deployment promise the SDK cannot verify and ships in a later release; today `accountAttested` is always `false`.
- **A trusted server over TLS is a precondition** of identity: the NATS handshake signs a server-chosen nonce with the same seed that signs `Agent-Sender`.

`SenderGate` / `NonceCache` expose the same classification for hand-rolled services; the codec itself (`verifySenderHeader`, `SenderInfo`, `formatSender`, `AgentId`) lives in `@synadia-ai/agents` and is not re-exported here.

## Reference agent (`@synadia-ai/agent-service/testing`)

```ts
import { connect } from "@nats-io/transport-node";
import { ReferenceAgent } from "@synadia-ai/agent-service/testing";

const nc = await connect({ servers: "nats://localhost:4222" });
const ref = new ReferenceAgent({
  nc,
  agent: "echo",
  owner: "demo",
  name: "ref",
  heartbeatIntervalS: 1,
});
await ref.start();
```

`ReferenceAgent` implements the full §12 agent checklist with no-frills defaults — useful as a counterparty in caller-side integration tests and for cross-SDK interop checks. It accepts a custom `promptHandler` callback (a raw `ServiceMsg` plus the classified sender) so tests can assert on malformed inputs, drop chunks, and emit unknown shapes that production agents would never produce. It takes the same identity options as `AgentService` (`identity`, `minSenderTrust`, `acceptSender`, `replayWindowMs`, `accountTokenPosition`, `logger`). For real harnesses use `AgentService` instead.

The caller SDK's integration tests use `ReferenceAgent` as their agent counterparty — see [`client-sdk/typescript/test/integration/`](../../client-sdk/typescript/test/integration/).

## What's in the box

| API                                                                                                             | Purpose                                                                                           |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `new AgentService({ nc, agent, owner, name, ... })`                                                             | Register and run a protocol-compliant agent.                                                      |
| `service.onPrompt(handler)`                                                                                     | Wire up the `prompt` handler. `(envelope, response) => …`.                                        |
| `service.start()` / `service.stop()`                                                                            | Lifecycle.                                                                                        |
| `service.subject` / `service.instanceId` / `.service`                                                           | Inspection: subject builder, service id, underlying micro service.                                |
| `extraEndpoints` option                                                                                         | Declarative custom endpoints.                                                                     |
| `PromptResponse.send` / `.ask` / `.sender`                                                                      | Stream chunks back; `.ask` round-trips a §7 mid-stream query; `.sender` is the classified sender. |
| `identity`, `minSenderTrust`, `acceptSender`, `replayWindowMs`, `accountTokenPosition`, `logger` options        | Sender identity — see above.                                                                      |
| `SenderGate`, `NonceCache`                                                                                      | Sender classification for hand-rolled services.                                                   |
| `ReferenceAgent` (`/testing`)                                                                                   | Spec-compliant counterparty for tests.                                                            |
| `encodeChunk`, `splitResponseText`, `buildHeartbeatPayload`, `encodeHeartbeatPayload`                           | Wire primitives.                                                                                  |
| `DEFAULT_ATTACHMENTS_OK`, `DEFAULT_HEARTBEAT_INTERVAL_S`, `DEFAULT_KEEPALIVE_INTERVAL_S`, `DEFAULT_MAX_PAYLOAD` | Server-side defaults.                                                                             |

Subpath exports:

- **`@synadia-ai/agent-service/testing`** — the `ReferenceAgent` helper.

The error class hierarchy lives on the caller side at [`@synadia-ai/agents/errors`](../../client-sdk/typescript/) — both packages share the same types so an `instanceof` check on either side reaches the same class.

## Local development

The package depends on `@synadia-ai/agents` via a `file:` link to the sibling caller package; both packages need a current `dist/` for consumers to load. Build caller first, then host:

```sh
(cd ../../client-sdk/typescript && bun run build)
(cd ../../agent-sdk/typescript  && bun install && bun run build)
```

The repo's [`README-DEV.md`](../../README-DEV.md) covers the build/install dance for every common workflow (running examples, installing the agent plugins locally, running test suites).

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
