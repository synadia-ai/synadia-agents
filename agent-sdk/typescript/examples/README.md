# `@synadia-ai/agent-service` examples

Runnable host-side examples — minimal scripts that spin up an agent
speaking the [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs).
Counterpart to the caller-side numbered demos in
[`client-sdk/typescript/examples/`](../../../client-sdk/typescript/examples/).

| Example                        | What it shows                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| [`01-echo.ts`](01-echo.ts)     | Minimal echo agent on top of `AgentService` — replies `echo: <prompt>`.                         |
| [`02-ollama.ts`](02-ollama.ts) | Same shape as `01-echo`, but forwards each prompt to a local Ollama and streams the reply.      |
| [`03-tools.ts`](03-tools.ts)   | Gives the LLM a `read_sensor` tool wired to a NATS microservice, then reasons over the reading. |

## Run

```sh
# 1. Build both SDKs (caller first, then host).
(cd ../../../client-sdk/typescript && bun install && bun run build)
(cd ../../../agent-sdk/typescript  && bun install && bun run build)

# 2. Run an example. Connection resolution:
#      $NATS_CONTEXT  >  $NATS_URL  >  nats://127.0.0.1:4222
cd ..   # agent-sdk/typescript
NATS_CONTEXT=my-context bun examples/01-echo.ts
# or:
NATS_URL=tls://connect.ngs.global bun examples/01-echo.ts
# or:
bun examples/01-echo.ts   # localhost fallback
```

You should see:

```
echo agent listening on agents.prompt.echo.<you>.main
press Ctrl+C to stop
```

Drive it from another terminal with the caller-side
[`client-sdk/typescript/examples/`](../../../client-sdk/typescript/examples/)
demos, or directly with the `nats` CLI:

```sh
nats req agents.prompt.echo.<you>.main "hello!" \
  --replies=0 --reply-timeout=30s --timeout=60s
```

Output:

```
{"type":"status","data":"ack"}
{"type":"response","data":"echo: hello!"}
(empty terminator)
```

### `02-ollama.ts` — prompt a local LLM

Needs a running [Ollama](https://ollama.com) with the model pulled:

```sh
ollama pull llama3.2
bun examples/02-ollama.ts            # uses llama3.2 by default
OLLAMA_MODEL=qwen2.5 bun examples/02-ollama.ts   # or pick another model
```

The agent registers as `ollama` and streams the model's answer back token by
token. Drive it the same way, but point `nats req` at the `ollama` subject:

```sh
nats req agents.prompt.ollama.<you>.main "Say hello in five words." \
  --replies=0 --reply-timeout=30s --timeout=60s
```

Output (one `response` chunk per token, then the terminator):

```
{"type":"status","data":"ack"}
{"type":"response","data":"Hello"}
{"type":"response","data":" there"}
{"type":"response","data":","}
...
(empty terminator)
```

### `03-tools.ts` — give the agent a tool backed by a microservice

The agent gains a `read_sensor` tool, and that tool is wired to a NATS
microservice. The agent holds only an LLM and a NATS connection — when the
model needs live data it calls the tool, the tool makes a NATS request, and a
microservice answers. For a self-contained demo the service (a faked
temperature sensor) is started in the same file; in production it runs anywhere
on your network.

Needs a tool-capable model:

```sh
ollama pull llama3.1:8b
bun examples/03-tools.ts
```

Ask it something that needs the sensor:

```sh
nats req agents.prompt.tools.<you>.main \
  "Is cold-storage room 3 within the safe range (below 4°C)?" \
  --replies=0 --reply-timeout=45s --timeout=90s
```

The model calls `read_sensor("cold-storage-3")`, the microservice replies with
the temperature, and the agent streams its verdict:

```
{"type":"status","data":"ack"}
{"type":"response","data":"No"}
{"type":"response","data":", the"}
... cold-storage room 3 is not within the safe range ...
(empty terminator)
```

Run `nats micro ls` while it's up to see both services on the bus — the
`agents` service (the agent) and the `sensors` service (the microservice it
calls).
