# `synadia-ai-agent-service` examples

Runnable host-side examples — minimal scripts that spin up an agent speaking the
[Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs).
Python mirror of
[`agent-sdk/typescript/examples/`](../../../agent-sdk/typescript/examples/), and
the host-side counterpart to the caller demos in
[`client-sdk/python/examples/`](../../../client-sdk/python/examples/).

They form a ladder — each rung is the one before plus a little more:

| Example | What it shows |
| --- | --- |
| [`01-echo.py`](01-echo.py) | Minimal echo agent on top of `AgentService` — replies `echo: <prompt>`. |
| [`02-ollama.py`](02-ollama.py) | Same shape as `01-echo`, but forwards each prompt to a local Ollama and streams the reply. |
| [`03-openrouter.py`](03-openrouter.py) | Same shape again, but the backend is the hosted, OpenAI-compatible OpenRouter API (needs a key). |
| [`04-combined.py`](04-combined.py) | Ollama **or** OpenRouter, auto-selected from the env; model access factored into [`llm.py`](llm.py). |
| [`05-tools.py`](05-tools.py) | Gives the LLM a `read_sensor` tool wired to a NATS microservice, then reasons over the reading. |

The spec-compliant [`_reference_agent.py`](_reference_agent.py) (a stateful echo
with per-session memory) lives here too — it's what the
[`client-sdk/python/examples/`](../../../client-sdk/python/examples/) demos and
the agent-sdk's tests discover and prompt.

## Install

```sh
uv sync --extra examples   # the `examples` extra pulls in httpx (used by 02–05)
```

`01-echo.py` needs only the base install; `02`–`05` stream over HTTP with
`httpx`, so they need the `examples` extra.

## Configuration

None of these are required — the examples are configured entirely through flags
and environment variables. Identity and heartbeat are flags that each default to
a `NATS_AGENT_*` env var (so the examples are env-driven like the TS ladder; an
explicit flag overrides the env). Connection is resolved by the shared
`_connect_cli.py`; backend config is env-only.

