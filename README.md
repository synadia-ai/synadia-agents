# Synadia Agents

One home for everything built on the **NATS Agent Protocol** — the SDKs that speak it, the agent implementations that host it, and the example apps that use it.

- **Protocol version tracked:** `0.2.0-draft`
- **Core idea:** every AI agent (Claude Code, OpenClaw, PI, reference agents, …) registers as a NATS micro service named `agents`. Callers discover, prompt, and stream from it using any language's SDK. Same wire format everywhere.
- **Why a monorepo:** when the protocol or SDK changes, agents and examples update in one place in the same commit.

## Repository layout

```
synadia-agents/
├── README.md              ← you are here
├── client-sdk/            ← language SDKs (callers)
│   ├── README.md
│   ├── typescript/        ← @synadia/agents (TypeScript/Node/Bun)
│   └── python/            ← natsagent (Python ≥ 3.11)
├── agents/                ← protocol-compliant agent hosts
│   ├── README.md
│   ├── pi/                ← PI Agent channel
│   ├── openclaw/          ← OpenClaw plugin
│   ├── claude-code/       ← Claude Code MCP plugin
│   └── dspy/              ← ax-llm (DSPy-style) ReAct agent
└── examples/              ← apps that use the SDK
    ├── README.md
    └── agent-web-ui/      ← Vue 3 + Bun browser client
```

Each subtree keeps its own `README.md`, `package.json`, and tests. The index READMEs (`client-sdk/README.md`, `agents/README.md`, `examples/README.md`) describe what lives at each level.

## Subject namespace

All agents expose the same subject pattern:

```
agents.<type-token>.<owner>.<session>             # prompt endpoint
agents.<type-token>.<owner>.<session>.heartbeat   # liveness beacon (30 s)
```

Type tokens currently in this repo:

| Token  | Host                 | Path                  |
| ------ | -------------------- | --------------------- |
| `pi`   | PI Agent             | `agents/pi/`          |
| `oc`   | OpenClaw             | `agents/openclaw/`    |
| `ccc`  | Claude Code          | `agents/claude-code/` |
| `dspy` | ax-llm ReAct (DSPy)  | `agents/dspy/`        |

Discovery is standard NATS micro:

```bash
nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s
nats micro ls
nats sub 'agents.*.*.*.heartbeat'
```

## Wire protocol (one-paragraph summary)

A request is either plain UTF-8 text or a JSON envelope `{"prompt": "...", "attachments": [{"filename": "...", "content": "<RFC 4648 §4 base64>"}]}`. The agent streams typed JSON chunks on the reply subject — `{"type":"response","data":"..."}` for content, `{"type":"status","data":"ack"}` for keep-alive, `{"type":"query","data":{...}}` for mid-stream questions. An **empty body with no headers** ends the stream. Errors use the `Nats-Service-Error-Code` header (`400` for client errors, `500` for server).

Full spec: <https://github.com/synadia-ai/nats-agent-sdk-docs> (external).

## How the pieces fit

```
  caller (SDK)  ──▶  NATS  ──▶  agent host (pi / oc / ccc)
       ▲                                   │
       └─── streamed response chunks ──────┘
```

- **`client-sdk/*`** — produce envelopes, validate locally against agent metadata (`max_payload`, `attachments_ok`), parse streamed chunks.
- **`agents/*`** — register the `agents` micro service, accept envelopes, drive the underlying AI harness, stream chunks back.
- **`examples/*`** — demonstrate SDK usage end-to-end against real agents.

## Quickstart (TypeScript)

```ts
import { connect } from "@synadia/agents";

const client = await connect({ name: "demo", context: "current" });
const [agent] = await client.discover({ timeoutMs: 2_000 });

for await (const msg of await client.bind(agent!).prompt("hello")) {
  if (msg.type === "response") process.stdout.write(msg.text);
}

await client.close();
```

See `client-sdk/typescript/README.md` for install, error handling, and full examples.

## Status

Pre-1.0. The protocol is `0.2.0-draft`; SDK and agent APIs may shift until `1.0`.

## License

Apache-2.0 for the SDK, MIT for the agent channels and examples — see each subtree's `LICENSE` file.
