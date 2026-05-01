# pi-headless

A headless NATS agent host for the [PI coding agent](https://github.com/badlogic/pi-mono), built on `@synadia-ai/agents` (caller-side primitives) and `@synadia-ai/agent-service` (host-side `ReferenceAgent`) and conforming to the NATS Agent Protocol **v0.3** (verb-first subjects + `status` endpoint).

Each spawned PI session registers as its own NATS agent instance under `agents.prompt.pi.<owner>.<session_id>` - discoverable via `$SRV.INFO.agents` and promptable with any protocol-compliant client, including the `@synadia-ai/agents` SDK. A small **controller** service at `agents.prompt.pi.<owner>.<name>` (default `name = "exec"`) adds request/reply endpoints for session lifecycle - `spawn`, `stop`, `list` - alongside the protocol-required `prompt` endpoint (which returns help text) and a `status` endpoint that replies with the same payload as a heartbeat.

In short: one process, many PI sessions, all first-class NATS agents.

Paired with [`examples/agent-web-ui/`](../agent-web-ui) you also get a browser-based **PI Exec** workspace that picks up spawned sessions automatically, surfaces lifetime/queue metadata, and includes a fan-out composer for running one prompt across many working directories in parallel.

## Quickstart

```bash
# 1. Build both SDKs (workspace siblings, referenced via file:). The
#    extra `bun install` in agent-sdk re-copies the freshly-built
#    caller dist into agent-sdk/node_modules/@synadia-ai/agents/, which
#    is the path the host SDK's compiled output resolves at runtime.
(cd ../../client-sdk/typescript && bun install && bun run build)
(cd ../../agent-sdk/typescript  && bun install && bun run build)

# 2. Run pi-headless.
cd ../../examples/pi-headless
bun install
bun run start                # connects via $NATS_CONTEXT or NATS_URL
# pi-headless: controller listening on agents.prompt.pi.<you>.exec
# pi-headless: extra endpoints - …exec.spawn  …exec.stop  …exec.list

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
  "name": "exec",
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "defaultThinkingLevel": "off",
  "defaultMaxLifetimeS": 1800
}
```

Env overrides:

| Variable | Overrides | Default |
| --- | --- | --- |
| `PI_HEADLESS_OWNER` | Owner subject token (3rd segment) | `$USER` |
| `PI_HEADLESS_NAME` | Controller instance name (4th token) | `exec` |
| `PI_HEADLESS_DEFAULT_MODEL` | Default model spec for spawns | (none — caller must set, or PI picks) |
| `PI_HEADLESS_DEFAULT_THINKING_LEVEL` | Default thinking level for spawns | (none) |
| `PI_HEADLESS_DEFAULT_MAX_LIFETIME` | Default session lifetime, in seconds | `1800` |

Precedence (high → low): CLI flags → env vars → `~/.pi-headless/config.json` → built-in defaults.

PI auth / model registry comes from `~/.pi/agent/auth.json` (the same location `pi` uses).

## Subject layout

```
agents.prompt.pi.<owner>.<name>             ← controller prompt endpoint (help text)
agents.status.pi.<owner>.<name>             ← controller status (§8.7 (v0.3); replies with heartbeat-shaped payload)
agents.hb.pi.<owner>.<name>                 ← controller heartbeat (§8.1 v0.3, 30 s)
agents.pi.<owner>.<name>.spawn              ← POST JSON → session descriptor (custom; non-verb-first)
agents.pi.<owner>.<name>.stop               ← POST { session_id } → { ok: true }    (custom)
agents.pi.<owner>.<name>.list               ← (empty) → { sessions: [...] }          (custom)

agents.prompt.pi.<owner>.<session_id>       ← spawned session prompt (§5/§6, v0.3)
agents.status.pi.<owner>.<session_id>       ← spawned session status (§8.7 (v0.3))
agents.hb.pi.<owner>.<session_id>           ← spawned session heartbeat (§8.1 v0.3, 30 s)
```

## Wire examples

### Spawn

```bash
nats req agents.pi.$USER.exec.spawn \
  '{"cwd":"/tmp/pi-sandbox","model":"anthropic/claude-sonnet-4-5","max_lifetime_s":900}' \
  --timeout=10s
# → { "session_id":"sess-a1b2c3d4", "subject":"agents.prompt.pi.$USER.sess-a1b2c3d4", "status_subject":"agents.status.pi.$USER.sess-a1b2c3d4", ... }
```

### Prompt (protocol-standard - no custom format)

```bash
nats req agents.prompt.pi.$USER.sess-a1b2c3d4 \
  'summarise the files in this directory' --replies=0 --timeout=60s
# → {"type":"status","data":"ack"}
# → {"type":"response","data":"There are three files: …"}
# → (empty terminator)
```

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
nats req agents.pi.$USER.exec.stop '{"session_id":"sess-a1b2c3d4"}'
# → { "ok": true, "session_id":"sess-a1b2c3d4" }
```

### List

```bash
nats req agents.pi.$USER.exec.list ''
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

- **Session identity.** The 4th subject token is the session id; `metadata.session` echoes it. Controllers use `name = "exec"` by default.
- **Metadata marker.** The controller carries `metadata.role = "pi-headless-controller"` so clients can tell it apart from other pi agents.
- **One controller per `(owner, name)`.** The custom `spawn` / `stop` / `list` endpoints are NATS micro-service endpoints, which load-balance across all instances sharing the same subject. If you need multiple controllers side-by-side, give each one a distinct `--name` (e.g. `--name exec-a`, `--name exec-b`) so they advertise on different subjects and don't cross-steal each other's control requests.
- **Serial drain.** Per session, prompts are queued and processed one at a time.
- **Lifetime & pruning.** `max_lifetime_s` bounds a session's wall-clock life; pending requests older than 30 min are evicted (active requests are never evicted).
- **Attachments.** Base64 attachments are decoded to `~/.pi-headless/attachments/<session_id>/<uuid>/` and their absolute paths are prepended to the prompt text, matching the `agents/pi/` staging pattern.
