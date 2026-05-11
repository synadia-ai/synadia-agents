# Client SDKs

Caller-side libraries that speak the **Synadia Agent Protocol for NATS**. They discover agents running on a NATS cluster, send prompts (with optional attachments), and stream typed response chunks back. The API has the same shape in every language - pick the one that matches your runtime.

## Available SDKs

| Language   | Path          | Package           | Runtime              |
| ---------- | ------------- | ----------------- | -------------------- |
| TypeScript | `typescript/` | `@synadia-ai/agents` | Node ≥ 20, Bun ≥ 1.2 |
| Python     | `python/`     | `synadia-ai-agents` | Python ≥ 3.11        |

Go and other languages are planned.

> **Hosting an agent?** The server-side counterparts —
> `@synadia-ai/agent-service` (TypeScript), `synadia-ai-agent-service`
> (Python) — live next door at [`../agent-sdk/`](../agent-sdk/). Caller-only
> consumers (browser test clients, scripts that prompt existing agents)
> need only the packages on this page; agent harness authors install
> both halves of their language's pair.

## Quickstart

**TypeScript**

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

**Python**

```python
import asyncio, nats
from synadia_ai.agents import Agents, ResponseChunk

async def main():
    nc = await nats.connect("nats://127.0.0.1:4222")
    agents = Agents(nc=nc)

    [agent] = await agents.discover()
    async for msg in agent.prompt("hello"):
        if isinstance(msg, ResponseChunk):
            print(msg.text, end="")

    await agents.close()
    await nc.close()

asyncio.run(main())
```

Each SDK's README covers install, options, error handling, and longer examples:

- [`typescript/README.md`](typescript/README.md)
- [`python/README.md`](python/README.md)

## What an SDK gives you

Same concepts in each language; names adapt to each language's idioms.

| Capability       | Purpose                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------- |
| Create a client  | Wire up a NATS connection and get a ready-to-use client.                                    |
| Discover agents  | Enumerate running agents on the cluster. Subscribe-before-ping is handled for you.          |
| Bind to an agent | Wrap a discovered agent descriptor for subsequent calls.                                    |
| Prompt an agent  | Send a prompt, receive an async iterable over typed chunks (`response`, `status`, `query`). |
| Track liveness   | Watch an agent's heartbeat subject for up/down state without polling.                       |
| Ping an agent    | On-demand ping of a specific agent instance.                                                |

SDKs also validate envelopes locally - oversized payloads, unsupported attachments, invalid base64 - against the target agent's advertised `max_payload` and `attachments_ok`, so you catch those errors before a round-trip. The size check uses the smaller of the agent's advertised `max_payload` and the caller's own `nc.info.max_payload`, so a caller against a smaller-cap broker (multi-cluster / per-account configs) fails fast instead of waiting for the broker's `MAX_PAYLOAD_VIOLATION`.

<details>
<summary>Adding a new language SDK</summary>

1. Create `client-sdk/<lang>/` with the language's standard project layout.
2. Implement the capabilities above. The `typescript/test/` vectors make useful cross-language fixtures.
3. Verify against the host-side `ReferenceAgent` (TypeScript ships one in [`agent-sdk/typescript/`](../agent-sdk/typescript/), exposed via `@synadia-ai/agent-service/testing`; other languages can translate it).
4. Add a row to the table above and note any language-idiomatic divergences.

The wire is the contract - agents can be driven by any SDK interchangeably.

</details>

Full protocol spec: <https://github.com/synadia-ai/nats-agent-sdk-docs>
