# Synadia Agents

One home for everything built on the **NATS Agent Protocol** - the SDKs that speak it, the agent implementations that host it, and the example apps that use it.

Every AI agent in this repo (Claude Code, OpenClaw, PI, DSPy-ReAct, …) registers as a NATS micro service named `agents`. Callers discover, prompt, and stream from it using any language's SDK - same wire format everywhere.

The two TypeScript SDKs, the OpenClaw and PI channel plugins, and three runnable examples ship to npm under the **`@synadia-ai/*`** scope — see each package's `package.json` for its published identity.

## Repository layout

```
synadia-agents/
├── README.md              ← you are here
├── README-DEV.md          ← local-development build / install recipes
├── client-sdk/            ← caller-side language SDKs (discover · prompt · stream)
│   ├── README.md
│   ├── typescript/        ← @synadia-ai/agents (TypeScript/Node/Bun)
│   └── python/            ← synadia-ai-agents (Python ≥ 3.11)
├── agent-sdk/             ← host-side language SDKs (host an agent)
│   ├── README.md
│   ├── typescript/        ← @synadia-ai/agent-service (TypeScript/Node/Bun)
│   └── python/            ← synadia-ai-agent-service (Python ≥ 3.11)
├── agents/                ← plugins that put existing AI harnesses on NATS
│   ├── README.md
│   ├── hermes/            ← Hermes Agent NATS gateway 
│   ├── pi/                ← PI Agent channel
│   ├── openclaw/          ← OpenClaw plugin
│   └── claude-code/       ← Claude Code MCP plugin
└── examples/              ← apps built with the SDKs (callers and agents)
    ├── README.md
    ├── agent-web-ui/             ← Vue 3 + Bun browser client
    ├── claude-code-headless/     ← spawn/stop many Claude Code sessions, each as its own NATS agent
    ├── dspy/                     ← standalone agent built from scratch with the SDKs (ax-llm ReAct)
    └── pi-headless/              ← spawn/stop many PI sessions, each as its own NATS agent
```

Each subtree has its own `README.md`. The index READMEs (`client-sdk/README.md`, `agent-sdk/README.md`, `agents/README.md`, `examples/README.md`) describe what lives at each level.

The TypeScript SDK is split across two packages — `@synadia-ai/agents` for callers and `@synadia-ai/agent-service` for hosts — both versioned in lockstep. The Python side mirrors the same split (`synadia-ai-agents` + `synadia-ai-agent-service`). Caller-only consumers install just the caller package; agent harness authors install both halves of their language's pair. See [`README-DEV.md`](README-DEV.md) for the local-dev build / install recipes.

## Reference agents and demo scripts

Both SDKs ship a **spec-compliant reference agent** plus a parallel set of numbered demo scripts. The reference agent is the canonical implementation of every §12 agent-checklist requirement — registration, heartbeats, status endpoint, stream-terminator semantics. Third-party SDKs and AI/LLM-generated tooling should test against it. The numbered demos are the fastest way to exercise either SDK end-to-end.

| SDK | Reference agent | Demo scripts |
| --- | --- | --- |
| TypeScript | `ReferenceAgent` class — [`agent-sdk/typescript/src/testing/reference-agent.ts`](agent-sdk/typescript/src/testing/reference-agent.ts), importable as `@synadia-ai/agent-service/testing`. Runnable script: [`client-sdk/typescript/examples/_run-reference-agent.ts`](client-sdk/typescript/examples/_run-reference-agent.ts). | [`client-sdk/typescript/examples/`](client-sdk/typescript/examples/) — `01-discover.ts`, `02-prompt-text.ts`, `03-prompt-attachment.ts`, `04-query-reply.ts`, `05-liveness.ts`. |
| Python | Runnable echo agent (with conversation memory) — [`client-sdk/python/examples/_reference_agent.py`](client-sdk/python/examples/_reference_agent.py). | [`client-sdk/python/examples/`](client-sdk/python/examples/) — `01-discover.py` through `05-liveness.py`, plus `06-chat.py` (interactive REPL). See the [examples README](client-sdk/python/examples/README.md). |

