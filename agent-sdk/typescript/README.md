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

`AgentService` implements the receiver side of the optional sender-identity
extension: every `prompt` request is classified **before** the §6.4 ack,
and the handler sees the result as `response.sender`.

```ts
import { formatSender } from "@synadia-ai/agents";
import { AgentService } from "@synadia-ai/agent-service";

const service = new AgentService({
  nc,
  agent: "echo",
  owner: "demo",
  name: "main",
  // hostSigner must come from the same credential snapshot that authenticated `nc`.
  identity: { signer: hostSigner },
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

- **Registration is opt-in.** Omit `identity` for no host-identity lookup and no `user_nkey`, `account`, or `id_sig` metadata. Incoming senders are still classified. Pass `identity: {}` explicitly for best-effort unsigned registration, or provide a signer to register `id_sig` (`AGENT-ID-V1` over the prompt subject). A signer is checked against the live connection's user and account; mismatch or unavailable binding makes `start()` fail and never downgrades. `min_sender_trust` is always emitted on the prompt endpoint and defaults to `"any"` independently of host identity.
- **The verified identity is `user`.** `account` is the sender's signed claim; `formatSender` renders `… (verified user, claimed account)`. Which verified senders to accept is authorization — the `acceptSender` hook is where a harness consults its provisioned policy. The hook runs for every classified prompt (never for `status`); per-request network I/O in it delays the ack and is an amplification vector on `any` endpoints.
- **Replay protection** is a per-instance nonce set (`replayWindowMs`, default 30 s; entries expire at `ts + window`, bounded by a hard cap). Instances behind the `agents` queue group do not share it and a restart empties it; the `ts` window bounds both.
- **`status`** is classified and logged, never rejected — a liveness probe must not depend on the prober's credentials.
- **Only the incoming request is signed.** Prompt responses and mid-stream query replies are not independently authenticated; do not attribute a query reply to the original prompt sender.
- **Account-token insertion requires a hand-rolled wildcard service.** An export with `account_token_position` turns AgentService's fixed five-token subject into a six-token arrival its subscription cannot receive, so AgentService deliberately exposes no `accountTokenPosition` option. Use `SenderGate` or `verifySenderHeader(…, { accountTokenPosition })` on the wildcard subscription; the receiver then checks the token against the header's `account` and accepts `sub` with the token removed. The inserted token is a server stamp only on a **closed** endpoint (see `test/integration/identity-accounts.test.ts` in the caller package).
- **Cross-account callers** need the deployment's help: export the prompt subject with `response_type: stream` (a response is many messages — without it every reply after the first is dropped silently), export `$SRV.>` for discovery, and export the inbox prefix if the agent asks mid-stream queries. Callers behind a renaming import (`to:` / `local_subject`) publish the local name and sign the exporter's subject (`prompt(text, { subject, sub })`); nothing to configure on this side.
- **Reverse lookup.** `response.sender.resolve()` on a verified sender returns the `AgentInfo` of the agent that registered that ID with a verifying `id_sig` (enumerated through `$SRV.INFO.agents` on this connection, so account-local; `undefined` when no verified instance claims the key — a human user, a plain service, an agent that is offline). The index is cached for `resolveTtlMs` (default 10 s). It identifies; whether to accept is still `acceptSender`'s call.
- **Operator-attested mode** (`operatorAttested: true`, off by default) reads the server's `Nats-Request-Info` stamp and is a **deployment promise the SDK cannot verify**: turn it on only when the endpoint is _closed_ — no same-account user may publish to its subjects, so every arriving request crossed a service import and the stamp is the server's. With it on, a verified header whose signed `account` / `user` disagree with a present stamp is refused (`401`), a present but unparseable stamp is refused, an absent stamp is compared to nothing, and agreement on `acc` surfaces as `response.sender.accountAttested === true` (`formatSender` → `(verified)`). Claims are never cross-checked. A hand-rolled `SenderGate` can additionally attest through its `accountTokenPosition` cross-check. On an open endpoint (the typical NGS account where peers call each other) leave it off: a peer can write that header, and the mode would attest a forgery.
- **A trusted server over TLS is a precondition** of identity: the NATS handshake signs a server-chosen nonce with the same seed that signs `Agent-Sender`.

`SenderGate` / `NonceCache` expose the same classification for hand-rolled services (`SenderGateOptions.operatorAttested` / `.resolver` bind the two features above); the codec itself (`verifySender`, `verifySenderHeader`, `SenderInfo`, `formatSender`, `AgentId`, `SenderResolver`) lives in `@synadia-ai/agents` and is not re-exported here.

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

`ReferenceAgent` implements the full §12 agent checklist with no-frills defaults — useful as a counterparty in caller-side integration tests and for cross-SDK interop checks. It accepts a custom `promptHandler` callback (a raw `ServiceMsg` plus the classified sender) so tests can assert on malformed inputs, drop chunks, and emit unknown shapes that production agents would never produce. It takes the same identity options as `AgentService` (`identity`, `minSenderTrust`, `acceptSender`, `replayWindowMs`, `resolveTtlMs`, `operatorAttested`, `logger`). For real harnesses use `AgentService` instead.

The caller SDK's integration tests use `ReferenceAgent` as their agent counterparty — see [`client-sdk/typescript/test/integration/`](../../client-sdk/typescript/test/integration/).

## What's in the box

| API                                                                                                                  | Purpose                                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `new AgentService({ nc, agent, owner, name, ... })`                                                                  | Register and run a protocol-compliant agent.                                                      |
| `service.onPrompt(handler)`                                                                                          | Wire up the `prompt` handler. `(envelope, response) => …`.                                        |
| `service.start()` / `service.stop()`                                                                                 | Lifecycle.                                                                                        |
| `service.subject` / `service.instanceId` / `.service`                                                                | Inspection: subject builder, service id, underlying micro service.                                |
| `extraEndpoints` option                                                                                              | Declarative custom endpoints.                                                                     |
| `PromptResponse.send` / `.ask` / `.sender`                                                                           | Stream chunks back; `.ask` round-trips a §7 mid-stream query; `.sender` is the classified sender. |
| `identity`, `minSenderTrust`, `acceptSender`, `replayWindowMs`, `resolveTtlMs`, `operatorAttested`, `logger` options | Sender identity — see above.                                                                      |
| `SenderGate`, `NonceCache`                                                                                           | Sender classification for hand-rolled services.                                                   |
| `ReferenceAgent` (`/testing`)                                                                                        | Spec-compliant counterparty for tests.                                                            |
| `encodeChunk`, `splitResponseText`, `buildHeartbeatPayload`, `encodeHeartbeatPayload`                                | Wire primitives.                                                                                  |
| `DEFAULT_ATTACHMENTS_OK`, `DEFAULT_HEARTBEAT_INTERVAL_S`, `DEFAULT_KEEPALIVE_INTERVAL_S`, `DEFAULT_MAX_PAYLOAD`      | Server-side defaults.                                                                             |

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
