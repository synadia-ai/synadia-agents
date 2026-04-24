# examples/dspy-research-agent - deep research with ax-llm RLM

A NATS Agent Protocol service that answers open-ended research questions by running [ax-llm](https://github.com/ax-llm/ax)'s **RLM
(Recursive Language Model)** agent — an Actor/Responder program around a sandboxed JavaScript REPL with recursive `llmQuery()` sub-calls
using a web search backend based after DSPy-style "deep research agent" pattern from [cmpnd.ai's blog](https://www.cmpnd.ai/blog/learn-dspy-deep-research.html).

## Subject

```
agents.research.<owner>.rlm             # prompt endpoint
agents.research.<owner>.rlm.heartbeat   # 10 s heartbeat
```

## Streamed chunks

1. `{"type":"status","data":"ack"}` — request accepted.
2. `{"type":"status","data":"provider: tavily"}` — which search backend is active.
3. `{"type":"status","data":"turn N: <first line of JS>"}` — one per actor turn, so you can watch the REPL work.
4. `{"type":"status","data":"→ web.search(\"…\")"}` / `web.fetch(...)` / `web.findSimilar(...)` — tool-call trace.
5. `{"type":"status","data":"[success] …"}` — actor progress signals from RLM.
6. `{"type":"response","data":"…"}` — final markdown report, followed by a `Sources` block.
7. Empty-body no-headers message — end of stream.

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
| Exa ([docs](https://docs.exa.ai/))        | `exa`                             | `EXA_API_KEY`    | implemented                        |
| Stub (disabled)                           | any unknown value, or no keys set | —                | returns a clear error to the agent |

If `RESEARCH_PROVIDER` is unset, the agent auto-selects: Tavily if `TAVILY_API_KEY` is set, else Exa if `EXA_API_KEY` is set, else stub.

Adding Brave / SearxNG / DuckDuckGo is a one-file change: implement the interface, add a branch in `createSearchProvider`.

## Run

```sh
# 1. source your API keys
source ../../.env              # NVIDIA_API_KEY
export TAVILY_API_KEY=tvly-…   # or put it in .env

# 2. install deps (requires the client SDK to be built first - see monorepo README)
bun install

# 3. start
bun run start
```

Environment variables:

| var                      | default                               | meaning                                              |
|--------------------------|---------------------------------------|------------------------------------------------------|
| `NVIDIA_API_KEY`         | (required)                            | API key for the OpenAI-compatible endpoint           |
| `NVIDIA_API_URL`         | `https://integrate.api.nvidia.com/v1` | OpenAI-compatible base URL                           |
| `RESEARCH_MODEL`         | `openai/gpt-oss-20b`                  | model ID for the actor / responder                   |
| `RESEARCH_PROVIDER`      | auto                                  | `tavily` \| `exa` — unset auto-picks by key          |
| `TAVILY_API_KEY`         | (optional)                            | required when provider is `tavily`                   |
| `EXA_API_KEY`            | (optional)                            | required when provider is `exa`                      |
| `RESEARCH_MAX_TURNS`     | `15`                                  | max actor REPL turns per request                     |
| `RESEARCH_MAX_SUB_CALLS` | `30`                                  | cap on recursive `llmQuery` calls                    |
| `RESEARCH_DEBUG`         | unset                                 | set to `1` to dump req/res to `/tmp/research-*.json` |
| `NATS_URL`               | `nats://127.0.0.1:4222`               | NATS server                                          |

## Try it

With the agent running:

```sh
bun run scripts/ask.ts "what are the main tradeoffs between DSPy ReAct and DSPy RLM?"
```

Or drive it from any protocol client — `../agent-web-ui/`, `../../client-sdk/typescript/examples/`, or your own code.

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

The `contextPolicy: { preset: "checkpointed", budget: "balanced" }` setting keeps the prompt size bounded across long research runs by checkpoint-summarizing older turns. See `src/ax/src/ax/docs/axagent-rlm.md` in this repo for the full design reference.
