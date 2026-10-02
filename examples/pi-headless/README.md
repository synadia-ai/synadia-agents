# pi-headless

A headless NATS agent host for the [PI coding agent](https://github.com/earendil-works/pi), built on `@synadia-ai/agents` (caller-side primitives) and `@synadia-ai/agent-service` (host-side `AgentService`) and conforming to the Synadia Agent Protocol for NATS **v0.3** (verb-first subjects + `status` endpoint).

Each spawned PI session registers as its own logical NATS agent instance under `agents.prompt.pi-headless.<owner>.<session_id>` - discoverable via `$SRV.INFO.agents` and promptable with any protocol-compliant client, including the `@synadia-ai/agents` SDK. A small **controller** service at `agents.prompt.pi-headless.<owner>.<name>` (default `name = "control"`) adds request/reply endpoints for session lifecycle - `spawn`, `stop`, `list` - alongside the protocol-required `prompt` and `status` endpoints.

In short: one process, one NATS connection, many first-class logical PI agents. When signed sender identity is enabled, the controller and every session share that connection's one cryptographic user identity; session ids and subjects remain routing labels, not separate cryptographic identities.

Paired with [`examples/agent-web-ui/`](../agent-web-ui) you also get a browser-based **PI Exec** workspace that picks up spawned sessions automatically, surfaces lifetime/queue metadata, and includes a fan-out composer for running one prompt across many working directories in parallel.

## Quickstart (run from npm)

The package ships a `nats-pi-headless` CLI binary, so the simplest way to
try it is via `npx` — no clone, no build:

```bash
# Pick a NATS target via context or URL; both are picked up via env or flag.
NATS_CONTEXT=localhost npx @synadia-ai/nats-pi-headless
# or:
NATS_URL=nats://127.0.0.1:4222 npx @synadia-ai/nats-pi-headless
# or:
npx @synadia-ai/nats-pi-headless --context localhost
```

`npx` resolves the package, runs its bundled entry point under Node ≥ 20,
and prints:

```
pi-headless: controller listening on agents.prompt.pi-headless.<you>.control
pi-headless: control endpoints — agents.spawn.pi-headless.<you>.control  …  agents.stop.…  agents.list.…
```

For a permanent install:

```bash
npm install -g @synadia-ai/nats-pi-headless
nats-pi-headless --context localhost
```

PI auth / model registry comes from `~/.pi/agent/auth.json` (the same
location `pi` uses) — independent of how you launched the host.

Sender identity is off by default and incoming prompt policy is permissive,
so existing contexts and URL-based connections continue to work unchanged.

## Quickstart (run from a local clone)

When you're working on the SDK or this example itself:

```bash
# 1. Build both SDKs (workspace siblings, referenced via file:). The
#    extra `bun install` in agent-sdk re-copies the freshly-built
#    caller dist into agent-sdk/node_modules/@synadia-ai/agents/, which
#    is the path the host SDK's compiled output resolves at runtime.
(cd ../../client-sdk/typescript && bun install && bun run build)
(cd ../../agent-sdk/typescript  && bun install && bun run build)

# 2. Run pi-headless against the local SDK source via bun.
cd ../../examples/pi-headless
bun install
bun run start                # connects via $NATS_CONTEXT or NATS_URL

# 3. Spawn a session + prompt + stop, from another shell.
bun run scripts/spawn.ts --cwd /tmp/pi-sandbox --prompt "list the files here" --stop-after
```

See [`README-DEV.md`](../../README-DEV.md) at the repo root for a fuller
walk-through of the build / install dance, including how to pick up SDK
edits without rebooting everything.

## Configuration

Either a NATS [context](https://docs.nats.io/using-nats/nats-tools/nats_cli/context) or an explicit URL:

```bash
NATS_CONTEXT=localhost bun run start
# or
NATS_URL=nats://127.0.0.1:4222 bun run start
# or
bun run start --context localhost
```

Optional defaults live in `~/.pi-headless/config.json`:

```json
{
  "context": "localhost",
  "name": "control",
  "senderIdentity": "off",
  "minSenderTrust": "any",
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "defaultThinkingLevel": "off",
  "defaultMaxLifetimeS": 1800
}
```

Env overrides:

| Variable                                     | Overrides                                                                                     | Default                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- |
| `NATS_CONTEXT`, `NATS_URL`                   | NATS connection target; a context wins over a URL                                             | (required)                            |
| `NATS_SENDER_IDENTITY`                       | Outgoing/registration sender identity: `off` or `signed`                                      | `off`                                 |
| `NATS_MIN_SENDER_TRUST`                      | Incoming prompt policy: `any` or `signed`                                                     | `any`                                 |
| `SYNADIA_PI_HEADLESS_OWNER`, `SYNADIA_OWNER` | Owner subject token; per-agent var wins, then fleet-wide, then the legacy `PI_HEADLESS_OWNER` | `$USER`                               |
| `SYNADIA_PI_HEADLESS_NAME`, `SYNADIA_NAME`   | Controller instance name; same chain (legacy: `PI_HEADLESS_NAME`)                             | `control`                             |
| `PI_HEADLESS_DEFAULT_MODEL`                  | Default model spec for spawns                                                                 | (none — caller must set, or PI picks) |
| `PI_HEADLESS_DEFAULT_THINKING_LEVEL`         | Default thinking level for spawns                                                             | (none)                                |
| `PI_HEADLESS_DEFAULT_MAX_LIFETIME`           | Default session lifetime, in seconds                                                          | `1800`                                |

Precedence (high → low): CLI flags → env vars → `~/.pi-headless/config.json` → built-in defaults.

PI auth / model registry comes from `~/.pi/agent/auth.json` (the same location `pi` uses).

### Optional sender identity

The two identity settings are independent. The default is equivalent to:

```json
{
  "senderIdentity": "off",
  "minSenderTrust": "any"
}
```

To register the controller and every spawned session with the user identity
already used by their shared NATS connection:

```bash
NATS_CONTEXT=prod NATS_SENDER_IDENTITY=signed bun run start
```

The selected context must authenticate with signing material (`creds`,
`nkey`, or `user_jwt` plus `user_seed`). The shared SDK helper reads the
connection credentials once and derives both NATS authentication and the
signer from that same retained snapshot. There is no second identity-credentials
setting. Token, username/password, and anonymous connections remain supported
with `NATS_SENDER_IDENTITY=off`.

To require a signature-valid sender on controller and session **prompt**
endpoints, set the inbound policy separately:

```bash
NATS_MIN_SENDER_TRUST=signed bun run start --context prod
```

This does not enable the host's own sender identity. Conversely, enabling the
host identity does not make inbound policy strict. Invalid or missing
signatures on a strict prompt endpoint are rejected before the acknowledgement
and before PI receives the model prompt. Sender information is written only to
the operator diagnostic log and is never inserted into model input.

The `spawn`, `stop`, and `list` extension endpoints retain their existing raw
request/reply contract; `minSenderTrust` applies to protocol prompt endpoints.

### Shared connection identity

One NATS connection authenticates as one user. This process deliberately keeps
one connection, so the controller and all spawned sessions use the same signer
and register the same cryptographic identity. Their `name`, `session_id`,
subjects, trace ids, and `metadata.role` distinguish logical instances for
routing and observability, but cannot prove that one particular logical
session—as opposed to another session on the process—performed an action.
Independently credentialed per-session connections are not part of this
example.

## Subject layout

Verb-first throughout — protocol verbs and pi-headless extension verbs share the same `agents.<verb>.pi-headless.<owner>.<token>` shape, so a tracer or audit layer can subscribe to `agents.<verb>.>` and parse identity positionally.

```
agents.prompt.pi-headless.<owner>.<name>      ← controller prompt endpoint (help text)
agents.status.pi-headless.<owner>.<name>      ← controller status (replies with heartbeat-shaped payload)
agents.hb.pi-headless.<owner>.<name>          ← controller heartbeat (5 s)
agents.spawn.pi-headless.<owner>.<name>       ← POST JSON → session descriptor
agents.stop.pi-headless.<owner>.<name>        ← POST { session_id } → { ok: true }
agents.list.pi-headless.<owner>.<name>        ← (empty) → { sessions: [...] }

agents.prompt.pi-headless.<owner>.<session_id>  ← spawned session prompt
agents.status.pi-headless.<owner>.<session_id>  ← spawned session status
agents.hb.pi-headless.<owner>.<session_id>      ← spawned session heartbeat (5 s)
```

## Wire examples

### Spawn

```bash
nats req agents.spawn.pi-headless.$USER.control \
  '{"cwd":"/tmp/pi-sandbox","model":"anthropic/claude-sonnet-4-5","max_lifetime_s":900}' \
  --timeout=10s
# → { "session_id":"sess-a1b2c3d4", "subject":"agents.prompt.pi-headless.$USER.sess-a1b2c3d4", "status_subject":"agents.status.pi-headless.$USER.sess-a1b2c3d4", ... }
```

### Prompt (protocol-standard - no custom format)

```bash
nats req agents.prompt.pi-headless.$USER.sess-a1b2c3d4 \
  'summarise the files in this directory' \
  --replies=0 --reply-timeout=30s --timeout=60s
# → {"type":"status","data":"ack"}
# → {"type":"response","data":"There are three files: …"}
# → (empty terminator)
```

`--reply-timeout=30s` is important: the default 300 ms is shorter than the gap between the immediate ack chunk and the LLM's first response, so `nats req` exits after the ack alone. SDK callers (`requestMany` with `strategy:"sentinel"`) wait the full `maxWait` regardless of inter-arrival gaps and don't need this flag.

Programmatically with the SDK:

```ts
import { connect } from "@nats-io/transport-node";
import { Agents, resolveNatsConnectionBundle } from "@synadia-ai/agents";

const bundle = await resolveNatsConnectionBundle(
  { context: "prod" },
  { identity: "signed" }, // use "off" for an identity-free caller
);
const nc = await connect(bundle.connectionOptions);
const agents = new Agents({
  nc,
  ...(bundle.signer ? { identity: { signer: bundle.signer } } : {}),
});

const all = await agents.discover();
const session = all.find((a) => a.name === "sess-a1b2c3d4")!;
for await (const ev of await session.prompt(
  "summarise the files in this directory",
)) {
  if (ev.type === "response") process.stdout.write(ev.text);
}

await agents.close();
await nc.close();
bundle.wipe(); // only after the connection is closed
```

### Stop

```bash
nats req agents.stop.pi-headless.$USER.control '{"session_id":"sess-a1b2c3d4"}'
# → { "ok": true, "session_id":"sess-a1b2c3d4" }
```

### List

```bash
nats req agents.list.pi-headless.$USER.control ''
# → { "sessions": [ { "session_id":"sess-a1b2c3d4", "cwd":"/tmp/pi-sandbox", "remaining_lifetime_s": 867, ... } ] }
```

## Errors

Custom endpoints respond with NATS micro-service error headers (`Nats-Service-Error-Code` / `Nats-Service-Error`):

| Code | When                                                                     |
| ---- | ------------------------------------------------------------------------ |
| 400  | Bad JSON, missing cwd, unknown model, invalid thinking level, bad base64 |
| 404  | `stop` for an unknown session                                            |
| 500  | PI SDK threw during prompt execution                                     |

Session prompt endpoints follow protocol §9.

## CLI helpers

- `bun run scripts/spawn.ts --cwd /path [--prompt …] [--stop-after]` - end-to-end smoke test.
- `bun run scripts/list.ts` - print active sessions from every reachable controller.
- `bun run scripts/stop.ts SESSION_ID` - dispose a session.

The helpers use the same connection-bundle helper. With
`NATS_SENDER_IDENTITY=signed`, prompts sent by `spawn.ts` use a signer derived
from the helper process's selected connection credentials. This is a separate
CLI process and connection from the running headless host.

## Notes

- **Logical session routing.** The 5th subject token is the session id; `metadata.session` echoes it. Controllers use `name = "control"` by default and sessions carry `metadata.role = "session"`. These labels do not create separate cryptographic identities; all services on the process share its one connection identity.
- **Metadata marker.** The controller carries `metadata.role = "controller"` so clients can tell it apart from sessions. The shared `agent: "pi-headless"` token already disambiguates this from the regular `agent: "pi"` runtime.
- **Multiple controllers per host.** On startup the controller probes `$SRV.INFO.agents` and, if its target prompt subject is already claimed, picks the next free `<name>-2`, `<name>-3`, … suffix automatically. So booting a second pi-headless with default settings leaves the first as `control` and the second as `control-2` without explicit `--name` flags. (For deterministic naming or two stable controllers side-by-side, still pass `--name` explicitly.)
- **Resilient reconnects.** The controller wraps connection options with the SDK's `withAgentReconnectDefaults`, so it retries indefinitely (`maxReconnectAttempts: -1`) and stays in the reconnect loop through host sleep or short broker outages. Log lines: `pi-headless: NATS disconnected from … — retrying…` is transient; `pi-headless: NATS connection closed — agent is off-bus until restart` is terminal (usually repeated auth errors).
- **Serial drain.** Per session, prompts are queued and processed one at a time.
- **Lifetime & pruning.** `max_lifetime_s` bounds a session's wall-clock life; pending requests older than 30 min are evicted (active requests are never evicted).
- **Attachments.** Base64 attachments are decoded to `~/.pi-headless/attachments/<session_id>/<uuid>/` and their absolute paths are prepended to the prompt text, matching the `agents/pi/` staging pattern.
