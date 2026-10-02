# `@synadia-ai/agents` examples

Runnable caller-side demos — minimal scripts that discover and prompt agents
speaking the [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs).
Counterpart to the host-side examples in
[`agent-sdk/typescript/examples/`](../../../agent-sdk/typescript/examples/), and
the TypeScript mirror of
[`client-sdk/python/examples/`](../../../client-sdk/python/examples/).

| Script                                               | What it does                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`01-discover.ts`](01-discover.ts)                   | Enumerate every reachable agent via `$SRV.INFO.agents` and print identity + capabilities.                                                                           |
| [`02-prompt-text.ts`](02-prompt-text.ts)             | Send a text prompt to the first discovered agent and stream the response. Prompt is the first CLI arg (default `"hello"`).                                          |
| [`03-prompt-attachment.ts`](03-prompt-attachment.ts) | Prompt with a file attached; shows §5.4 pre-publish validation (`max_payload`, `attachments_ok`). First CLI arg is the file path.                                   |
| [`04-query-reply.ts`](04-query-reply.ts)             | Answer an agent's mid-stream queries (clarifications, permission prompts). Prompt is the first CLI arg.                                                             |
| [`05-liveness.ts`](05-liveness.ts)                   | Per-instance heartbeat listener + periodic liveness snapshot.                                                                                                       |
| [`06-chat.ts`](06-chat.ts)                           | Interactive multi-turn chat REPL against the first discovered agent (built-in `readline`, no UI deps).                                                              |
| [`_run-reference-agent.ts`](_run-reference-agent.ts) | (not a demo) spins up the spec-compliant `ReferenceAgent` for the others to discover and prompt.                                                                    |
| [`_run-client-probe.ts`](_run-client-probe.ts)       | (not a demo) one-shot caller probe for the cross-SDK interop tests: `--agent` / `--owner` / `--prompt` [`--signed`], NDJSON out, exit 0 iff the terminator arrived. |

## Environment variables

The demos resolve their NATS connection the same way; none of these variables
is required (the default connects to a local server). They do not set host
`owner` / `name` fields, but can optionally sign their outgoing prompts as the
NATS user that authenticated the connection.

| Variable                         | Default   | Purpose                                                                                                                                                                 |
| -------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NATS_CONTEXT`                   | _(unset)_ | Complete named [NATS CLI context](https://docs.nats.io/using-nats/nats-tools/nats_cli/nats_contexts). Wins over all direct URL/credential variables.                    |
| `NATS_URL`                       | _(unset)_ | Direct connection URL; userinfo credentials are honored.                                                                                                                |
| `NATS_NKEY_SEED_FILE`            | _(unset)_ | User-seed file used to authenticate the direct URL connection. Wins over creds when both are set.                                                                       |
| `NATS_CREDS`, `NATS_CREDENTIALS` | _(unset)_ | Credentials file used to authenticate the direct URL connection. `NATS_CREDS` wins between the aliases.                                                                 |
| `NATS_SENDER_IDENTITY`           | `off`     | `off` sends no identity header. `signed` derives the caller signer from the selected connection source; the context or direct credential file must contain a user seed. |

When no context or URL is set, the direct source falls back to
`nats://127.0.0.1:4222` (and still uses a configured direct credential file).

Connection sources are atomic. A context supplies its own URL, authentication,
and TLS settings; it is never combined with a direct credentials file. The
shared connection bundle reads the selected source once and supplies both NATS
authentication and, only in signed mode, the signer. There is no second
identity credential, and the default mode performs no identity lookup.

`_run-reference-agent.ts` additionally reads the inbound trust policy. Like the
other examples, credentials authenticate its connection without implicitly
enabling identity. Set `NATS_SENDER_IDENTITY=signed` to opt into signed
registration for either a context or direct credential source.

| Variable                           | Default | Purpose                                                           |
| ---------------------------------- | ------- | ----------------------------------------------------------------- |
| `REFERENCE_AGENT_MIN_SENDER_TRUST` | `any`   | `any` or `signed` — what the prompt endpoint requires of callers. |

Its echo ends with `sender: <id> (<trust>)` only when a sender was classified,
e.g. `demo agent received your prompt. sender: $G.UCDU… (verified user, claimed account)`;
the identity is printed on its own line after the `reference agent listening on …` marker.

`_run-client-probe.ts` reads `NATS_URL` only (never `NATS_CONTEXT`) plus the
same direct nkey/creds knobs to authenticate the connection.
With `--signed` the same file also signs the prompt's `Agent-Sender`, and a
first NDJSON line `{"type":"identity","id":"<account>.<user>"}` precedes the
chunks (not counted in `done.chunks`); without `--signed` the probe sends no
`Agent-Sender` at all — the two modes are exactly "verified" and "absent" at
the receiver. `--signed` without a seed / creds file exits 64. A refused
request surfaces on stderr as `{"type":"error","name":"ServiceError","code":401,…}`.

## Run

```sh
# Build the SDK once, then run a demo. Connection resolution:
#   $NATS_CONTEXT > direct $NATS_URL + credential > localhost
bun install && bun run build

# Terminal 1 — start an agent for the demos to talk to:
bun examples/_run-reference-agent.ts
# (or any host-side example, e.g. ../../agent-sdk/typescript/examples/01-echo.ts)

# Terminal 2 — discover it, then prompt it:
bun examples/01-discover.ts
bun examples/02-prompt-text.ts "say hello in five words"
NATS_CONTEXT=my-context bun examples/02-prompt-text.ts "hello"
# sign prompts from the same credentials used to connect:
NATS_URL=tls://connect.ngs.global NATS_CREDS=./user.creds \
  NATS_SENDER_IDENTITY=signed bun examples/02-prompt-text.ts "hello"

# Focused connection-source/lifecycle tests:
npx vitest run --config examples/_vitest.config.ts
```

## Notes

- **`04-query-reply.ts`** needs an agent whose handler actually asks a mid-stream
  question (`PromptResponse.ask` in `@synadia-ai/agent-service`). The bundled reference agent's echo handler does
  not emit queries, so `04` against it just streams the echo back without hitting
  the interactive path.
- **`_run-client-probe.ts`** is the TypeScript leg of the _reverse_ cross-SDK
  interop test (`agent-sdk/python/tests/test_interop_reverse_e2e.py`): the
  Python host SDK serves an agent, `bun` runs this probe against it, and the
  test asserts on the NDJSON lines (one per decoded chunk, then
  `{"type":"done","chunks":N}`). It honours `NATS_URL` only — never
  `NATS_CONTEXT` — so a test run cannot pick up your selected context.
  `--signed` (with `NATS_NKEY_SEED_FILE`, `NATS_CREDS`, or
  `NATS_CREDENTIALS`) is the signed leg.
- **`06-chat.ts`** reads as a real conversation only against a _stateful_ agent —
  under v0.3 one chat = one session = one subject. The bundled reference agent is
  stateless, so it replies to each turn independently; it's still the simplest
  target to try the REPL on.
