# hermes-agent

> **Work in progress.** The NATS gateway lives on a fork
> (`nats-gateway` branch of
> [`renerocksai/hermes-agent`](https://github.com/renerocksai/hermes-agent));
> upstream PR to [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent)
> is planned but not yet filed (needs a catch-up rebase first), so the
> install below clones the fork directly.

NATS gateway for [Hermes Agent](https://github.com/NousResearch/hermes-agent), implementing the **[NATS Agent Protocol](https://github.com/synadia-ai/nats-agent-sdk-docs) v0.2**.

Hermes is a self-improving coding agent with a CLI, a TUI, and a messaging gateway sharing one agent core. With the NATS gateway enabled, each running Hermes instance becomes a discoverable, addressable, streaming agent on NATS. Callers using any SDK that speaks the protocol — e.g. [`natsagent`](../../client-sdk/python) (Python) or [`@synadia/agents`](../../client-sdk/typescript) (TypeScript) — can enumerate running Hermes instances, prompt them (with attachments), and stream responses back.

Sibling implementations sharing the same wire protocol: [`pi`](../pi) (PI), [`openclaw`](../openclaw) (OpenClaw), [`claude-code`](../claude-code) (Claude Code).

## How it works

When `hermes gateway run` starts with `platforms.nats.enabled = true`:

1. Connects to NATS using a configured context (or `demo.nats.io` by default via `$NATS_URL`).
2. Registers a NATS micro service named `agents` with spec metadata (`agent`, `owner`, `session`, `protocol_version`).
3. Adds a `prompt` endpoint at `agents.hermes.<owner>.<name>` advertising `max_payload: 1MB` and `attachments_ok: true`.
4. Publishes heartbeats on `agents.hermes.<owner>.<name>.heartbeat` every 30 s.
5. On each inbound prompt: decodes any attached files to the gateway's attachment staging area, routes images through Hermes's `vision_analyze` tool so the agent actually sees them, emits a `status: ack` chunk, runs the full Hermes agent loop (tools, memory, skills, approvals) to completion, and streams model output back as typed `{type:"response","data":…}` chunks, terminating with the spec-mandated empty-body no-headers terminator.
6. Malformed envelopes, oversized payloads, invalid base64, and unsafe filenames are rejected at the wire with `Nats-Service-Error-Code: 400`. Internal failures return `500`.
7. Mid-stream approval prompts (dangerous tool calls) are surfaced as spec §7 `query` chunks when a caller drives a prompt; see `examples/04-query-reply.py` in the SDK.

Unlike pi/openclaw/claude-code, **one Hermes gateway instance registers one identity**; multiple conversations over that single identity are distinguished by the envelope's optional `session` field (§5.1). So `agents.hermes.rene.local` handles everyone talking to your laptop; callers set `session="bob"` / `session="alice"` to keep histories separate.

## Install

The install has three parts: (1) clone the fork and bootstrap Hermes, (2) install the Python SDK editable from this monorepo (not yet on PyPI), (3) configure the gateway. Sibling agents ship as npm plugins; Hermes is a full application, so the first two steps look different.

### Directory layout

You're reading this README inside a clone of `synadia-agents`. The commands below clone `hermes-agent` as a **sibling** of that clone, so the `natsagent` SDK (which lives inside this monorepo) is reachable via the relative path `../synadia-agents/client-sdk/python` from the hermes-agent root:

```
parent/
├── synadia-agents/                    ← you're reading this inside here
│   ├── agents/hermes/README.md
│   └── client-sdk/python/             ← the natsagent SDK
└── hermes-agent/                      ← you'll clone the fork here
    └── venv/                          ← created by ./setup-hermes.sh
```

If you prefer a different layout, substitute an absolute path (e.g. `/home/you/projects/synadia-agents/client-sdk/python`) for every occurrence of `../synadia-agents` in the commands below. Nothing else needs to change.

### 1. Clone and bootstrap Hermes

Run this from the **root of your `synadia-agents` clone** (`cd` there first if you opened this file deeper in the tree — e.g. from `agents/hermes/` do `cd ../..`):

```bash
# Clone hermes-agent as a sibling of synadia-agents.
cd ..
git clone -b nats-gateway https://github.com/renerocksai/hermes-agent.git
cd hermes-agent

# setup-hermes.sh installs uv, creates venv, installs hermes-agent[all,dev],
# symlinks ~/.local/bin/hermes, and prompts for an LLM provider key.
./setup-hermes.sh
```

After this you can run `hermes --help` from anywhere. User state lives in `~/.hermes/`.

> You'll see a yellow warning during `setup-hermes.sh`:
> `⚠ Lockfile install failed (may be outdated), falling back to pip install...`
> That's **expected** until `natsagent` publishes to PyPI — the `[nats]` extra pins an unpublished package, which breaks the primary `uv sync --all-extras --locked` path, so the script falls back to `uv pip install -e ".[all]"` (which excludes `[nats]` by design). Step 2 below installs the SDK manually.

### 2. Install the `natsagent` Python SDK

The SDK is in this monorepo at [`../../client-sdk/python`](../../client-sdk/python). It's **not yet on PyPI** (publishing will follow the upstream Hermes PR merge), so install it editable from the sibling `synadia-agents` checkout — this is how you point hermes at the SDK:

```bash
# From the hermes-agent clone (the sibling of synadia-agents), venv active:
source venv/bin/activate
uv pip install --python venv/bin/python -e ../synadia-agents/client-sdk/python
```

(If you didn't clone synadia-agents as a sibling, replace `../synadia-agents/client-sdk/python` with the absolute path to this monorepo's `client-sdk/python` directory.)

Verify: `venv/bin/python -c "import natsagent; print(natsagent.__file__)"` should print a path inside this monorepo.

Without this, Hermes logs `NATS: natsagent SDK not installed` at startup and skips registering the NATS adapter.

### 3. Configure the gateway

Edit `~/.hermes/config.yaml` and add the `platforms.nats` block. The `owner` and `name` fields determine your subject — `agents.hermes.<owner>.<name>`.

Minimal `demo.nats.io` setup (no credentials, ephemeral public server — perfect for a first smoke test, not for anything sensitive):

```yaml
platforms:
  nats:
    enabled: true
    extra:
      servers: ["nats://demo.nats.io"]
      owner: yourname             # e.g. your github handle
      name: demo                  # instance label (dev, prod, laptop, …)
      attachments_ok: true
```

Start the gateway and confirm registration:

```bash
hermes gateway run
# expect: "NATS: registered as agents.hermes.yourname.demo (heartbeat=30s, max_payload=1MB)"
```

## Configure

### Via a NATS CLI context (recommended for anything beyond `demo.nats.io`)

If you already manage NATS credentials via `nats context`, reference the context by name. This keeps URLs and creds out of `config.yaml` and lets you flip between local, Synadia Cloud, and production by changing one field.

Create a context (example: a local `nats-server` on 4222 with no auth):

```bash
nats context add hermes-local \
  --server nats://127.0.0.1:4222 \
  --description "Hermes local dev"
nats context select hermes-local
nats --context hermes-local rtt       # sanity check the connection
```

This writes `~/.config/nats/context/hermes-local.json`:

```json
{
  "description": "Hermes local dev",
  "url": "nats://127.0.0.1:4222"
}
```

Reference it from `~/.hermes/config.yaml`:

```yaml
platforms:
  nats:
    enabled: true
    extra:
      context: hermes-local       # reads ~/.config/nats/context/hermes-local.json
      owner: rene
      name: local
      attachments_ok: true
      # Optional tuning (defaults shown):
      # agent: hermes                # 2nd subject token
      # max_payload: "1MB"           # pattern \d+(B|KB|MB|GB)
      # heartbeat_interval_s: 30
      # session_default: "default"   # fallback session label
```

With the example above, Hermes registers as `agents.hermes.rene.local` and publishes heartbeats on `agents.hermes.rene.local.heartbeat`.

For Synadia Cloud or a secured self-hosted server, add the relevant fields when creating the context (`--creds`, `--nkey`, `--user`/`--password`, `--tls*`) — see `nats context add --help`.

### Config fields

All fields live under `platforms.nats.extra` in `~/.hermes/config.yaml`.

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `context` | one of `context`/`servers` | — | NATS CLI context name in `~/.config/nats/context/` |
| `servers` | one of `context`/`servers` | — | List of NATS URLs, e.g. `["nats://demo.nats.io"]` |
| `owner` | yes | — | 3rd subject token — your operator / account namespace |
| `name` | yes | — | 4th subject token — instance label |
| `agent` | no | `hermes` | 2nd subject token; rarely changed |
| `attachments_ok` | no | `true` | Accept inline base64 attachments |
| `max_payload` | no | `"1MB"` | Per-request limit; must match `\d+(B\|KB\|MB\|GB)` |
| `heartbeat_interval_s` | no | `30` | Liveness beacon interval |
| `session_default` | no | `"default"` | Fallback session when envelope omits the field |

### Environment variables (optional)

Any `NATS_*` / `HERMES_NATS_*` env var flips `platforms.nats.enabled=true` automatically, so you can skip the YAML edit for a quick smoke test:

| Env var | Overrides |
|---------|-----------|
| `NATS_URL` | `extra.servers` (single URL) |
| `NATS_CONTEXT` | `extra.context` |
| `HERMES_NATS_OWNER` | `extra.owner` |
| `HERMES_NATS_NAME` | `extra.name` |
| `HERMES_NATS_AGENT` | `extra.agent` |

## Verify

```bash
# Protocol-level discovery — Hermes should appear in the list
nats --context hermes-local req '$SRV.INFO.agents' '' --replies=0 --timeout=2s

# Micro service listing
nats --context hermes-local micro list
nats --context hermes-local micro info agents

# Watch heartbeats — one frame every heartbeat_interval_s seconds
nats --context hermes-local sub 'agents.hermes.*.*.heartbeat'
```

Omit `--context hermes-local` if you're using the default/`demo.nats.io` path.

## Talking to a running Hermes agent

### Plain-text prompt

With the Python SDK's shipped examples (from this monorepo):

```bash
# From the synadia-agents repo root:
cd client-sdk/python
uv run python examples/02-prompt-text.py \
    --context hermes-local \
    "what is 2+2? answer in one short sentence."
```

You'll see the response stream chunk-by-chunk, terminated by an empty frame.

Or with the `nats` CLI directly (plain-text shorthand per spec §5.1):

```bash
nats --context hermes-local req agents.hermes.rene.local \
    "what is 2+2? answer in one short sentence." \
    --wait-for-empty --timeout 120s
```

### With an attachment — "describe this image"

Hermes routes images through its `vision_analyze` tool, so the model actually sees the picture. The Hermes repo ships a small banner (`website/static/img/hermes-agent-banner.png`, ~12 KB — well under the 1 MB payload limit):

```bash
# from synadia-agents/client-sdk/python; the ../../../hermes-agent/... path
# assumes the sibling layout from the Directory-layout section above.
uv run python examples/03-prompt-attachment.py \
    --context hermes-local \
    --prompt "describe this image in one sentence" \
    ../../../hermes-agent/website/static/img/hermes-agent-banner.png
```

Expected: a short description of the banner — what it depicts, colors, text — streamed back as `response` chunks.

### With the Python SDK (programmatic)

```python
import asyncio
import natsagent

async def main():
    nc = await natsagent.connect(context="hermes-local")
    client = natsagent.Client(nc)
    agents = await client.discover(timeout=2.0)
    hermes = next(a for a in agents if a.agent == "hermes")

    remote = client.bind(hermes)
    async for msg in remote.prompt("list three interesting CLI tools", session="alice"):
        if isinstance(msg, natsagent.ResponseChunk):
            print(msg.text, end="", flush=True)

    await client.stop()
    await nc.close()

asyncio.run(main())
```

`session="alice"` keeps this conversation isolated from other callers hitting the same subject — see the `natsagent` SDK README for the full API.

### Other example scripts

| Script | Demonstrates |
|--------|--------------|
| `examples/01-discover.py` | Enumerate every agent registered on the server via `$SRV` |
| `examples/02-prompt-text.py` | Plain-text prompt + streamed response |
| `examples/03-prompt-attachment.py` | Attachment upload (the demo above) |
| `examples/04-query-reply.py` | Handle a mid-stream approval `query` chunk (Hermes asks before running dangerous tools) |
| `examples/05-liveness.py` | Watch heartbeats, detect the agent going offline |
| `examples/06-chat.py` | Multi-turn chat over a single `session` label |

All honor `--context`, `--url`, `$NATS_URL`, or `nats context select` (in that order).

## Subject hierarchy

```
agents.hermes.<owner>.<name>             # prompt endpoint (spec §2, §5)
agents.hermes.<owner>.<name>.heartbeat   # liveness beacon (spec §8)
```

- `hermes` is both `metadata.agent` and its subject abbreviation (Appendix C).
- `owner`: from `platforms.nats.extra.owner` — operator/account namespace.
- `name`: from `platforms.nats.extra.name` — instance label. A single Hermes gateway registers **one** identity; multiple conversations share it and are distinguished by the envelope's `session` field.

## Sessions (Hermes-specific)

Pi, OpenClaw, and Claude Code each register one NATS identity **per conversation**. Hermes multiplexes: one gateway, one identity, many conversations via the `session` field.

- In the Python SDK: `remote.prompt(text, session="alice")`.
- In the examples: `--session alice`.
- On the wire: JSON envelope with `{"prompt": "...", "session": "alice"}`.
- Omitted: falls back to `session_default` (configurable, default `"default"`).

Sessions are isolated — one caller's history doesn't leak to another. Under the hood, `session=alice` produces a gateway session key of `agent:main:nats:dm:alice`.

## Tenant isolation

The spec reserves the four-token subject structure; there is no additional namespace slot. For multi-tenant isolation, use NATS accounts and subject permissions (spec §10.1). Within an account, Hermes's scoped lock prevents two gateway instances from registering the same `(agent, owner, name)` triple on one machine — the second fails fast with an actionable error.

Cross-machine collisions are deliberately allowed — the protocol permits multiple instances per identity (§3.3) for high availability.

## Wire protocol (summary)

Full spec: <https://github.com/synadia-ai/nats-agent-sdk-docs>. Quick reference:

- **Request**: plain UTF-8 text OR JSON `{"prompt":"…","session":"…","attachments":[{"filename":"…","content":"<base64>"},…]}`. Attachment `content` must be RFC 4648 §4 base64 (standard alphabet, padded, no URL-safe variant, no whitespace).
- **Response**: typed chunks on the reply subject — `{"type":"status","data":"ack"}` (accepted / keep-alive), `{"type":"response","data":"<text>"}` (content), `{"type":"query","data":{…}}` (mid-stream approval).
- **Terminator**: empty body **and no headers** (§6.5).
- **Errors**: `Nats-Service-Error-Code` header with `400`/`500`, followed by the terminator.

## Limitations

Current deferrals (candidates for future phases, not bugs):

- **No cron-driven proactive delivery over NATS.** NATS has no persistent reply address a cron job could target.
- **No `send_message` tool routing to NATS.** Same reason.
- **No chunked `attachments` endpoint** (spec §5.5). Inline base64 only for now.
- **No JetStream at-least-once delivery.**
- **No E2E encryption** — delegated to NATS server TLS.
- **`/stop` doesn't interrupt a running NATS turn.** The adapter-owned agent pattern bypasses the gateway's `_active_sessions` tracking; callers drop their subscription to abandon a run.

## Troubleshooting

- **`NATS: natsagent SDK not installed` at gateway startup.** Install step 2 was skipped. Re-run `uv pip install --python venv/bin/python -e ../synadia-agents/client-sdk/python` from the hermes-agent clone with the venv active.
- **`$SRV.INFO.agents` returns nothing / Hermes not discovered.** Gateway didn't register. Check `platforms.nats.enabled: true`, that the NATS URL/context resolves, and look for `NATS: registered as …` in the gateway log. If another Hermes instance already holds the same `(agent, owner, name)`, the log shows `already registered`.
- **`nats req` returns nothing or hangs.** Pass `--wait-for-empty`; the protocol signals end-of-stream with an empty-body message, not a single response.
- **Caller hangs after the first chunk; `is_online()` returns False.** Gateway probably crashed or lost NATS connectivity. The protocol marks an agent offline after ~3 missed heartbeats (~90 s at the 30 s default). Check the gateway log.
- **Dangerous command hangs for 5 minutes then fails.** The caller didn't handle the `query` chunk. Drain `query` in your SDK loop (see `examples/04-query-reply.py`) — after `gateway_timeout` (default 300 s) the command is auto-denied.
- **`400 attachment[N] has invalid base64 content`.** The caller emitted URL-safe base64 or unpadded output. Switch to RFC 4648 §4 (standard alphabet, padded).
- **`ValueError: could not parse max_payload '…'`.** `max_payload` must match `\d+(B|KB|MB|GB)` — e.g. `"1MB"`, `"512KB"`, `"104857600B"`.

## Further reading

- **Hermes user guide for the NATS channel:** [`website/docs/user-guide/messaging/nats.md`](https://github.com/renerocksai/hermes-agent/blob/nats-gateway/website/docs/user-guide/messaging/nats.md) in the fork — deep dive on configuration, subject layout, sessions, attachments, profiles, full troubleshooting table.
- **Architecture & design:** [`docs/nats-gateway-design.md`](https://github.com/renerocksai/hermes-agent/blob/nats-gateway/docs/nats-gateway-design.md) — protocol↔adapter mapping, streaming model, approval hook, failure modes, and §17 retrospective lessons.
- **Adapter source:** [`gateway/platforms/nats.py`](https://github.com/renerocksai/hermes-agent/blob/nats-gateway/gateway/platforms/nats.py).
- **Protocol spec:** <https://github.com/synadia-ai/nats-agent-sdk-docs>
