# pi-headless

A headless NATS agent host for the [PI coding agent](https://github.com/earendil-works/pi), built on `@synadia-ai/agents` (caller-side primitives) and `@synadia-ai/agent-service` (host-side `ReferenceAgent`) and conforming to the Synadia Agent Protocol for NATS **v0.3** (verb-first subjects + `status` endpoint).

Each spawned PI session registers as its own NATS agent instance under `agents.prompt.pi-headless.<owner>.<session_id>` - discoverable via `$SRV.INFO.agents` and promptable with any protocol-compliant client, including the `@synadia-ai/agents` SDK. A small **controller** service at `agents.prompt.pi-headless.<owner>.<name>` (default `name = "control"`) adds request/reply endpoints for session lifecycle - `spawn`, `stop`, `list` - alongside the protocol-required `prompt` endpoint (which returns help text) and a `status` endpoint that replies with the same payload as a heartbeat.

In short: one process, many PI sessions, all first-class NATS agents.

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
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "defaultThinkingLevel": "off",
  "defaultMaxLifetimeS": 1800
}
```

Env overrides:

| Variable | Overrides | Default |
| --- | --- | --- |
| `PI_HEADLESS_OWNER` | Owner subject token (3rd segment) | `$USER` |
| `PI_HEADLESS_NAME` | Controller instance name (4th token) | `control` |
| `PI_HEADLESS_DEFAULT_MODEL` | Default model spec for spawns | (none — caller must set, or PI picks) |
| `PI_HEADLESS_DEFAULT_THINKING_LEVEL` | Default thinking level for spawns | (none) |
| `PI_HEADLESS_DEFAULT_MAX_LIFETIME` | Default session lifetime, in seconds | `1800` |

Precedence (high → low): CLI flags → env vars → `~/.pi-headless/config.json` → built-in defaults.

PI auth / model registry comes from `~/.pi/agent/auth.json` (the same location `pi` uses).

## Subject layout

Verb-first throughout — protocol verbs and pi-headless extension verbs share the same `agents.<verb>.pi-headless.<owner>.<token>` shape, so a tracer or audit layer can subscribe to `agents.<verb>.>` and parse identity positionally.

```
agents.prompt.pi-headless.<owner>.<name>      ← controller prompt endpoint (help text)
agents.status.pi-headless.<owner>.<name>      ← controller status (replies with heartbeat-shaped payload)
agents.hb.pi-headless.<owner>.<name>          ← controller heartbeat (30 s)
agents.spawn.pi-headless.<owner>.<name>       ← POST JSON → session descriptor
agents.stop.pi-headless.<owner>.<name>        ← POST { session_id } → { ok: true }
agents.list.pi-headless.<owner>.<name>        ← (empty) → { sessions: [...] }

agents.prompt.pi-headless.<owner>.<session_id>  ← spawned session prompt
agents.status.pi-headless.<owner>.<session_id>  ← spawned session status
agents.hb.pi-headless.<owner>.<session_id>      ← spawned session heartbeat (30 s)
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
import { Agents } from "@synadia-ai/agents";

const nc = await connect({ servers: "nats://localhost:4222" });
const agents = new Agents({ nc });

const all = await agents.discover();
const session = all.find(a => a.name === "sess-a1b2c3d4")!;
for await (const ev of await session.prompt("summarise the files in this directory")) {
  if (ev.type === "response") process.stdout.write(ev.text);
}

await agents.close();
await nc.close();
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

| Code | When                                                                 |
|------|----------------------------------------------------------------------|
| 400  | Bad JSON, missing cwd, unknown model, invalid thinking level, bad base64 |
| 404  | `stop` for an unknown session                                        |
| 500  | PI SDK threw during prompt execution                                  |

Session prompt endpoints follow protocol §9.

## CLI helpers

- `bun run scripts/spawn.ts --cwd /path [--prompt …] [--stop-after]` - end-to-end smoke test.
- `bun run scripts/list.ts` - print active sessions from every reachable controller.
- `bun run scripts/stop.ts SESSION_ID` - dispose a session.

## Notes

- **Session identity.** The 4th subject token is the session id; `metadata.session` echoes it. Controllers use `name = "control"` by default and sessions carry `metadata.role = "session"`.
- **Metadata marker.** The controller carries `metadata.role = "controller"` so clients can tell it apart from sessions. The shared `agent: "pi-headless"` token already disambiguates this from the regular `agent: "pi"` runtime.
- **Multiple controllers per host.** On startup the controller probes `$SRV.INFO.agents` and, if its target prompt subject is already claimed, picks the next free `<name>-2`, `<name>-3`, … suffix automatically. So booting a second pi-headless with default settings leaves the first as `control` and the second as `control-2` without explicit `--name` flags. (For deterministic naming or two stable controllers side-by-side, still pass `--name` explicitly.)
- **Serial drain.** Per session, prompts are queued and processed one at a time.
- **Lifetime & pruning.** `max_lifetime_s` bounds a session's wall-clock life; pending requests older than 30 min are evicted (active requests are never evicted).
- **Attachments.** Base64 attachments are decoded to `~/.pi-headless/attachments/<session_id>/<uuid>/` and their absolute paths are prepended to the prompt text, matching the `agents/pi/` staging pattern.
