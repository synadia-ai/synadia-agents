# `@synadia-ai/open-agent`

A Synadia Agent Protocol for NATS bridge for
[`vercel-labs/open-agents`](https://github.com/vercel-labs/open-agents).
Exposes an open-agents `ToolLoopAgent` (read / write / edit / grep / glob /
bash / task / skill / web_fetch / ask_user_question) on
`agents.prompt.open-agent.<owner>.<session>` so any protocol caller —
the `@synadia-ai/agents` SDK, `nats req`, or `agent-web-ui` — can drive
it.

The bridge is built on `AgentService` from `@synadia-ai/agent-service`
(heartbeats, status endpoint, mid-stream queries, terminator emission).
It vendors `packages/agent` from open-agents verbatim and supplies a
`LocalSandbox` so the harness runs without a Vercel account. The
companion example at `examples/open-agent-vercel/` swaps in
`@vercel/sandbox` to prove the sandbox interface is genuinely
interchangeable.

## ⚠️ Security: `LocalSandbox` is not isolated

The `LocalSandbox` is for **trusted-operator** demos and dev work — it is
**not** an isolation boundary. The recent reviewer pass added FS path
confinement (every `read` / `write` / `stat` etc. is fenced to
`workingDirectory`) and a subprocess env allowlist (parent-process
secrets like `OPENROUTER_API_KEY` / `AI_GATEWAY_API_KEY` /
`NATS_CREDS` are stripped before `bash` spawns) — but **the `bash` tool
itself runs as the bridge user with full host filesystem privileges**.
A model running `ls /Users/you/Downloads`, `cat ~/.ssh/known_hosts`, or
similar via `bash` succeeds — that's not a regression, it's the
inherent limitation of running shell commands on the host.

If the model can reach the bridge, treat it as having shell access on
the box. For real isolation, run the **`examples/open-agent-vercel/`**
companion (or another `Sandbox` impl behind a chroot / container /
namespace boundary) instead. The seam is the same; only the
`sandboxFactory` differs.

The CLI flow is built around a per-session tmp `workdir`
(`${TMPDIR}/open-agent/<session>/`) so the model has a natural place
to operate without trampling your repo, but that's ergonomics, not a
fence.

## Quickstart

```bash
nats-server -js                                    # terminal 1

cd agents/open-agent                               # terminal 2
bun install
# AI_GATEWAY_API_KEY authenticates against the Vercel AI Gateway, which
# is the bridge's default model provider. Get a key at
# https://vercel.com/dashboard/ai-gateway, or use a different provider
# (e.g. OpenRouter) — see "Models" below.
AI_GATEWAY_API_KEY=... bun run cli \
  --owner $USER --session demo                     # bridge runs here

nats req 'agents.prompt.open-agent.'"$USER"'.demo' --timeout=5m \
  "create hello.txt with 'Hello, world.' and read it back"
```

The working directory defaults to `${TMPDIR}/open-agent/<session>/` and
is created on demand.

## Models

The bridge resolves model ids through a pluggable `ModelFactory`. Two
ship out of the box; pick one with `OPEN_AGENT_PROVIDER` (or the
`--provider` flag).

### Vercel AI Gateway (default — `OPEN_AGENT_PROVIDER=gateway`)

The upstream open-agents default. Routes `provider/model-id` ids to the
configured backend (Anthropic, OpenAI, Google, …). Get a key at
**<https://vercel.com/dashboard/ai-gateway>** and export it as
`AI_GATEWAY_API_KEY`. The default `OPEN_AGENT_MODEL` is
**`anthropic/claude-opus-4.6`** (the upstream `defaultModelLabel`);
swap it for any Gateway slug — e.g. `openai/gpt-5`,
`google/gemini-2.5-pro`, `anthropic/claude-sonnet-4.6`.

Gateway carries the upstream open-agents provider tuning baked into
`vendor/agent/models.ts`: Anthropic adaptive thinking on Claude 4.6/4.7,
OpenAI `store: false` for Responses, `reasoningSummary: detailed` +
encrypted-content inclusion on GPT-5, low text verbosity on GPT-5.4.

### OpenRouter (`OPEN_AGENT_PROVIDER=openrouter`)

Goes through OpenRouter's OpenAI-compatible endpoint. Get a key at
**<https://openrouter.ai/keys>** and export it as `OPENROUTER_API_KEY`.
`OPEN_AGENT_MODEL` is required (no default) — pick a slug from
**<https://openrouter.ai/models>**, e.g. `anthropic/claude-sonnet-4`,
`meta-llama/llama-3.3-70b-instruct`, `qwen/qwen3-coder`.

**Tradeoff:** OpenRouter calls go through plain Chat Completions only.
None of the Gateway provider tuning applies — no Anthropic adaptive
thinking, no GPT-5 reasoning defaults, no OpenAI `store:false`
middleware, no encrypted reasoning content. If your model relies on
those (e.g. GPT-5 Responses-API features), use Gateway. For most
straight tool-loop coding work this is fine.

```bash
# OpenRouter example
OPEN_AGENT_PROVIDER=openrouter \
OPENROUTER_API_KEY=... \
OPEN_AGENT_MODEL='anthropic/claude-sonnet-4' \
  bun run cli --owner $USER --session demo
```

### Custom factories

Programmatic users can pass any `(modelId: string) => LanguageModel` to
`runBridge({ modelFactory })`. Both built-in factories
(`gatewayModelFactory`, `openRouterModelFactory`) are exported from
`@synadia-ai/open-agent`.

## CLI flags / env

| Flag | Env | Default |
| --- | --- | --- |
| `--owner` | `OPEN_AGENT_OWNER` | `$USER` |
| `--session` | `OPEN_AGENT_SESSION` | `default` |
| `--workdir` | `OPEN_AGENT_WORKDIR` | `${TMPDIR}/open-agent/<session>/` |
| `--nats-context` | — | (unset) |
| `--provider` | `OPEN_AGENT_PROVIDER` | `gateway` (or `openrouter` if only `OPENROUTER_API_KEY` is set) |
| — | `NATS_URL` | `nats://127.0.0.1:4222` |
| — | `OPEN_AGENT_MODEL` | `anthropic/claude-opus-4.6` on Gateway; **required** on OpenRouter |
| — | `AI_GATEWAY_API_KEY` | required when provider=gateway |
| — | `OPENROUTER_API_KEY` | required when provider=openrouter |

`--nats-context <name>` resolves a saved `nats` CLI context via
`@synadia-ai/agents`'s `loadContextOptions`. `NATS_URL` overrides the
context.

## Wire format for tool calls

The bridge mirrors the convention `agents/claude-code` uses on the
wire: tool I/O rides on `status` chunks (§6.4) with a
`<prefix>:<json>` payload. Spec §6.4 requires callers to silently
ignore unrecognised status values, so this is forward-compatible —
dumb clients (`nats req`, raw subscribers) just see the model's
`response` text without tool noise; rich clients that opt into the
convention (e.g. `examples/agent-web-ui`) get structured tool-call
cards.

```text
status: "tool_use:{\"id\":\"<toolCallId>\",\"name\":\"bash\",\"input\":{\"command\":\"ls\"}}"
status: "tool_result:{\"tool_use_id\":\"<toolCallId>\",\"output\":\"exit 0\\nfoo.txt\\nbar.txt\",\"is_error\":false}"
```

`tool_use` carries the AI SDK's `toolCallId` as `id` and the raw tool
input verbatim. `tool_result` pairs to the same id via
`tool_use_id` and carries a compact summary of the output (matches
what the previous text-only flattening produced). On a tool error,
`is_error: true` and `output` carries the error text.

The model's `text-delta` parts continue to come through as ordinary
`response` chunks, unchanged.

## Permissions (dangerous bash commands)

The vendored `bash` tool flags commands matching `\brm\s+-rf\b` or
referencing `.env` files as needing approval. The bridge wires that
hook through the spec §7 `query` mechanism: when the model proposes a
flagged command, the caller receives a `query` chunk asking to
approve. Reply with one of `yes` / `y` / `approve` / `allow` / `ok` /
`1` to authorize execution; anything else (or a timeout) denies, and
the model sees a tool error it can react to.

Same primitive as `ask_user_question`. The `examples/agent-web-ui`
client renders both the same way.

**Known limitation — no cancellation during the approval wait.** The
AI SDK's `tool()` API passes `abortSignal` to `execute` but **not** to
`needsApproval`. If the caller abandons the prompt mid-flight while
the bridge is blocked on `PromptResponse.ask`, the §7 query continues
to wait until the configured timeout (`askUserQuestionTimeoutMs`,
default 5 minutes) before giving up. Lowering the timeout lowers the
worst-case hang. A real fix needs upstream AI SDK changes; see
`vendor/agent/tools/bash.ts` for the unmodified hook signature.

## Subject layout

The bridge advertises:

- `agents.prompt.open-agent.<owner>.<session>` (queue group `agents`)
- `agents.status.open-agent.<owner>.<session>`
- heartbeats on `agents.hb.open-agent.<owner>.<session>` every 30 s

`metadata.agent="open-agent"`, `metadata.protocol_version="0.3"`. v1 is
single-process / single-session: one bridge handles one
`(owner, session)` pair.

## Architecture

```
caller  ──▶  agents.prompt.open-agent.<owner>.<session>
                     │
                     ▼
            AgentService (heartbeats, terminator)
                     │
                     ▼
            runBridge ─▶ ToolLoopAgent ─▶ LocalSandbox (fs + bash)
                                     ╲   (or VercelSandbox in
                                      ╲   examples/open-agent-vercel)
```

`runBridge` is exported from `@synadia-ai/open-agent` so the Vercel
example can call the same handler with a different `sandboxFactory`.

## Vendoring

`vendor/agent/` is a verbatim copy of `packages/agent` from upstream;
`vendor/sandbox/{interface,types}.ts` are verbatim copies of the
matching open-agents files; `vendor/sandbox/{index,factory,local}.ts`
are written by us. See `VENDORED.md` for the upstream SHA and refresh
procedure. `tsconfig.json` rewrites the `@open-agents/sandbox` import
path used by the vendored agent code to point at our barrel — that's
the only piece of glue, so the vendored agent runs unmodified.

## Status

This is an inbound bridge only. An outbound `nats_agent` tool inside
the open-agents fork (Part C of the original design) is intentionally
deferred to a follow-up PR.

`AgentService` returns 500 for every handler error in v1; richer
status-code granularity is a follow-up. `attachments_ok` is `false`
for now. The `LocalSandbox` is not isolated — see the security warning
at the top.
