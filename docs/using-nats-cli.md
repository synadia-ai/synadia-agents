# Talking to agents with the `nats` CLI

A practical guide to driving a **Synadia Agent Protocol for NATS** agent from the [`nats` CLI](https://github.com/nats-io/natscli) — no SDK required. Useful for smoke-testing your own agent, poking at a third-party one, or reproducing a wire-shape bug without writing code.

The protocol is fully documented at <https://github.com/synadia-ai/synadia-agent-sdk-docs>. This doc shows the CLI commands that map to each protocol surface.

## Prereqs

- [`nats` CLI](https://github.com/nats-io/natscli) installed and pointed at the right server. The examples assume a context is selected (`nats context select <name>`); otherwise pass `-s nats://host:4222 [--creds ...]` to every command.
- An agent already running and registered as the `agents` micro service. If you're starting from zero, the per-package READMEs in this repo (`agents/*/README.md`, `examples/*-headless/README.md`) walk you through booting one.

## Discovery — what agents are out there?

Agents register as a NATS micro service named `agents`. Use the standard service-info one-liner:

```bash
nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s
```

Every instance replies with its `metadata`: `agent` (harness identifier), `owner` (account namespace), `session` (5th subject token), and `protocol_version` (currently `0.3`). You can also use `$SRV.PING.agents` for a liveness ping or `nats micro list` for a tabular view.

```bash
nats micro list
nats micro info agents
```

## Heartbeats — is it still alive?

Every agent publishes a heartbeat on `agents.hb.{agent}.{owner}.{session}` every few seconds:

```bash
nats sub 'agents.hb.*.*.*'                       # all agents
nats sub 'agents.hb.pi.*.*'                      # just PI sessions
nats sub 'agents.hb.cc-headless.alice.*'         # all sessions owned by alice on the cc-headless harness
```

The payload is `{agent, owner, session, instance_id, ts, interval_s}` — `interval_s` tells you how often to expect the next one.

## Prompting an agent — the load-bearing part

The agent's prompt subject is `agents.prompt.{agent}.{owner}.{session}`. Replies stream back as **typed JSON chunks** terminated by an empty-body, no-headers message.

**The minimum viable invocation:**

```bash
nats req agents.prompt.pi.alice.my-session "list files in /tmp" \
  --replies=0 --reply-timeout=30s --timeout=60s
```

Three flags carry the weight. Skip any one and `nats req` will misbehave in a way that looks like a bug in the agent:

| Flag | Why |
| --- | --- |
| `--replies=0` | Tell `nats req` this is a multi-reply stream, not a single-reply RPC. Without it, the CLI hangs up after the first chunk. |
| `--reply-timeout=30s` | Max **gap between chunks** before the CLI gives up. Default is `300ms` — much shorter than the gap between the leading `status=ack` (§6.4, sent instantly) and the first `response` chunk from the LLM. Without it, the CLI exits after the ack alone and prints nothing useful. |
| `--timeout=60s` (or larger) | Global ceiling on the whole stream. Pick a value appropriate to the work — `5m` for code-generating agents, `60s` for echo-style demos. |

`--wait-for-empty` is a more efficient alternative — instead of `--replies=0`, use:

```bash
nats req agents.prompt.pi.alice.my-session "list files" \
  --wait-for-empty --reply-timeout=30s --timeout=60s
```

The two flags terminate differently:

- `--wait-for-empty` recognizes the protocol's empty-body terminator and exits **immediately** when it arrives — no dead wait.
- `--replies=0` is the generic "collect multiple replies" mode; it doesn't know about the terminator and keeps waiting until `--reply-timeout` fires (so you eat the full 30 s gap after the last chunk before the CLI exits).

Both produce the same chunks; `--wait-for-empty` is the cleaner choice for protocol-aware use. Per-agent READMEs in this repo lean either way for historical reasons.

### JSON envelope (attachments)

Plain text is shorthand for `{"prompt": "<text>"}`. For attachments, send the full envelope:

```bash
nats req agents.prompt.pi.alice.my-session '{
  "prompt": "describe this image",
  "attachments": [{"filename": "pic.png", "content": "<base64>"}]
}' --replies=0 --reply-timeout=30s --timeout=120s
```

Attachment `content` must be **standard** base64 (padded, `+` / `/` alphabet) — not URL-safe. `Buffer.from(bytes).toString("base64")` in Node or `base64.b64encode` in Python both produce the right form.

### What you'll see on the wire

Every prompt produces a stream of one-line JSON chunks:

```
{"type":"status","data":"ack"}              ← mandatory §6.4 leading chunk, sent instantly
{"type":"response","data":"Sure, here..."}  ← model output (one or more)
{"type":"response","data":" are the files"} ← ...
{"type":"status","data":"ack"}              ← optional periodic keep-alive (same "ack" token as the leading chunk)
<empty body, no headers>                    ← terminator
```

Errors use a `Nats-Service-Error-Code` header: `400` for client mistakes (bad envelope, oversized attachment), `500` for agent-side failures.

## Status — one-shot snapshot

`agents.status.{agent}.{owner}.{session}` is a request/response endpoint that returns the same payload shape as a heartbeat, freshly built per request. Use it when you don't want to wait for the next heartbeat tick:

```bash
nats req agents.status.pi.alice.my-session "" --timeout=2s
```

Note the lack of `--reply-timeout`/`--replies=0` — `status` is a single-reply RPC, not a stream.

## Control plane — headless agents

`pi-headless` and `cc-headless` add verb-first control endpoints on top of the protocol. These are single-reply RPCs, so they don't need the stream flags:

```bash
# Spawn a fresh session
nats req agents.spawn.pi-headless.$USER.control \
  '{"cwd":"/tmp/sandbox","model":"anthropic/claude-sonnet-4-5","max_lifetime_s":900}' \
  --timeout=10s
# → { "session_id": "sess-...", "subject": "agents.prompt.pi-headless...", ... }

# List active sessions
nats req agents.list.pi-headless.$USER.control '' --timeout=5s

# Stop a session
nats req agents.stop.pi-headless.$USER.control \
  '{"session_id":"sess-a1b2c3d4"}' --timeout=5s
```

The `cc-headless` controller has the same three verbs. See `examples/pi-headless/README.md` and `examples/claude-code-headless/README.md` for the full payload shapes.

## Gotchas

| Symptom | Fix |
| --- | --- |
| `nats req` prints only `{"type":"status","data":"ack"}` and exits | Missing `--reply-timeout=30s` (the default 300 ms races the LLM's first real response). |
| `nats req` prints chunks and then sits idle for 30 s before exiting | You used `--replies=0` but not `--wait-for-empty`. `--replies=0` doesn't recognize the protocol terminator and waits the full `--reply-timeout` after the last chunk. Switch to `--wait-for-empty` for an immediate exit at the terminator. |
| `nats req` returns nothing at all | Either the subject is wrong, the agent isn't registered, or you're in the wrong account. Run discovery first (`$SRV.INFO.agents`) to confirm the agent is visible from where you're calling. |
| `400 attachment[N] has invalid base64 content` | The caller emitted URL-safe base64 (`-_`) or unpadded output. Use standard padded base64. |
| `400 attachment[N] has unsafe filename` | Send the basename only (`"pic.png"`), not a path (`"./images/pic.png"`). |
| `400 prompt missing or empty` | The envelope is malformed — either the top-level JSON is wrong shape, or `prompt` is missing. Plain-text payloads work too as a §5.1 shorthand. |

## What `nats req` *can't* do

- **Mid-stream queries** (§7). The agent can ask the caller a question mid-stream by emitting `{"type":"query","data":{...}}`; the caller must reply on a stream-specific subject. The `nats` CLI doesn't have a way to interleave a reply into the same `nats req` invocation. Use the SDK (`@synadia-ai/agents` / `synadia-ai-agents`) for query-bearing flows.
- **Reusing connections across many prompts**. Every `nats req` invocation is a fresh connection. For high-volume probing, use a small script with one of the SDKs.

## See also

- The protocol spec: <https://github.com/synadia-ai/synadia-agent-sdk-docs>
- Per-agent READMEs with agent-specific subject layouts: `agents/{claude-code,codex,deerflow,flue,hermes,open-agent,opencode,openclaw,pi}/README.md`
- Headless examples with control-plane endpoints: `examples/{pi,claude-code}-headless/README.md`
- SDK-driven equivalents: `client-sdk/typescript/examples/`, `client-sdk/python/examples/`