The Python side also has [`tests/test_interop_e2e.py`](client-sdk/python/tests/test_interop_e2e.py), which runs the TS reference agent as a subprocess and validates wire compatibility between the two SDKs.

For larger end-to-end examples — controllers that spawn ephemeral agents, a browser test client, a from-scratch DSPy ReAct agent — see [`examples/`](examples/) and its [README](examples/README.md).

## Subject namespace

The protocol only requires an endpoint named `prompt` - the subject it's served on is up to each agent. For the agents in this repo we've chosen a single verb-first pattern (v0.3):

```
agents.prompt.<type-token>.<owner>.<session>      # prompt endpoint
agents.hb.<type-token>.<owner>.<session>          # liveness beacon (verb is the abbreviation `hb`)
agents.status.<type-token>.<owner>.<session>      # status request/response (replies with the same payload as a heartbeat)
```

Type tokens currently in this repo:

| Token     | Host                 | Path                  |
| ----------| -------------------- | --------------------- |
| `pi`      | PI Agent             | `agents/pi/`          |
| `oc`      | OpenClaw             | `agents/openclaw/`    |
| `cc`      | Claude Code          | `agents/claude-code/` |
| `hermes`  | Hermes Agent         | `agents/hermes/`      |
| `dspy`    | ax-llm ReAct (DSPy)  | `examples/dspy/`      |

Discovery is standard NATS micro:

```bash
nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s
nats micro ls
nats sub 'agents.hb.*.*.*'
```

## Wire protocol

A request is either plain UTF-8 text or a JSON envelope `{"prompt": "...", "attachments": [{"filename": "...", "content": "<base64>"}]}`. The agent streams typed JSON chunks on the reply subject - `{"type":"response","data":"..."}` for content, `{"type":"status","data":"ack"}` for keep-alive, `{"type":"query","data":{...}}` for mid-stream questions. An **empty body with no headers** ends the stream. Errors use the `Nats-Service-Error-Code` header (`400` client, `500` server).

Full spec: <https://github.com/synadia-ai/nats-agent-sdk-docs>

## How the pieces fit

```
  caller (SDK)  ──▶  NATS  ──▶  agent host
       ▲                           │
       └─── streamed chunks ───────┘
```

- **`client-sdk/*`** (caller side) - produce envelopes, validate locally against agent metadata (`max_payload`, `attachments_ok`) and the caller's own `nc.info.max_payload` (the smaller of the two binds — the caller's broker rejects oversized publishes before they reach the agent), parse streamed chunks.
- **`agent-sdk/*`** (host side) - register the `agents` micro service, run the heartbeat loop, decode envelopes, stream typed chunks back, emit the §6.5 stream terminator. Built on top of `client-sdk/*` (which owns the wire types).
- **`agents/*`** - thin plugins that wrap an existing AI harness and call into the host SDK to expose it on NATS.
- **`examples/*`** - demonstrate end-to-end usage against real agents (callers, controllers, and agent hosts built from scratch).

## Quickstart (TypeScript)

You bring a `NatsConnection`; the SDK uses it. Use `@nats-io/transport-node` for TCP or `wsconnect` from `@nats-io/nats-core` for WebSocket.

```ts
import { connect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const nc = await connect({ servers: "nats://localhost:4222" });
const agents = new Agents({ nc });

const [agent] = await agents.discover();

for await (const msg of await agent!.prompt("hello")) {
  if (msg.type === "response") process.stdout.write(msg.text);
}

await agents.close();
await nc.close();
```

See `client-sdk/typescript/README.md` for caller-side install, error handling, and full examples. To host an agent (register the service, run the heartbeat loop, stream typed chunks back), see `agent-sdk/typescript/README.md` — install both packages and use `AgentService`. For Python, see `client-sdk/python/README.md` and `agent-sdk/python/README.md`.

## License

Apache-2.0 across this monorepo - see each package's `LICENSE` file.
