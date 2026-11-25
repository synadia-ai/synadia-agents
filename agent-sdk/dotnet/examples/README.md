# `Synadia.AI.Agents.Service` examples

Runnable host-side examples — small .NET 10 [file-based apps](https://learn.microsoft.com/dotnet/core/sdk/file-based-apps)
that spin up an agent speaking the
[Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs).
.NET mirror of [`agent-sdk/python/examples/`](../../python/examples/) and
[`agent-sdk/typescript/examples/`](../../typescript/examples/) (same agent names, flags, env vars and demo prompts, so
callers and docs line up across languages), and the host-side counterpart to the caller demos in
[`client-sdk/dotnet/examples/`](../../../client-sdk/dotnet/examples/).

They form a ladder — each rung is the one before plus a little more:

| Example | Registers | What it shows |
| --- | --- | --- |
| [`01-echo.cs`](01-echo.cs) | `echo` | Minimal agent on `AgentService.OnPrompt` — replies `echo: <prompt>`. |
| [`02-ollama.cs`](02-ollama.cs) | `ollama` | A local Ollama model (OllamaSharp's `IChatClient`) served with **one call**: `ServeChatClient(client)`. |
| [`03-openrouter.cs`](03-openrouter.cs) | `openrouter` | Same again, but the backend is the hosted, OpenAI-compatible OpenRouter API (`Microsoft.Extensions.AI.OpenAI`). |
| [`04-combined.cs`](04-combined.cs) | `llm` | Ollama **or** OpenRouter, auto-selected from the env; with a key, MEAI's `OrderedFailoverChatClient` falls back from OpenRouter to Ollama. |
| [`05-tools.cs`](05-tools.cs) | `tools` | A `read_sensor` tool (`AIFunctionFactory`) whose body is one NATS request to a `sensors` microservice; `FunctionInvokingChatClient` runs the tool loop. |
| [`06-approvals.cs`](06-approvals.cs) | `approvals` | Beyond the shared ladder: an approval-gated tool (`ApprovalRequiredAIFunction`) becomes a mid-stream `query` to the caller; `--agent-tools` lets the model discover and prompt other agents. |

The spec-compliant reference agent (a stateful echo with per-session memory) is
[`run-reference-agent.cs`](run-reference-agent.cs), a thin launcher for `ReferenceAgent` in
[`Synadia.AI.Agents.Testing`](../src/Synadia.AI.Agents.Testing/ReferenceAgent.cs) — it's what the
[`client-sdk/dotnet/examples/`](../../../client-sdk/dotnet/examples/) demos and the interop tests discover and prompt.

## What's different in .NET

The ladder is the same; the idiom is Microsoft.Extensions.AI (MEAI):

- **Every model is just an `IChatClient`.** `02`–`06` never touch HTTP or a provider's wire format: OllamaSharp,
  `Microsoft.Extensions.AI.OpenAI` (and anything else with an MEAI adapter) plug into the same
  `service.ServeChatClient(client, options)` call, which handles streaming, status chunks, history and error chunks.
  So `04-combined.cs` has no `llm.py`/`llm.ts`-style client abstraction. Choosing between backends is MEAI routing
  (`RoutingChatClient` and friends), and a router is itself an `IChatClient`, so serving it is the same call.
- **Tools are plain C# methods.** `05-tools.cs` turns `ReadSensor(string location)` into an `AIFunction` with
  `AIFunctionFactory.Create`, and `.UseFunctionInvocation()` runs the call-tool-and-resume loop for as many rounds as
  the model needs, instead of the hand-rolled two round trips in the Python/TS versions.
- **History is on by default.** `ServeChatClient` keeps conversation history (`ChatClientServeOptions.KeepHistory`,
  default `true`; by default the whole agent address is one conversation — the protocol's stateful-agent model — and
  `ConversationKey` can split it, e.g. per sender; capped by `MaxHistoryMessages`). The Python/TS ladder agents are
  stateless per prompt. Set `KeepHistory = false` for one-shot agents and attachment-heavy workloads.
- **Default model.** `02`, `04`, `05` and `06` default to `qwen3.5:4b` (tools-capable, small) rather than the
  Python/TS defaults (`llama3.2`, `llama3.1:8b` for `05`) — set `OLLAMA_MODEL` to match them. qwen3.5 "thinks" by
  default, which is slow; the examples ask for `ChatOptions.Reasoning = { Effort = None }`, which OllamaSharp maps to
  Ollama's `think: false` (`02-ollama.cs --think` and `06-approvals.cs --think` keep it and stream the reasoning as
  status chunks).

## Prerequisites

- .NET 10 SDK (`dotnet --version` ≥ 10.0.100) — file-based apps restore their own packages on first run.
- A NATS server: `nats-server` (or Docker `nats:latest`).
- For `02`, `04`, `05`, `06`: [Ollama](https://ollama.com) with a tool-capable model (`ollama pull qwen3.5:4b`).
- For `03` (and `04`'s OpenRouter branch): an [OpenRouter key](https://openrouter.ai/keys).

## Configuration

Connection, identity and heartbeat are shared by every rung through
[`_shared/ExampleHost.cs`](_shared/ExampleHost.cs) (the counterpart of the Python `_connect_cli.py` and the TS
`_connection.ts`). Flags take `--flag value` or `--flag=value`, each defaults to an env var, and an explicit flag
wins. Backend config is env-only. Run any example with `-- -h` for its flags.

Identity (`owner` / `name`) resolves through the same ladder as Python/TS, first non-empty wins:
`SYNADIA_<AGENT>_OWNER` (per-agent override) > `SYNADIA_OWNER` (fleet-wide) > `NATS_AGENT_OWNER` (legacy alias) >
`$USER`/`%USERNAME%` > `anon`; the `NAME` analogue is the same shape ending in `main`. `<AGENT>` is the example's
registered subject token uppercased with hyphens turned into underscores — `01-echo.cs` reads `SYNADIA_ECHO_OWNER`,
`04-combined.cs` reads `SYNADIA_LLM_OWNER`, and so on.

| Variable | Flag | Used by | Default | Purpose |
| --- | --- | --- | --- | --- |
| `NATS_URL` | `--url` | all | `nats://127.0.0.1:4222` | NATS server URL. |
| `SYNADIA_<AGENT>_OWNER` / `SYNADIA_OWNER` / `NATS_AGENT_OWNER` | `--owner` | all | your user name, else `anon` | 4th subject token (see ladder above). Set it so several people on one server don't collide. |
| `SYNADIA_<AGENT>_NAME` / `SYNADIA_NAME` / `NATS_AGENT_NAME` | `--session-name` | all | `main` | 5th subject token / session. |
| `NATS_AGENT_HEARTBEAT_INTERVAL` | `--heartbeat-interval` | all | `30` | Heartbeat cadence in **seconds**. `0` is treated as unset. |
| `NATS_NKEY_SEED_FILE` | `--nkey` | all | _(unset)_ | User nkey **seed file** (`SU…`) for the connection. A file, never an env value holding the seed. |
| `NATS_CREDS` (`NATS_CREDENTIALS`) | `--creds` | all | _(unset)_ | Credentials file (JWT + seed). Mutually exclusive with `--nkey`; between the env vars the nkey wins. |
| `NATS_SENDER_IDENTITY` | `--sender-identity` | all | `off` | `off` / `signed`. Signed registers `user_nkey` / `account` / `id_sig`, signed with the same seed/creds as the connection. |
| `OLLAMA_URL` (alias `OLLAMA_ENDPOINT`) | — | `02`, `04`, `05`, `06` | `http://localhost:11434` | Where Ollama is listening. A trailing `/v1` (the OpenAI-compatible URL) is stripped. |
| `OLLAMA_MODEL` | — | `02`, `04`, `05`, `06` | `qwen3.5:4b` | Which Ollama model to prompt. |
| `OPENROUTER_API_KEY` | — | `03`, `04` | _(required for `03`)_ | Your OpenRouter key. In `04` its presence makes OpenRouter the primary route, with Ollama as failover. |
| `OPENROUTER_MODEL` | — | `03`, `04` | `openai/gpt-4o-mini` | Any [OpenRouter model](https://openrouter.ai/models). |
| `OPENAI_BASE_URL` | — | `03`, `04` | `https://openrouter.ai/api/v1` | Override the OpenAI-compatible endpoint (e.g. Ollama's `http://localhost:11434/v1`). With it set, `03` runs without a key. |

**Gaps vs. the Python/TS examples** (not faked — the .NET SDK doesn't support them yet):

- No `--context` / `NATS_CONTEXT`: neither NATS.Net nor the .NET SDK reads `nats` CLI context files. Use `--url`
  plus `--nkey`/`--creds`.
- No credentials in the URL userinfo, and the URL falls back to `nats://127.0.0.1:4222` (like the .NET caller
  examples) instead of erroring when nothing is configured.
- `05-tools.cs` and `06-approvals.cs` are Ollama-only (as in Python/TS for `05`).

**Intentional deviation:** with an OpenRouter key, `04-combined.cs` adds failover to Ollama; Python/TS use OpenRouter
alone. Without a key the behavior is identical.

## Run

```sh
nats-server &                       # or: docker run -p 4222:4222 nats:latest
cd agent-sdk/dotnet/examples

# env-driven identity (fleet-wide SYNADIA_* vars):
SYNADIA_OWNER=alice SYNADIA_NAME=demo dotnet run 01-echo.cs
# per-agent override beats the fleet-wide var:
SYNADIA_ECHO_OWNER=alice dotnet run 01-echo.cs
# or pass identity as flags (flags win over every env var):
dotnet run 01-echo.cs -- --url nats://127.0.0.1:4222 --owner alice --session-name demo
# fast heartbeats, to make the liveness demo lively:
dotnet run 01-echo.cs -- --heartbeat-interval 2
# authenticated + signed registration (sender-identity extension):
dotnet run 01-echo.cs -- --nkey ~/alice.nk --sender-identity signed
```

You should see:

```
echo agent listening on agents.prompt.echo.<owner>.<session-name>
press Ctrl+C to stop
```

Drive it from another terminal with the caller-side
[`client-sdk/dotnet/examples/`](../../../client-sdk/dotnet/examples/) (`dotnet run 02-prompt-text.cs -- "hello!"`), the
TS/Python caller demos, or directly with the `nats` CLI:

```sh
nats req agents.prompt.echo.alice.demo "hello!" --replies=0 --reply-timeout=30s --timeout=60s
```

Output (leading ack, one response chunk, then the empty terminator):

```
{"type":"status","data":"ack"}
{"type":"response","data":"echo: hello!"}
(nil body)
```

With `--sender-identity signed`, `nats micro info agents` shows `user_nkey`, `account` and `id_sig` in the service
metadata.

### `02-ollama.cs` — serve a local LLM

```sh
ollama pull qwen3.5:4b
dotnet run 02-ollama.cs
OLLAMA_MODEL=llama3.2 dotnet run 02-ollama.cs
dotnet run 02-ollama.cs -- --think        # keep qwen's thinking, streamed as status chunks
```

Registers as `ollama`; streams the model's answer token by token. The whole agent is
`service.ServeChatClient(new OllamaApiClient(http, model), …)`.

### `03-openrouter.cs` — serve a hosted LLM

The same agent as `02`, powered by the hosted, OpenAI-compatible [OpenRouter](https://openrouter.ai) API through
`Microsoft.Extensions.AI.OpenAI` (`OpenAIClient.GetChatClient(model).AsIChatClient()`). Needs an API key; no GPU.

```sh
export OPENROUTER_API_KEY=sk-or-...
dotnet run 03-openrouter.cs
OPENROUTER_MODEL=anthropic/claude-3.5-haiku dotnet run 03-openrouter.cs
# no key? point it at any OpenAI-compatible endpoint, e.g. Ollama's:
OPENAI_BASE_URL=http://localhost:11434/v1 OPENROUTER_MODEL=qwen3.5:4b dotnet run 03-openrouter.cs
```

Registers as `openrouter`. **Real OpenRouter was not exercised** when these examples were written (no key); the
example was verified end to end against Ollama's OpenAI-compatible `/v1` endpoint via `OPENAI_BASE_URL`.

### `04-combined.cs` — Ollama **or** OpenRouter, with failover

| Condition | Served client |
| --- | --- |
| `OPENROUTER_API_KEY` is set | `OrderedFailoverChatClient([openRouter, ollama])`: **OpenRouter** first (`OPENROUTER_MODEL`, default `openai/gpt-4o-mini`; `OPENAI_BASE_URL` honored), then **local Ollama** |
| otherwise | **local Ollama** alone (`OLLAMA_MODEL`, default `qwen3.5:4b`; `OLLAMA_URL`) |

Registers as `llm` and prints the chain on startup, e.g. `backend: openrouter/openai/gpt-4o-mini → ollama/qwen3.5:4b
(failover)` or `backend: ollama/qwen3.5:4b`.

Failover uses MEAI's routing clients (`Microsoft.Extensions.AI` 11, `[Experimental]` under `MEAI001`, suppressed
around the one constructor call). If OpenRouter fails **before any output streams** (bad key, 429, outage), the same
prompt goes to Ollama. The OpenAI client's own retries are off, so the chain fails over at once. A failure **after**
output has started is terminal, and the caller gets an error chunk: MEAI never retracts a partial answer.

Each route's builder chain ends with MEAI's stock `LoggingChatClient`, under a per-route category (`route.openrouter`,
`route.ollama`). `UseLogging()` would log both routes under the same `LoggingChatClient` category, so a tiny
`UseRouteLogging(loggerFactory, route)` extension creates a named logger instead. Logs go to stderr, one line each, at
`Debug` for the `route.*` categories. `Trace` stays off because `LoggingChatClient` logs full messages at `Trace`.
There's no separate "failover" line: a `route.ollama` "invoked" right after a `route.openrouter` "failed" is the
failover. With a dead primary (exception and stack trace trimmed):

```
dbug: route.openrouter[1723383095] GetStreamingResponseAsync invoked.
fail: route.openrouter[1784604714] GetStreamingResponseAsync failed. System.ClientModel.ClientResultException: No connection could be made because the target machine actively refused it. (127.0.0.1:60201) …
dbug: route.ollama[1723383095] GetStreamingResponseAsync invoked.
dbug: route.ollama[1553703230] GetStreamingResponseAsync completed.
```

(`OrderedFailoverChatClient` is sealed. For a single "failed over" event with timings, derive from `FailoverChatClient`
and override `OnRoutingUpdateAsync`.) Each route keeps its own tuning on its own client: Ollama's `think: false` is a
`ConfigureOptions` on the Ollama route only, so it never reaches the OpenRouter request.

Try the failover without a key:

```sh
OPENROUTER_API_KEY=dummy OPENAI_BASE_URL=http://127.0.0.1:1/v1 dotnet run 04-combined.cs   # dead primary → Ollama
```

**Next step: per-request routing.** Failover picks by availability. To pick by request, use
`RoutingChatClient.Create((context, ct) => …)`, which selects a client from the messages and options, or
`SemanticRoutingChatClient`, which matches the prompt against example utterances per client and so needs an
embedding model. Both are `IChatClient`s and are served the same way. They are not used here because they would
change the Python/TS contract (key ⇒ OpenRouter).

### `05-tools.cs` — give the agent a tool backed by a microservice

The agent gains a `read_sensor` **tool**, and that tool is wired to a NATS microservice:

> any microservice already on your NATS network can become an agent capability — the agent need not embed the
> database, device, or credential that sits behind it.

The agent holds only an LLM and a NATS connection. When the model needs live data it calls the tool, the tool makes a
single `RequestAsync("sensors.read", location)`, and a `sensors` microservice (`NATS.Client.Services`, hosted in the
same file for the demo) answers. Needs a tool-capable model:

```sh
ollama pull qwen3.5:4b
dotnet run 05-tools.cs
# tools agent listening on agents.prompt.tools.<owner>.main
# sensor service on 'sensors.read', model 'qwen3.5:4b' at http://localhost:11434
# press Ctrl+C to stop
```

Then ask it something that needs the sensor:

```sh
nats req agents.prompt.tools.<owner>.main \
  "Is cold-storage room 3 within the safe range (below 4°C)?" \
  --replies=0 --reply-timeout=120s --timeout=180s
```

```
{"type":"status","data":"ack"}
{"type":"status","data":"calling read_sensor"}
{"type":"response","data":"No"}
{"type":"response","data":","}
… "cold-storage room 3 is at 6.2°C, which is above the safe range of 4°C."
(nil body)
```

The agent console logs each tool call (`read_sensor(cold-storage-3) → cold-storage-3 is 6.2°C`). Room 3 is
deliberately too warm; rooms 1 and 2 are within range. While the agent runs, `nats micro ls` shows both the `agents`
service and the `sensors` service.

### `06-approvals.cs` — approval-gated tools and agent delegation

The rung the other ladders don't have yet. `restart_service` is wrapped in MEAI's `ApprovalRequiredAIFunction`;
`ServeChatClient` turns the model's approval request into a §7 mid-stream `query` to the caller and resumes the model
with the answer. `current_time` runs freely. `--agent-tools` adds `AgentTools.AsAITools()`
(`discover_agents`, `prompt_agent`, …) so the model can delegate to other agents on the network.

```sh
dotnet run 06-approvals.cs                    # agents.prompt.approvals.<owner>.main
dotnet run 06-approvals.cs -- --agent-tools
dotnet run 06-approvals.cs -- --think
```

Drive it with a caller that answers queries — the .NET REPL
[`client-sdk/dotnet/examples/06-chat.cs`](../../../client-sdk/dotnet/examples/06-chat.cs) or the TS
[`04-query-reply.ts`](../../../client-sdk/typescript/examples/04-query-reply.ts) (both talk to the first agent they
discover, so run this agent on its own server). With `06-chat.cs`:

```
❯ Please restart the billing service using the restart_service tool.
[agent asks] Allow tool 'restart_service' with arguments {"name":"billing"}? (yes/no)
> yes
[calling restart_service] The billing service has been successfully restarted.
```

Answering `no` declines the call and the model says so.
