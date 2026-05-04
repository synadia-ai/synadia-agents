# Synadia Agents

**SDKs and ready-to-run agent plugins for the [NATS Agent Protocol](https://github.com/synadia-ai/nats-agent-sdk-docs).**

The NATS Agent Protocol lets any AI agent — Claude Code, OpenClaw, PI, Hermes, or your own — register itself as a NATS micro service named `agents`, and be discovered, prompted, and streamed from by any caller speaking the same wire format. This repo is the home of the official **caller** and **host** SDKs (TypeScript and Python — see [SDKs](#sdks) below), plus pre-built channel plugins that put popular AI harnesses on NATS without writing code.

## Get started — pick your path

| You want to… | Go to | Install |
| --- | --- | --- |
| **Put an existing AI agent on NATS** (Claude Code, OpenClaw, PI, Hermes, DSPy ReAct) | [`agents/`](agents/) — pick the agent | per-agent README |
| **Build a caller** that discovers and prompts agents | [`client-sdk/typescript/`](client-sdk/typescript/) · [`client-sdk/python/`](client-sdk/python/) | `npm i @synadia-ai/agents` · `pip install synadia-ai-agents` |
| **Host a brand-new agent** built from scratch | [`agent-sdk/typescript/`](agent-sdk/typescript/) · [`agent-sdk/python/`](agent-sdk/python/) | `npm i @synadia-ai/agent-service` · `pip install synadia-ai-agent-service` |

## Agents

Pre-built channel plugins that put existing AI harnesses on NATS. Each registers as an `agents` micro service and serves the protocol's `prompt`, `status`, and `hb` endpoints out of the box.

| Agent | Token | Package |
| --- | --- | --- |
| [Claude Code](agents/claude-code/) | `cc` | `claude-channel-nats` |
| [OpenClaw](agents/openclaw/) | `oc` | `@synadia-ai/nats-channel` |
| [PI Agent](agents/pi/) | `pi` | `@synadia-ai/nats-pi-channel` |
| [Hermes](agents/hermes/) | `hermes` | upstream fork (work in progress) |
| [open-agent](agents/open-agent/) | `open-agent` | inbound bridge for [`vercel-labs/open-agents`](https://github.com/vercel-labs/open-agents); LocalSandbox + companion [`examples/open-agent-vercel/`](examples/open-agent-vercel/) |
| [DSPy ReAct](examples/dspy/) | `dspy` | example, not published |

Subjects follow a verb-first pattern: `agents.{verb}.{token}.{owner}.{session}` where `verb` is `prompt`, `hb`, or `status`.

## SDKs

Two halves per language. The **caller** SDK (`client-sdk/`) discovers and prompts agents; the **host** SDK (`agent-sdk/`) lets you register and serve one. Caller-only consumers install just the caller package; agent-host authors install both halves of their language's pair.

| Side | Folder | TypeScript | Python |
| --- | --- | --- | --- |
| **Caller** | [`client-sdk/`](client-sdk/) | [`@synadia-ai/agents`](client-sdk/typescript/) | [`synadia-ai-agents`](client-sdk/python/) |
| **Host** | [`agent-sdk/`](agent-sdk/) | [`@synadia-ai/agent-service`](agent-sdk/typescript/) | [`synadia-ai-agent-service`](agent-sdk/python/) |

Both languages stay in lockstep on the wire format, validated by a cross-SDK interop test ([`tests/test_interop_e2e.py`](client-sdk/python/tests/test_interop_e2e.py)) that runs the TS reference agent against the Python client.

## Wire protocol at a glance

```
  caller (SDK)  ──▶  NATS  ──▶  agent host
       ▲                           │
       └─── streamed chunks ───────┘
```

A request is plain UTF-8 text or a JSON envelope `{"prompt": "...", "attachments": [{"filename": "...", "content": "<base64>"}]}`. The agent streams typed JSON chunks on the reply subject — `{"type":"response","data":"..."}` for content, `{"type":"status","data":"ack"}` for keep-alive, `{"type":"query","data":{...}}` for mid-stream questions — and ends with an **empty-body, no-headers** terminator. Errors use the `Nats-Service-Error-Code` header (`400` client, `500` server).

Discovery is standard NATS micro:

```bash
nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s
nats sub 'agents.hb.*.*.*'
```

Full spec: <https://github.com/synadia-ai/nats-agent-sdk-docs>.

## Quickstart

Both snippets use TypeScript and bring their own `NatsConnection` — use `@nats-io/transport-node` for TCP or `wsconnect` from `@nats-io/nats-core` for WebSocket.

### Caller side — discover and prompt an agent

Uses the **caller SDK** ([`client-sdk/typescript/`](client-sdk/typescript/) → `@synadia-ai/agents`).

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

### Host side — serve an agent on NATS

Uses the **host SDK** ([`agent-sdk/typescript/`](agent-sdk/typescript/) → `@synadia-ai/agent-service`). Agent-host authors install both packages — caller types and helpers stay imported from `@synadia-ai/agents`.

```ts
import { connect } from "@nats-io/transport-node";
import { AgentService } from "@synadia-ai/agent-service";

const nc = await connect({ servers: "nats://localhost:4222" });

const service = new AgentService({
  nc,
  agent: "echo", // metadata.agent — canonical harness identifier
  owner: "demo", // metadata.owner — operator / account namespace
  name: "main", // 5th subject token — instance name
  description: "Echo agent demo",
});

service.onPrompt(async (envelope, response) => {
  await response.send(`echo: ${envelope.prompt}`);
});

await service.start();
console.log(`listening on ${service.subject.prompt}`);

// on shutdown:
await service.stop();
await nc.close();
```

For full install, error handling, and longer examples see the per-package READMEs: caller — [`client-sdk/typescript/`](client-sdk/typescript/) · [`client-sdk/python/`](client-sdk/python/); host — [`agent-sdk/typescript/`](agent-sdk/typescript/) · [`agent-sdk/python/`](agent-sdk/python/).

## Examples

End-to-end apps built on the SDKs — controllers that spawn ephemeral agents, a browser test client, a from-scratch DSPy ReAct agent. See [`examples/`](examples/) and its [README](examples/README.md).

## For protocol implementers

Both SDKs ship a **spec-compliant reference agent** that implements the full §12 agent checklist (service registration, prompt endpoint, status endpoint, heartbeats, terminator semantics). When reasoning about wire shape, testing a third SDK, or validating AI/LLM-generated tooling, read these first — they are the authoritative on-the-wire counterpart to the spec.

| SDK | Reference agent | Demo scripts |
| --- | --- | --- |
| TypeScript | [`ReferenceAgent`](agent-sdk/typescript/src/testing/reference-agent.ts) — importable as `@synadia-ai/agent-service/testing`. Runnable: [`_run-reference-agent.ts`](client-sdk/typescript/examples/_run-reference-agent.ts). | [`client-sdk/typescript/examples/`](client-sdk/typescript/examples/) — `01-discover.ts` … `05-liveness.ts`. |
| Python | [`_reference_agent.py`](agent-sdk/python/examples/_reference_agent.py) — runnable echo agent with conversation memory. | [`client-sdk/python/examples/`](client-sdk/python/examples/) — `01-discover.py` … `05-liveness.py`, plus `06-chat.py` (interactive REPL). |

<details>
<summary><strong>Repository layout</strong></summary>

```
synadia-agents/
├── README.md              ← you are here
├── README-DEV.md          ← local-development build / install recipes
├── client-sdk/            ← caller-side language SDKs (discover · prompt · stream)
│   ├── typescript/        ← @synadia-ai/agents
│   └── python/            ← synadia-ai-agents
├── agent-sdk/             ← host-side language SDKs (host an agent)
│   ├── typescript/        ← @synadia-ai/agent-service
│   └── python/            ← synadia-ai-agent-service
├── agents/                ← plugins that put existing AI harnesses on NATS
│   ├── claude-code/
│   ├── openclaw/
│   ├── pi/
│   └── hermes/
└── examples/              ← apps built with the SDKs (callers and agents)
    ├── agent-web-ui/             ← Vue 3 + Bun browser client
    ├── claude-code-headless/     ← spawn/stop many Claude Code sessions
    ├── pi-headless/              ← spawn/stop many PI sessions
    └── dspy/                     ← standalone agent built from scratch (ax-llm ReAct)
```

Each subtree has its own `README.md` and the index READMEs (`client-sdk/README.md`, `agent-sdk/README.md`, `agents/README.md`, `examples/README.md`) describe what lives at each level. See [`README-DEV.md`](README-DEV.md) for local-dev build and install recipes.

</details>

## License

Apache-2.0 across this monorepo — see each package's `LICENSE` file.
