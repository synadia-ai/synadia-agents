# Hermes NATS Gateway

> **This is a mirrored copy.** The Hermes NATS gateway lives in its own
> repository — [`synadia-ai/hermes-nats-gateway`](https://github.com/synadia-ai/hermes-nats-gateway)
> — which is the canonical, authoritative source. It is a separate repo because
> Hermes installs plugins by git-cloning a repository (`hermes plugins install
> owner/repo`), so each plugin must be its own repo.

Expose [Hermes Agent](https://github.com/NousResearch/hermes-agent) on
[NATS](https://nats.io/) using the **Synadia Agent Protocol for NATS v0.3** —
a request/reply transport with streamed responses.

## What this is

`hermes-nats-gateway` is an **out-of-tree platform plugin** for Hermes Agent. You
install it once with the Hermes plugin CLI, and the NATS transport becomes
available to every Hermes session alongside the built-in chat platforms
(Telegram / Discord / Slack). Nothing in upstream Hermes changes, and it
requires Hermes **v0.14.0+**.

Instead of a chat UI, the gateway appears on NATS as a micro-service at
`agents.prompt.<agent>.<owner>.<session_name>` — with heartbeats, an
`agents.status` endpoint, discovery, and mid-stream dangerous-command approval.
People usually reach it through an application or UI that talks to NATS under
the hood; you can also use it to connect Hermes to other services, plug the
agent into an event-driven pipeline, or have one agent call another over NATS.

Authorization is handled by the NATS server (accounts / NKey / JWT / TLS) — the
same model Hermes already uses for Webhooks and Home Assistant. The protocol
spec lives at
[`synadia-ai/synadia-agent-sdk-docs`](https://github.com/synadia-ai/synadia-agent-sdk-docs/blob/main/core-protocol.md).

## Quick install

> **Read this first.** The Hermes `install.sh` runs its own setup wizard *before*
> this plugin is installed, so NATS won't appear in that first wizard. Pass
> `--skip-setup` to defer it, install the plugin, then run `hermes setup`. (If you
> already ran the installer without `--skip-setup`, that's fine — just run
> `hermes setup` again after step 2 below; NATS will be in the list.)

```bash
# 1. Install Hermes, deferring the first-run wizard.
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-setup

# 2. Install this plugin (clones the repo into ~/.hermes/plugins/).
hermes plugins install synadia-ai/hermes-nats-gateway

# 3. Install the NATS runtime SDKs into the Hermes venv (NOT automatic — see below).
bash ~/.hermes/plugins/nats-platform/scripts/install-sdks.sh

# 4. Configure NATS via the wizard (pick "NATS" from the platform list).
hermes setup

# 5. Run the gateway.
hermes gateway run
```

> **Step 3 is required — plugin install does not pull dependencies.** Hermes
> plugins are distributed as git clones, so `hermes plugins install` does *not*
> install this plugin's Python dependencies, and the Hermes venv is uv-managed
> (no `pip`). The bundled `scripts/install-sdks.sh` finds the venv the `hermes`
> command runs from — for both the `install.sh` and pip/editable layouts — and
> installs the SDKs into it with `uv`; you don't need to know the venv path. Skip
> this and the gateway logs `NATS: synadia-ai-agents / synadia-ai-agent-service
> not installed` and silently won't register. The same instruction is shown
> automatically by `after-install.md` right after step 2. To target a
> non-standard install, pass the venv python: `… install-sdks.sh /path/to/venv/bin/python`.

### Updating

To update the plugin to the latest version, run `hermes plugins update nats-platform`.

## Prerequisites

- **Hermes Agent v0.14.0 or later.** The plugin relies on the `send_exec_approval`
  adapter hook, which older versions don't expose. See [Limitations](#limitations).
- **A running NATS server** — local or remote. For first-time testing you can use
  the public demo server (`nats://demo.nats.io`); for local development run your
  own `nats-server`. On production, use a server with accounts / NKey / JWT / TLS.
- **An LLM provider key** in `~/.hermes/.env` (e.g. `OPENROUTER_API_KEY`,
  `ANTHROPIC_API_KEY`). The `/help` and `/status` commands work without one, but
  actual prompts need a model.

- **The NATS runtime SDKs** (`synadia-ai-agents`, `synadia-ai-agent-service`,
  `nkeys`) installed into the **Hermes venv**. `hermes plugins install` does
  *not* install them — run the one-time `scripts/install-sdks.sh` (see
  [Quick install](#quick-install) step 3). Without them the gateway logs
  `NATS: synadia-ai-agents / synadia-ai-agent-service not installed` and skips
  registering the adapter.

## Configure

The gateway reads three identity tokens plus one transport setting. The subject
it registers is `agents.prompt.<agent>.<owner>.<session_name>`:

| Setting | Env var | Default | Meaning |
|---|---|---|---|
| Agent | `HERMES_NATS_AGENT` | `hermes` | 3rd subject token (service family name) |
| Owner | `HERMES_NATS_OWNER` | *(required)* | 4th subject token (e.g. your handle) |
| Session | `HERMES_NATS_SESSION_NAME` | *(required)* | 5th subject token; one service = one session |
| Transport | `NATS_URL` **or** `NATS_CONTEXT` | *(one required)* | server URL, or a named NATS CLI context |

`NATS_URL` and `NATS_CONTEXT` are mutually exclusive — set exactly one.

### Recommended: the interactive wizard

```bash
hermes setup gateway
```

Pick **NATS** from the platform checklist. The wizard offers a 3-way transport
menu — public demo server / custom URL / an existing NATS CLI context
auto-discovered from `~/.config/nats/context/` — prompts for owner and
session_name, runs a cross-profile collision check on the
`(agent, owner, session_name)` triple, and writes the result to `~/.hermes/.env`:

```bash
NATS_URL=nats://demo.nats.io        # OR: NATS_CONTEXT=local-nats
HERMES_NATS_OWNER=yourname
HERMES_NATS_SESSION_NAME=default
```

### Manual: edit `.env` directly

If you'd rather skip the wizard, set the same vars by hand in `~/.hermes/.env`:

```bash
NATS_URL=nats://127.0.0.1:4222
HERMES_NATS_OWNER=yourname
HERMES_NATS_SESSION_NAME=default
```

### Advanced: structured overrides via `config.yaml`

For knobs the wizard doesn't ask about — multi-URL `servers` lists, heartbeat
interval, payload limits, ack-keepalive timing — hand-edit `~/.hermes/config.yaml`:

```yaml
platforms:
  nats:
    enabled: true
    extra:
      # Multi-URL is config.yaml-only (NATS_URL is single-URL).
      servers: ["nats://primary:4222", "nats://failover:4222"]

      # Behavior tuning (all optional, defaults shown).
      heartbeat_interval_s: 30
      max_payload: "1MB"
      attachments_ok: true
      ack_keepalive_interval_s: 20
```

If you manage NATS credentials via `nats context`, set `NATS_CONTEXT` (env) or
`extra.context` (yaml) instead of `NATS_URL` / `extra.servers`.

> **Set identity and transport via `.env` or the wizard, not YAML alone.** Because
> of how upstream Hermes loads its config, values placed *only* under
> `gateway.platforms.nats.extra` in `config.yaml` can be dropped before the gateway
> sees them — while the same values in `.env` (or written by the wizard) always
> take effect. This is upstream-Hermes behavior, not a plugin bug. Until it's fixed
> upstream, keep identity and transport (owner, session, URL/context) in `.env` or
> the wizard, and treat the `extra` block as best-effort tuning only.

## Multiple sessions (profiles)

Protocol v0.3 collapsed `name` and `session` into a single `session_name` token:
**one `AgentService` serves exactly one session.** To run several sessions on one
machine, use Hermes profiles — one profile per session. Each profile gets its own
`HERMES_HOME`, its own `.env`, and its own `AgentService`:

```bash
hermes -p alice profile create
hermes -p alice setup gateway     # pick NATS, set session_name=alice

hermes -p bob profile create
hermes -p bob setup gateway       # pick NATS, set session_name=bob

hermes -p alice gateway run &
hermes -p bob   gateway run &
```

Two profiles claiming the same `(agent, owner, session_name)` triple on one host
is a footgun (both would receive load-balanced prompts), so the gateway acquires
a scoped lock on the identity before connecting and the second profile fails fast
with an actionable error. Cross-*machine* duplicates are allowed — the protocol
permits multiple instances per identity for high availability.

## Run + verify

```bash
hermes gateway run
```

On success the log shows the connection and the registered subject:

```
NATS: connected to nats://127.0.0.1:4222
NATS: subscribed at agents.prompt.hermes.yourname.default (heartbeat=30s, max_payload=1MB)
```

Verify the micro-service is live with the `nats` CLI:

```bash
# One "agents" service with two endpoints (prompt, status):
nats micro list

# A heartbeat every heartbeat_interval_s seconds:
nats sub 'agents.hb.>'

# On-demand liveness — replies with the current heartbeat payload:
nats req agents.status.hermes.yourname.default ''
```

A reply carrying `metadata.protocol_version: "0.3"` confirms the agent is live.

### Send a prompt

The simplest caller is a few lines on the `synadia-ai-agents` client SDK
(`pip install synadia-ai-agents`):

```python
# prompt.py
import asyncio, sys
import nats
from synadia_ai.agents import Agents, DiscoverFilter, ResponseChunk

async def main(text: str) -> None:
    nc = await nats.connect("nats://127.0.0.1:4222")
    agents = Agents(nc=nc)
    try:
        found = await agents.discover(filter=DiscoverFilter(session_name="default"))
        if not found:
            sys.exit("no agent found — is the gateway running?")
        async for msg in found[0].prompt(text):
            if isinstance(msg, ResponseChunk):
                sys.stdout.write(msg.text); sys.stdout.flush()
    finally:
        await agents.close()
        await nc.close()

asyncio.run(main("what is 2+2? answer in one short sentence"))
```

The response streams chunk-by-chunk, terminated by an empty-body frame. All of
Hermes's gateway-eligible slash commands work over NATS as plain-text prompts too
(`/help`, `/status`, `/new`, `/model`, `/usage`, …).

For runnable callers covering discovery, attachments, mid-stream approval, and
liveness, clone the SDK monorepo and run the examples:

```bash
git clone https://github.com/synadia-ai/synadia-agents.git
cd synadia-agents/client-sdk/python
uv run python examples/02-prompt-text.py \
    --url nats://127.0.0.1:4222 --session default \
    "what is 2+2? answer in one short sentence"
```

| Example | Demonstrates |
|---|---|
| `examples/01-discover.py` | List all live agents via `$SRV` |
| `examples/02-prompt-text.py` | Send a text prompt, iterate the streamed response |
| `examples/03-prompt-attachment.py` | Send an image/document as a base64 attachment |
| `examples/04-query-reply.py` | Handle a mid-stream approval query |
| `examples/05-liveness.py` | Monitor heartbeats / `agents.status` for offline detection |

## Dangerous-command approval flow

When the agent wants to run a command Hermes considers dangerous (e.g. `rm -rf`),
the gateway does **not** silently drop or auto-deny it. Instead it sends an
approval **query** in-band on the caller's reply inbox — a short plain-text prompt
describing the command — and waits for the caller's answer before resuming the
stream. This is the same consent gate the chat platforms use, carried over the
NATS reply subject via the `send_exec_approval` adapter hook. There is **no**
`/approve` slash command involved; the round-trip is the query frame and your
reply.

Reply with one of four tokens (case-insensitive; common synonyms accepted):

| Reply | Synonyms accepted | Effect |
|---|---|---|
| `once` | `o`, `yes`, `y`, `ok`, `okay`, `approve`, `allow`, `1` | Approve this one command |
| `session` | `s` | Approve for the rest of this session |
| `always` | `a`, `permanent`, `perm`, `persist` | Approve and remember permanently |
| `deny` | `d`, `no`, `n`, `nope`, `reject`, `cancel`, `stop`, `block`, `0` | Reject the command |

Anything unrecognized, empty, or no answer at all falls through to **`deny`** —
fail-safe matches Hermes's "no answer ⇒ blocked" policy. For a worked example of
the caller side, see `04-query-reply.py` in the
[client SDK repo](https://github.com/synadia-ai/synadia-agents)
(`client-sdk/python/examples/`).

## Limitations

- **Parallel-subagent approvals route FIFO, oldest-wins.** If a single session
  fans out into multiple subagents that each raise a dangerous-command approval at
  the same time, the replies are matched to the *oldest* outstanding query first,
  so concurrent approvals can be swapped. The default single-subagent flow is
  unaffected. Don't rely on per-command targeting when running parallel subagents.
- **Hermes v0.14.0 is the floor.** The plugin dispatches approvals through the
  `send_exec_approval` adapter hook, which only exists on Hermes v0.14.0+. On older
  versions the gateway loads but dangerous-command approval won't function.
- **NATS CLI context carries only a subset of auth.** When you connect via
  `NATS_CONTEXT`, only `url`, `token`, `user`/`password`, and the `creds` file path
  are carried into the connection. Inline `nkey`, inline `user_jwt` / `user_seed`,
  and the TLS triple (cert / key / CA) in a context are **silently dropped**. For
  those auth modes, point the context (or `NATS_URL`) at a **`.creds` file**
  instead of inline credentials.

This adapter also does not implement (by design, MVP scope): cron-based proactive
delivery, `send_message` tool routing to NATS, chunked uploads >1 MB (inline
base64 only), JetStream at-least-once delivery, end-to-end encryption (delegated to
NATS server TLS), `/stop` interrupting a running NATS agent, and multi-session
multiplexing within one process (use profiles).

## Troubleshooting

**`NATS: synadia-ai-agents / synadia-ai-agent-service not installed` at startup**
The runtime SDKs aren't in the Hermes venv — `hermes plugins install` doesn't
install them. Run `bash ~/.hermes/plugins/nats-platform/scripts/install-sdks.sh`
(Quick install step 3). Installing into a global Python won't help — it must be
the venv the `hermes` command runs from, which the script detects for you.

**Gateway starts but `nats micro list` / discovery shows nothing**
Check `enabled: true` and that exactly one of `NATS_URL` / `NATS_CONTEXT` (or
`extra.servers` / `extra.context`) is set. The gateway logs connected platforms at
startup — if NATS isn't listed, the config didn't take. If you only set values
under `config.yaml`'s `extra`, move identity/transport to `.env` (see the
[YAML caveat](#advanced-structured-overrides-via-configyaml)).

**Second profile fails with an identity-collision error**
Two profiles are claiming the same `(agent, owner, session_name)` triple on one
host. Give each profile a distinct `HERMES_NATS_SESSION_NAME`.

**`ValueError: could not parse max_payload 'foo'`**
`max_payload` must match `^\d+(B|KB|MB|GB)$` — e.g. `"1MB"`, `"512KB"`.

**Caller hangs after the first chunk; `is_online()` shows False**
The gateway likely lost its NATS connection. The protocol marks an agent offline
after three missed heartbeats (~90 s at the 30 s default). Check the gateway log
or query `agents.status.hermes.<owner>.<session_name>` directly.

**A dangerous command hangs for ~5 minutes then is denied**
The caller isn't handling the approval `query` frame, so the gateway's
`gateway_timeout` (default 300 s) elapses and the command is denied. The caller
must read query frames as they arrive and reply to them — see `04-query-reply.py`
in the [client SDK repo](https://github.com/synadia-ai/synadia-agents)
(`client-sdk/python/examples/`).

## License

Apache-2.0.