| Variable | Used by | Default | Purpose |
| --- | --- | --- | --- |
| `NATS_CONTEXT` | all | _(unset)_ | Connect via a named [`nats` CLI context](https://docs.nats.io/using-nats/nats-tools/nats_cli/nats_contexts). Same as `--context`. |
| `NATS_URL` | all | _(unset)_ | Connect via a raw URL (credentials in the userinfo are honored). Same as `--url`. |
| `NATS_AGENT_OWNER` | all | `$USER`, else `anon` | 4th subject token. Same as `--owner`. Set it so several people on one server don't collide. |
| `NATS_AGENT_NAME` | all | `main` | 5th subject token / session this agent serves. Same as `--session-name`. |
| `NATS_AGENT_HEARTBEAT_INTERVAL` | all | `30` | Heartbeat cadence in **seconds**. Same as `--heartbeat-interval`. Lower it (e.g. `2`) for a livelier `05-liveness` demo. `0` is treated as unset → the default. |
| `OLLAMA_URL` | `02`, `04`, `05` | `http://localhost:11434` | Where Ollama is listening. |
| `OLLAMA_MODEL` | `02`, `04`, `05` | `llama3.2` (`05`: `llama3.1:8b`) | Which Ollama model to prompt. |
| `OPENROUTER_API_KEY` | `03`, `04` | _(required for `03`)_ | Your [OpenRouter key](https://openrouter.ai/keys). |
| `OPENROUTER_MODEL` | `03`, `04` | `openai/gpt-4o-mini` | Any [OpenRouter model](https://openrouter.ai/models). |

**Connection** resolves in order: `--context` → `--url` → `$NATS_URL` → the
selected `nats` context (`$NATS_CONTEXT` / `nats context select`). There's no
silent localhost fallback — pass one of these (the examples below use `--url`).

## Run

```sh
# localhost, env-driven identity:
NATS_AGENT_OWNER=alice NATS_AGENT_NAME=demo uv run python examples/01-echo.py --url nats://127.0.0.1:4222
# or pass identity as flags instead:
uv run python examples/01-echo.py --url nats://127.0.0.1:4222 --owner alice --session-name demo
# fast heartbeats, to make the liveness demo lively:
uv run python examples/01-echo.py --url nats://127.0.0.1:4222 --heartbeat-interval 2
```

You should see:

```
echo agent listening on agents.prompt.echo.<owner>.<session-name>
press Ctrl+C to stop
```

Drive it from another terminal with the caller-side
[`client-sdk/python/examples/`](../../../client-sdk/python/examples/) demos, or
directly with the `nats` CLI:

```sh
nats req agents.prompt.echo.alice.demo "hello!" --replies=0 --reply-timeout=30s --timeout=60s
```

Output (leading ack, one response chunk, then the empty terminator):

```
{"type": "status", "data": "ack"}
{"type": "response", "data": "echo: hello!"}
(nil body)
```

### `02-ollama.py` — prompt a local LLM

Needs a running [Ollama](https://ollama.com) with the model pulled:

```sh
ollama pull llama3.2
uv run python examples/02-ollama.py --url nats://127.0.0.1:4222
OLLAMA_MODEL=qwen2.5 uv run python examples/02-ollama.py --url nats://127.0.0.1:4222
```

Registers as `ollama`; streams the model's answer token by token.

### `03-openrouter.py` — prompt a hosted LLM

The same agent as `02`, powered by the hosted, OpenAI-compatible
[OpenRouter](https://openrouter.ai) API. Needs an API key; no GPU required.

```sh
export OPENROUTER_API_KEY=sk-or-...
uv run python examples/03-openrouter.py --url nats://127.0.0.1:4222
OPENROUTER_MODEL=anthropic/claude-3.5-haiku uv run python examples/03-openrouter.py
```

Registers as `openrouter`.

### `04-combined.py` — Ollama **or** OpenRouter (the reusable base)

Answers with **either** a local Ollama **or** OpenRouter, chosen automatically.
Model access is factored into [`llm.py`](llm.py) — a small backend-agnostic chat
client behind one `chat_stream(messages)` API.

| Condition | Backend |
| --- | --- |
| `OPENROUTER_API_KEY` is set | **OpenRouter** (`OPENROUTER_MODEL`, default `openai/gpt-4o-mini`) |
| otherwise | **local Ollama** (`OLLAMA_MODEL`, default `llama3.2`; `OLLAMA_URL`) |

The chosen backend is printed on startup, e.g. `backend: ollama/llama3.2`.
Registers as `llm`.

### `05-tools.py` — give the agent a tool backed by a microservice

The agent gains a `read_sensor` **tool**, and that tool is wired to a NATS
microservice. This is the whole point in one file:

> any microservice already on your NATS network can become an agent capability —
> the agent need not embed the database, device, or credential that sits behind it.

The agent holds only an LLM and a NATS connection; it can't read a sensor itself.
When the model needs live data it calls the tool, the tool makes a single
`nc.request(...)`, and a microservice answers. For a self-contained demo it's
faked in the same file. It uses Ollama's `/api/chat` tool-calling in two
round-trips. Needs a tool-capable model (`llama3.1:8b` by default):

```sh
ollama pull llama3.1:8b
uv run python examples/05-tools.py --url nats://127.0.0.1:4222
```

Then ask it something that needs the sensor:

```sh
nats req agents.prompt.tools.<owner>.main \
  "Is cold-storage room 3 within the safe range (below 4°C)?" \
  --replies=0 --reply-timeout=45s --timeout=90s
```

Room 3 is deliberately too warm (`6.2°C`), so the agent has something to flag;
rooms 1 and 2 are within range. While the agent runs, `nats micro ls` shows both
the `agents` service (the agent) and the `sensors` service (its tool's backend).
