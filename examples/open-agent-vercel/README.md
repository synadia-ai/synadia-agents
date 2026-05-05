# `open-agent-vercel` example

Runs the inbound NATS bridge from
[`@synadia-ai/open-agent`](../../agents/open-agent/) against
[`@vercel/sandbox`](https://www.npmjs.com/package/@vercel/sandbox)
instead of a `LocalSandbox`. Same `runBridge` function, same wire
behaviour — only the sandbox factory changes.

## Why this exists

To prove that `@synadia-ai/open-agent`'s sandbox seam is genuinely
interchangeable. If the bridge can run against both a host filesystem
and a remote Vercel VM with no code change, callers can pick the
sandbox shape that fits their threat model.

## Prerequisites

- A reachable NATS endpoint — local `nats-server`, a `NATS_URL`, or a
  saved `nats` CLI context (see **Connecting to NATS** below).
- `VERCEL_TOKEN` — a Vercel API token with sandbox-create scope.
- A model API key (see **Models** below).
- `bun install` resolves `@vercel/sandbox` from npm; the rest of the
  graph is wired by `file:` links to the sibling packages.

## Connecting to NATS

Same precedence as the `agents/open-agent/` CLI:

1. `NATS_URL` env var, if set — wins over everything.
2. `--nats-context <name>` flag — resolves a saved `nats` CLI context.
   Use `current` to pick whichever context `nats context select` last
   chose.
3. Otherwise: `nats://127.0.0.1:4222`.

```bash
# Saved context (e.g. an NGS account)
bun start --nats-context my-ngs-account

# Direct URL — overrides any context
NATS_URL=nats://nats.example.com:4222 bun start
```

## Models

Provider selection mirrors the CLI in `agents/open-agent/`. Pick with
`OPEN_AGENT_PROVIDER`:

- `gateway` (default) — Vercel AI Gateway. Auth via
  `AI_GATEWAY_API_KEY` (get one at
  <https://vercel.com/dashboard/ai-gateway>). `OPEN_AGENT_MODEL`
  defaults to **`anthropic/claude-opus-4.6`**.
- `openrouter` — auth via `OPENROUTER_API_KEY` (get one at
  <https://openrouter.ai/keys>). `OPEN_AGENT_MODEL` is **required** —
  pick a slug from <https://openrouter.ai/models>.

**Tradeoff (same as the standalone CLI):** OpenRouter goes through
plain Chat Completions only — no Anthropic adaptive thinking, no GPT-5
reasoning defaults, no OpenAI `store:false`, no encrypted reasoning
content. Use Gateway when those matter; OpenRouter is fine for most
straight tool-loop coding work.

## Run

```bash
nats-server -js                                    # terminal 1

cd examples/open-agent-vercel                      # terminal 2
bun install

# Default: Vercel AI Gateway
VERCEL_TOKEN=... AI_GATEWAY_API_KEY=... \
  OPEN_AGENT_OWNER=$USER OPEN_AGENT_SESSION=demo \
  bun start

# Or: OpenRouter
VERCEL_TOKEN=... OPENROUTER_API_KEY=... \
  OPEN_AGENT_PROVIDER=openrouter \
  OPEN_AGENT_MODEL='anthropic/claude-sonnet-4' \
  OPEN_AGENT_OWNER=$USER OPEN_AGENT_SESSION=demo \
  bun start

nats req 'agents.prompt.open-agent.'"$USER"'.demo' --timeout=5m \
  "list the top-level files in this sandbox"
```

`OPEN_AGENT_REPO_URL` (optional) clones a public GitHub repository
into the sandbox at boot. The value is passed verbatim to Vercel's
`source.url`, which expects a `https://github.com/<owner>/<repo>`
URL — for example:

```bash
OPEN_AGENT_REPO_URL=https://github.com/synadia-io/nats.go \
  VERCEL_TOKEN=... AI_GATEWAY_API_KEY=... \
  OPEN_AGENT_OWNER=$USER OPEN_AGENT_SESSION=demo \
  bun start
```

Private repos need a `githubToken` on the underlying Vercel sandbox
config — not currently surfaced as an env var by this example.

## Vendoring

`vendor/vercel/` is a verbatim copy of `packages/sandbox/vercel` from
`vercel-labs/open-agents` (commit `56ddf9465553dd76f2156abc241bd75a1d82ed0d`),
and `vendor/{interface,types,factory}.ts` are the matching parent
files the vercel adapter imports. Upstream isn't published to npm yet,
which is why we vendor here. Refresh procedure mirrors
`agents/open-agent/VENDORED.md`.

## Caveats

- `@vercel/sandbox` makes real API calls — running this without a
  scratch project will count against your Vercel quota.
- The bridge holds one Vercel sandbox per process. Spawning a sandbox
  per session is a controller concern (deferred).
- Approvals (dangerous bash commands) round-trip via `ask_user_question`
  the same way they do in the local example.
