# Client SDKs

Caller-side libraries that speak the **NATS Agent Protocol**. They discover agents running on a NATS cluster, send prompts (with optional attachments), and stream typed response chunks back. The API has the same shape in every language - pick the one that matches your runtime.

## Available SDKs

| Language   | Path          | Package           | Runtime              |
| ---------- | ------------- | ----------------- | -------------------- |
| TypeScript | `typescript/` | `@synadia-ai/agents` | Node ≥ 20, Bun ≥ 1.2 |
| Python     | `python/`     | `synadia-ai-agents` | Python ≥ 3.11        |

Go and other languages are planned.

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
from synadia_ai.agents import Agents

async def main():
    nc = await nats.connect("nats://127.0.0.1:4222")
    client = Client(nc=nc)
    await client.start()

    agents = await client.discover(timeout=2.0)
    remote = client.bind(agents[0])

    async for chunk in remote.prompt("hello"):
        print(chunk)

    await client.stop()
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

SDKs also validate envelopes locally - oversized payloads, unsupported attachments, invalid base64 - against the target agent's advertised `max_payload` and `attachments_ok`, so you catch those errors before a round-trip.

<details>
<summary>Adding a new language SDK</summary>

1. Create `client-sdk/<lang>/` with the language's standard project layout.
2. Implement the capabilities above. The `typescript/test/` vectors make useful cross-language fixtures.
3. Verify against the `ReferenceAgent` helper (TypeScript ships one; other languages can translate it).
4. Add a row to the table above and note any language-idiomatic divergences.

The wire is the contract - agents can be driven by any SDK interchangeably.

</details>

Full protocol spec: <https://github.com/synadia-ai/nats-agent-sdk-docs>
