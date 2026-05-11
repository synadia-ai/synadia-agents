# Host SDKs

Server-side libraries that **host** agents speaking the **Synadia Agent Protocol for NATS**. They register the `agents` micro service, advertise the prompt + status endpoints, run the heartbeat loop, and stream typed chunks back. The API has the same shape in every language - pick the one that matches your runtime.

Pairs with [`../client-sdk/`](../client-sdk/) (the caller-side libraries that discover and prompt agents). Most consumers want only the caller side; if you're writing a new agent or wrapping an existing AI harness in NATS, you want both.

## Available SDKs

| Language   | Path          | Package                       | Runtime              |
| ---------- | ------------- | ----------------------------- | -------------------- |
| TypeScript | `typescript/` | `@synadia-ai/agent-service`   | Node ≥ 20, Bun ≥ 1.2 |
| Python     | `python/`     | `synadia-ai-agent-service`    | Python ≥ 3.11        |

Each SDK depends on its sibling caller package (`@synadia-ai/agents` / `synadia-ai-agents`) for the wire types and shared building blocks. Install both:

```sh
# TypeScript
npm install @synadia-ai/agents @synadia-ai/agent-service

# Python
pip install synadia-ai-agents synadia-ai-agent-service
```

The two packages release in lockstep — pinning matching versions is the safest path.

## Quickstart

**TypeScript**

```ts
import { connect } from "@nats-io/transport-node";
import { AgentService } from "@synadia-ai/agent-service";

const nc = await connect({ servers: "nats://localhost:4222" });
const service = new AgentService({
  nc,
  agent: "echo",
  owner: "demo",
  name: "main",
});
service.onPrompt(async (envelope, response) => {
  await response.send(`echo: ${envelope.prompt}`);
});
await service.start();
console.log(`listening on ${service.subject.prompt}`);
```

`AgentService` handles registration, the `prompt` and `status` endpoints, the heartbeat loop, the per-request keep-alive ack, the §6.5 stream terminator, and translates handler exceptions into 500s.

**Python**

```python
import asyncio, nats
from synadia_ai.agent_service import AgentService

async def main():
    nc = await nats.connect("nats://127.0.0.1:4222")
    svc = AgentService(nc=nc, agent="echo", owner="demo", name="main")

    @svc.on_prompt
    async def handle(envelope, response):
        await response.send(f"echo: {envelope.prompt}")

    await svc.start()
    print(f"listening on {svc.subject.prompt}")
    await asyncio.Event().wait()  # keep alive

asyncio.run(main())
```

Each SDK's README covers options (`extraEndpoints`, `maxPayload`, `heartbeatIntervalS`, …), the `ReferenceAgent` test helper, and longer examples:

- [`typescript/README.md`](typescript/README.md)
- [`python/README.md`](python/README.md)

## What an agent SDK gives you

Same concepts in each language; names adapt to each language's idioms.

| Capability               | Purpose                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| Register a service       | Stand up the `agents` micro service with the right metadata and queue group.              |
| Serve `prompt`           | Decode the §5.1 envelope, drive your handler, stream typed chunks back, emit terminator.  |
| Serve `status`           | Reply with the §8.7 (v0.3) heartbeat-shaped payload on demand.                            |
| Publish heartbeats       | Beacon liveness on `agents.hb.<agent>.<owner>.<name>` at the configured cadence.          |
| Per-request keep-alive   | Emit `{type:"status",data:"ack"}` chunks while a slow handler runs (§6.6 / §6.4).         |
| Custom endpoints         | Register `spawn` / `stop` / `list` etc. alongside `prompt` (TS: `extraEndpoints`).        |
| Reference agent          | Spec-compliant counterparty for tests and interop checks.                                 |

The SDKs also share the wire helpers — `encodeChunk`, `splitResponseText`, `buildHeartbeatPayload` — so a hand-rolled harness that doesn't fit the closed-handler shape (e.g. event-driven streaming agents) can use the primitives directly without re-implementing the wire format.

## Reference agents

Both host SDKs ship a **`ReferenceAgent`** that implements the full §12 agent checklist. Use it as a counterparty in your test suite — it's the canonical source of truth for what spec-compliant on-the-wire behaviour looks like. The TypeScript reference agent is exposed via the `@synadia-ai/agent-service/testing` subpath; the Python one ships as `examples/_reference_agent.py` next to its parent SDK.

The numbered demo scripts in `client-sdk/<lang>/examples/` exercise both halves together: the demos drive a running `ReferenceAgent` to cover discover, prompt, attachments, mid-stream queries, and liveness end-to-end.

<details>
<summary>Adding a new language SDK</summary>

1. Create `agent-sdk/<lang>/` mirroring the layout of an existing one.
2. Implement the capabilities above. The TypeScript and Python `AgentService` classes are the canonical references for surface area and behaviour.
3. Verify against an existing `ReferenceAgent` from another language, and add a `ReferenceAgent` of your own to the SDK's testing surface.
4. Add a row to the table above.

The wire is the contract — agents written with any host SDK can be driven by any caller SDK interchangeably.

</details>

Full protocol spec: <https://github.com/synadia-ai/nats-agent-sdk-docs>
