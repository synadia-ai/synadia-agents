# `@synadia-ai/agents` examples

Runnable caller-side demos — minimal scripts that discover and prompt agents
speaking the [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs).
Counterpart to the host-side examples in
[`agent-sdk/typescript/examples/`](../../../agent-sdk/typescript/examples/), and
the TypeScript mirror of
[`client-sdk/python/examples/`](../../../client-sdk/python/examples/).

| Script                                               | What it does                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [`01-discover.ts`](01-discover.ts)                   | Enumerate every reachable agent via `$SRV.INFO.agents` and print identity + capabilities.                                         |
| [`02-prompt-text.ts`](02-prompt-text.ts)             | Send a text prompt to the first discovered agent and stream the response. Prompt is the first CLI arg (default `"hello"`).        |
| [`03-prompt-attachment.ts`](03-prompt-attachment.ts) | Prompt with a file attached; shows §5.4 pre-publish validation (`max_payload`, `attachments_ok`). First CLI arg is the file path. |
| [`04-query-reply.ts`](04-query-reply.ts)             | Answer an agent's mid-stream queries (clarifications, permission prompts). Prompt is the first CLI arg.                           |
| [`05-liveness.ts`](05-liveness.ts)                   | Per-instance heartbeat listener + periodic liveness snapshot.                                                                     |
| [`06-chat.ts`](06-chat.ts)                           | Interactive multi-turn chat REPL against the first discovered agent (built-in `readline`, no UI deps).                            |
| [`_run-reference-agent.ts`](_run-reference-agent.ts) | (not a demo) spins up the spec-compliant `ReferenceAgent` for the others to discover and prompt.                                  |

## Environment variables

The demos resolve their NATS connection the same way; neither is required (the
default connects to a local server). They discover and prompt agents — no agent
identity to set, so the identity vars (`SYNADIA_OWNER` / `SYNADIA_NAME`, legacy
`NATS_AGENT_*`) used by the
[host-side examples](../../../agent-sdk/typescript/examples/) don't apply here.

| Variable       | Default   | Purpose                                                                                                                   |
| -------------- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `NATS_CONTEXT` | _(unset)_ | Connect via a named [NATS CLI context](https://docs.nats.io/using-nats/nats-tools/nats_cli/nats_contexts). Wins when set. |
| `NATS_URL`     | _(unset)_ | Connect via a raw URL; credentials in the userinfo are honored.                                                           |

When neither is set, the demos fall back to `nats://127.0.0.1:4222`.

## Run

```sh
# Build the SDK once, then run a demo. Connection resolution:
#   $NATS_CONTEXT  >  $NATS_URL  >  nats://127.0.0.1:4222
bun install && bun run build

# Terminal 1 — start an agent for the demos to talk to:
bun examples/_run-reference-agent.ts
# (or any host-side example, e.g. ../../agent-sdk/typescript/examples/01-echo.ts)

# Terminal 2 — discover it, then prompt it:
bun examples/01-discover.ts
bun examples/02-prompt-text.ts "say hello in five words"
NATS_CONTEXT=my-context bun examples/02-prompt-text.ts "hello"
```

## Notes

- **`04-query-reply.ts`** needs an agent whose handler actually asks a mid-stream
  question (`PromptStream.ask`). The bundled reference agent's echo handler does
  not emit queries, so `04` against it just streams the echo back without hitting
  the interactive path.
- **`06-chat.ts`** reads as a real conversation only against a _stateful_ agent —
  under v0.3 one chat = one session = one subject. The bundled reference agent is
  stateless, so it replies to each turn independently; it's still the simplest
  target to try the REPL on.
