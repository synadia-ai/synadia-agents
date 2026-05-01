# examples/dspy - building an agent with the SDK

An example of **building a new agent from scratch** using the TypeScript SDK pair: caller-side primitives from `@synadia-ai/agents` (subjects, the `parseNatsUrl` helper) and the host-side `AgentService` from `@synadia-ai/agent-service` (registration, prompt + status endpoints, heartbeat loop, terminator). It runs a [ax-llm](https://github.com/ax-llm/ax) (DSPy-style signatures + ReAct) loop with four sandboxed tools: `list_files`, `read_file`, `write_file`, `bash`. Once started it appears as a normal NATS Agent Protocol service and can be driven by any caller - the CLI examples in `../../client-sdk/typescript/examples/`, the web UI in `../agent-web-ui/`, or your own code.

- `list_files` / `read_file` / `write_file` refuse any path that escapes the sandbox root.
- `bash` runs commands with `cwd` set to the sandbox root, a 30 s timeout, and 8000-char output truncation. **Note:** a shell is a soft boundary - the model can `cd ..`, `curl`, etc. Don't point this at anything you care about.

## Subject

```
agents.prompt.dspy.<owner>.react       # prompt endpoint (v0.3 verb-first)
agents.hb.dspy.<owner>.react           # 10 s heartbeat (§8.1 v0.3)
agents.status.dspy.<owner>.react       # status request/response (§8.7 (v0.3))
```

## Streamed chunks

1. `{"type":"status","data":"ack"}` - request accepted.
2. `{"type":"status","data":"→ list_files(\".\")"}` - one per tool call, showing the ReAct trace live.
3. `{"type":"response","data":"…"}` - final-answer deltas from the model.
4. Empty-body no-headers message - end of stream.

## Run

```sh
# 1. Build both SDKs (workspace siblings, referenced via file:).
(cd ../../client-sdk/typescript && bun install && bun run build)
(cd ../../agent-sdk/typescript  && bun install && bun run build)

# 2. source your API key (NVIDIA OpenAI-compatible endpoint).
source ../../.env

# 3. install deps and start.
bun install
bun run start
```

See [`README-DEV.md`](../../README-DEV.md) at the repo root for the full
local-development build / install recipes.

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `NVIDIA_API_KEY` | (required) | API key for the NVIDIA endpoint |
| `NVIDIA_API_URL` | `https://integrate.api.nvidia.com/v1` | OpenAI-compatible base URL |
| `DSPY_MODEL` | `openai/gpt-oss-20b` | Model ID to send on every request |
| `DSPY_SANDBOX` | `./sandbox` | Root directory for the sandboxed `list_files` / `read_file` / `write_file` / `bash` tools |
| `DSPY_DEBUG` | (off) | Set to `1` to log every ReAct trace step to stderr |
| `NATS_URL` | `nats://127.0.0.1:4222` | NATS server URL |
| `USER` | system username | Owner subject token (3rd segment, fallback to `anon`) |

## Try it

With the agent running:

```sh
cd ../../client-sdk/typescript
bun run examples/02-prompt-text.ts "list the files in the sandbox and tell me what you see"
```

Or drive it from the web UI in `../agent-web-ui/`.
