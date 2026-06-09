# examples/dspy-research-agent - deep research with ax-llm RLM

A NATS Agent Protocol service that answers open-ended research questions by running [ax-llm](https://github.com/ax-llm/ax)'s **RLM
(Recursive Language Model)** agent — an Actor/Responder program around a sandboxed JavaScript REPL with recursive `llmQuery()`
sub-calls over a pluggable web-search backend, following the DSPy-style "deep research agent" pattern from
[cmpnd.ai's blog](https://www.cmpnd.ai/blog/learn-dspy-deep-research.html). It is hosted with the host SDK's `AgentService` helper,
so registration, the verb-first subjects, heartbeats, and stream termination are handled for you.

## Requirements

- **[Bun](https://bun.sh)** and a reachable **NATS** server — a local `nats-server`, or a remote / Synadia Cloud cluster via a
  named context (see [Connecting to NATS](#connecting-to-nats)).
- **`NVIDIA_API_KEY`** — for the OpenAI-compatible inference endpoint ([build.nvidia.com](https://build.nvidia.com)).
- **One web-search key** — `TAVILY_API_KEY` ([app.tavily.com](https://app.tavily.com)) **or** `EXA_API_KEY`
  ([dashboard.exa.ai](https://dashboard.exa.ai)). Without one the agent still starts, but every search returns a clear
  "disabled" error (`provider: stub`).
- The local SDKs **built once** — this example links them via `file:`. See the monorepo [`README-DEV.md`](../../README-DEV.md).

### Model — use a capable one

The RLM actor has to **write correct JavaScript, call `web.search` / `web.fetch`, and invoke `submit()` itself**, turn after turn.
That needs a strong instruction-following model.

- **`openai/gpt-oss-120b` is the tested default** and the recommended model.
- Smaller models (e.g. `openai/gpt-oss-20b`) frequently **cannot drive the loop** — they stall or repeat turns until
  `RESEARCH_MAX_TURNS` is exhausted and the caller times out with no answer.

If the agent registers and heartbeats but never responds to a prompt, the model is the first thing to check (see
[Troubleshooting](#troubleshooting)).

## Run

```sh
# 1. keys — NVIDIA_API_KEY is required; set one search key
source ../../.env                  # or export the vars directly
export TAVILY_API_KEY=tvly-…       # or: export EXA_API_KEY=…

# 2. install deps (build the SDKs first — see monorepo README-DEV.md)
bun install

# 3. start (120b strongly recommended — see "Model" above)
RESEARCH_PROVIDER=tavily RESEARCH_MODEL="openai/gpt-oss-120b" ./scripts/run.sh
```

`scripts/run.sh` sources `../../.env`, stops any previous instance of *this* example, and starts the agent. On success:

```
research agent listening on agents.prompt.research.<owner>.rlm
model:    openai/gpt-oss-120b
provider: tavily
```

(`bun run start` works too; `run.sh` just adds the `.env` sourcing and restart handling.)

## Connecting to NATS

By default the agent connects to `nats://127.0.0.1:4222`. To target a remote cluster (Synadia Cloud, an auth'd server, TLS, …),
use a **named NATS CLI context** — it carries creds / nkey / JWT / TLS:

```sh
NATS_CONTEXT=my-synadia-cloud RESEARCH_PROVIDER=tavily RESEARCH_MODEL="openai/gpt-oss-120b" ./scripts/run.sh
```

Connection resolution (the agent **and** the `ask.ts` driver both follow it): **`NATS_CONTEXT` → `NATS_URL` → `nats://127.0.0.1:4222`**.
A bare `NATS_URL` only carries the address — for an authenticated server you need the context.

## Try it

With the agent running, drive it with the bundled CLI (5-minute inactivity timeout):

```sh
# pass the same context if the agent is on a remote cluster
NATS_CONTEXT=my-synadia-cloud bun run scripts/ask.ts "what are the main tradeoffs between DSPy ReAct and DSPy RLM?"
```

Status lines (provider, REPL turns, tool calls) stream to **stderr**; the final markdown report streams to **stdout**. Or drive it
from any protocol client — `../agent-web-ui/`, `../../client-sdk/typescript/examples/`, or your own code.

> **A deep-research run takes minutes, not seconds** — it plans subtopics, runs several searches, fetches pages, and synthesizes.
> Clients with a short inactivity timeout (the `agent-web-ui/` default is ~60 s) can give up before the report is ready.
> `scripts/ask.ts` uses a 300 s timeout; raise your client's timeout similarly for real runs.

## Environment variables

| var                      | default                               | meaning                                                                       |
|--------------------------|---------------------------------------|-------------------------------------------------------------------------------|
| `NVIDIA_API_KEY`         | (required)                            | API key for the OpenAI-compatible endpoint                                    |
| `NVIDIA_API_URL`         | `https://integrate.api.nvidia.com/v1` | OpenAI-compatible base URL                                                     |
| `RESEARCH_MODEL`         | `openai/gpt-oss-120b`                 | model ID for the actor / responder — keep this capable (see [Model](#model--use-a-capable-one)) |
| `RESEARCH_PROVIDER`      | auto                                  | `tavily` \| `exa` — unset auto-picks by which key is present                  |
| `TAVILY_API_KEY`         | (optional)                            | required when provider is `tavily`                                            |
| `EXA_API_KEY`            | (optional)                            | required when provider is `exa`                                               |
| `RESEARCH_MAX_TURNS`     | `15`                                  | max actor REPL turns per request                                             |
| `RESEARCH_MAX_SUB_CALLS` | `30`                                  | cap on recursive `llmQuery` calls                                            |
| `RESEARCH_DEBUG`         | unset                                 | `1` enables ax's verbose turn trace + dumps req/res to `/tmp/research-*.json` |
| `NATS_CONTEXT`           | unset                                 | named NATS CLI context (creds/nkey/JWT/TLS); takes precedence over `NATS_URL` |
| `NATS_URL`               | `nats://127.0.0.1:4222`               | NATS server (used when `NATS_CONTEXT` is unset)                              |

## Subject

```
agents.prompt.research.<owner>.rlm    # prompt endpoint  (v0.3 verb-first)
agents.status.research.<owner>.rlm    # status endpoint
agents.hb.research.<owner>.rlm        # 10 s heartbeat   (§8.1)
```

`<owner>` is the sanitized `USER` env var (dots / wildcards → `_`, so `john.doe` registers as `john_doe`).

## Streamed chunks

1. `{"type":"status","data":"ack"}` — request accepted.
2. `{"type":"status","data":"provider: tavily"}` — which search backend is active.
3. `{"type":"status","data":"turn N: <first line of JS>"}` — one per actor turn, so you can watch the REPL work.
4. `{"type":"status","data":"→ web.search(\"…\")"}` / `web.fetch(...)` / `web.findSimilar(...)` — tool-call trace.
5. `{"type":"status","data":"[success] …"}` — actor progress signals from RLM.
6. `{"type":"response","data":"…"}` — final markdown report, followed by a `Sources` block.
7. Empty-body message — the §6.5 stream terminator (`AgentService` sends it on every completion path).

## Search providers

Search lives behind a `SearchProvider` interface in `src/search.ts`:

```ts
interface SearchProvider {
  search(query, opts): Promise<SearchResult[]>;
  fetch(url):          Promise<FetchedPage>;
  findSimilar?(url, opts): Promise<SearchResult[]>; // optional; Exa only today
}
```

The agent only exposes `web.findSimilar` to the REPL when the active provider implements it — so the actor's tool catalog changes per-provider.

| Provider                                  | `RESEARCH_PROVIDER`               | Keys             | Status                             |
|-------------------------------------------|-----------------------------------|------------------|------------------------------------|
| Tavily ([docs](https://docs.tavily.com/)) | `tavily`                          | `TAVILY_API_KEY` | implemented                        |
| Exa ([docs](https://docs.exa.ai/))        | `exa`                             | `EXA_API_KEY`    | implemented (adds `findSimilar`)   |
| Stub (disabled)                           | any unknown value, or no keys set | —                | returns a clear error to the agent |

If `RESEARCH_PROVIDER` is unset, the agent auto-selects: Tavily if `TAVILY_API_KEY` is set, else Exa if `EXA_API_KEY` is set, else stub.

Adding Brave / SearxNG / DuckDuckGo is a one-file change: implement the interface, add a branch in `createSearchProvider`.

## How the RLM loop works here

The agent signature is:

```
question:string -> report:string, citations:string[]
```

Under the hood, ax splits this into two programs:

- **Actor** — writes JavaScript each turn. It has access to:
  - `web.search(query, { maxResults })` and `web.fetch(url)` as injected async functions
  - `web.findSimilar(url, { maxResults })` when the provider supports it (Exa today) — lets the actor pivot recursively from a good source instead of inventing a new keyword query
  - `llmQuery(prompt, ctx?)` for cheaper sub-LLM extraction / summarization calls
  - persistent globals (`globalThis.subtopics`, `globalThis.evidence`, etc.)
  - `submit("done")` to signal completion
- **Responder** — runs once after the actor submits, and synthesizes the final `report` + `citations` from the accumulated REPL state.

The `contextPolicy: { preset: "checkpointed", budget: "balanced" }` setting keeps the prompt size bounded across long research runs by checkpoint-summarizing older turns. See the [ax-llm](https://github.com/ax-llm/ax) documentation for the full RLM design reference.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Agent registers + heartbeats, but prompts never get a response | **Model too weak** to drive the RLM loop — use `RESEARCH_MODEL="openai/gpt-oss-120b"`. Confirm by running with `RESEARCH_DEBUG=1` and watching the agent's turn trace. |
| Caller times out (~60 s) with partial / no output | Deep research takes **minutes**. Use `scripts/ask.ts` (300 s timeout) or raise your client's inactivity timeout. |
| `provider: stub` at startup, or "web search is disabled" | No `TAVILY_API_KEY` / `EXA_API_KEY` set, or `RESEARCH_PROVIDER` names a provider whose key is missing. |
| `NVIDIA_API_KEY is not set` | Export it, or put it in `../../.env` (which `run.sh` sources). |
| Can't reach a remote / Synadia Cloud cluster | Use `NATS_CONTEXT=<your context>` — it carries creds / TLS; a bare `NATS_URL` does not. |
| Need to see what the model is doing | `RESEARCH_DEBUG=1` — verbose ax turn trace + each LLM request/response dumped to `/tmp/research-<run>-{req,res}-N.json` (mode `0600`). |
