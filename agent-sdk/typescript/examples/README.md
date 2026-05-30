# `@synadia-ai/agent-service` examples

Runnable host-side examples — minimal scripts that spin up an agent
speaking the [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs).
Counterpart to the caller-side numbered demos in
[`client-sdk/typescript/examples/`](../../../client-sdk/typescript/examples/).

| Example                        | What it shows                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| [`01-echo.ts`](01-echo.ts)     | Minimal echo agent on top of `AgentService` — replies `echo: <prompt>`.                    |
| [`02-ollama.ts`](02-ollama.ts) | Same shape as `01-echo`, but forwards each prompt to a local Ollama and streams the reply. |

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

### `02-ollama.ts` — prompt a local LLM

Needs a running [Ollama](https://ollama.com) with the model pulled:

```sh
ollama pull llama3.2
bun examples/02-ollama.ts            # uses llama3.2 by default
OLLAMA_MODEL=qwen2.5 bun examples/02-ollama.ts   # or pick another model
```

The agent registers as `ollama` and streams the model's answer back token by
token — drive it with the same caller demos or `nats` CLI as above.

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
