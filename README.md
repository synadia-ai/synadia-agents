# Synadia Agents

One home for everything built on the **NATS Agent Protocol** — the SDKs that speak it, the agent implementations that host it, and the example apps that use it.

Every AI agent in this repo (Claude Code, OpenClaw, PI, DSPy-ReAct, …) registers as a NATS micro service named `agents`. Callers discover, prompt, and stream from it using any language's SDK — same wire format everywhere.

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

Each subtree has its own `README.md`. The index READMEs (`client-sdk/README.md`, `agents/README.md`, `examples/README.md`) describe what lives at each level.

## Subject namespace

The protocol only requires an endpoint named `prompt` — the subject it's served on is up to each agent. Across this repo we follow a single convention:

```
agents.<type-token>.<owner>.<session>             # prompt endpoint
agents.<type-token>.<owner>.<session>.heartbeat   # liveness beacon
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

## Wire protocol

A request is either plain UTF-8 text or a JSON envelope `{"prompt": "...", "attachments": [{"filename": "...", "content": "<base64>"}]}`. The agent streams typed JSON chunks on the reply subject — `{"type":"response","data":"..."}` for content, `{"type":"status","data":"ack"}` for keep-alive, `{"type":"query","data":{...}}` for mid-stream questions. An **empty body with no headers** ends the stream. Errors use the `Nats-Service-Error-Code` header (`400` client, `500` server).

Full spec: <https://github.com/synadia-ai/nats-agent-sdk-docs>

## How the pieces fit

```
  caller (SDK)  ──▶  NATS  ──▶  agent host
       ▲                           │
       └─── streamed chunks ───────┘
```

- **`client-sdk/*`** — produce envelopes, validate locally against agent metadata (`max_payload`, `attachments_ok`), parse streamed chunks.
- **`agents/*`** — register the `agents` micro service, drive the underlying AI harness, stream chunks back.
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

See `client-sdk/typescript/README.md` for install, error handling, and full examples. For Python, see `client-sdk/python/README.md`.

## License

Apache-2.0 for the SDK, MIT for the agent channels and examples — see each subtree's `LICENSE` file.
