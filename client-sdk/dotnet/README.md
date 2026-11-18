# Synadia.AI.Agents (.NET caller SDK)

Caller-side .NET SDK for the [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs)
(wire protocol **v0.3**): discover agents, stream prompts, answer mid-stream queries, watch liveness — and plug any
NATS agent into the [Microsoft.Extensions.AI](https://learn.microsoft.com/dotnet/ai/microsoft-extensions-ai)
ecosystem as an `IChatClient`.

The host side (serve an agent, including any `IChatClient`) lives in
[`agent-sdk/dotnet`](../../agent-sdk/dotnet/) (`Synadia.AI.Agents.Service`).

> Status: preview (`0.1.0-preview.1`), fork-only — not published to NuGet.

## Design: protocol-faithful core, MEAI-native at the seams

- **Dependencies:** `NATS.Client.Core` / `NATS.Client.Services` 3.x, `NATS.NKeys`, and
  `Microsoft.Extensions.AI.Abstractions` 11.x (GA). Nothing from `Microsoft.Agents.AI.*`, and no `[Experimental]`
  MEAI APIs.
- **Core types:** `AgentChunk` (`AgentResponseChunk`, `AgentStatusChunk`, `AgentQueryChunk`) and `PromptEnvelope`
  map 1:1 to the wire. Use them when you care about the protocol.
- **Attachments are `DataContent`.** You can pass an MEAI attachment straight through, and received attachments come
  back as MEAI content.
- **`Agent.AsIChatClient()`** returns an `IChatClient` that MEAI middleware or Agent Framework can drive. Status chunks
  arrive as `AgentStatusContent`. Mid-stream queries arrive as `AgentQueryContent`, which derives from GA
  `InputRequestContent` and has `ReplyAsync`.
- **`AgentTools.AsAITools()`** gives a model six `AIFunction`s (`discover_agents`, `prompt_agent`, `answer_agent`,
  `wait_agent`, `cancel_agent`, `list_agent_calls`). Their JSON schemas are the shared
  `test-fixtures/agent-tools/*.json`, verbatim.
- **Target frameworks:** net8.0 and net10.0. The library is AOT/trim compatible and uses source-generated
  System.Text.Json for wire JSON.

## Quickstart

```csharp
using NATS.Client.Core;
using Synadia.AI.Agents;

await using var nc = new NatsConnection(new NatsOpts { Url = "nats://127.0.0.1:4222" });
await using var agents = new AgentsClient(nc);

var agent = (await agents.DiscoverAsync(new AgentFilter { Agent = "demo-agent" }))[0];

await foreach (var chunk in agent.PromptAsync("hello"))
{
    switch (chunk)
    {
        case AgentResponseChunk r: Console.Write(r.Text); break;
        case AgentStatusChunk s:   Console.Error.WriteLine($"[{s.Status}]"); break;
        case AgentQueryChunk q:    await q.ReplyAsync("yes"); break;   // §7 mid-stream query
    }
}
```

### Attachments (`DataContent`)

```csharp
var file = await PromptEnvelope.AttachmentFromFileAsync("report.pdf");   // DataContent with Name + MediaType
await foreach (var chunk in agent.PromptAsync(new PromptEnvelope("summarize", [file]))) { ... }
```

Before publishing, the SDK runs the §5.4 checks against what the agent advertises:

- `attachments_ok=false` throws `AttachmentsNotSupportedException`.
- An envelope plus headers larger than `max_payload` throws `PayloadTooLargeException`.

### As an `IChatClient`

```csharp
using Microsoft.Extensions.AI;

IChatClient chat = agent.AsIChatClient(new AgentChatClientOptions
{
    QueryHandler = (query, ct) => ValueTask.FromResult<string?>("yes"),   // or surface AgentQueryContent yourself
});
var response = await chat.GetResponseAsync("What can you do?");
```

- **Only the newest user message is sent.** The agent owns the conversation; `ConversationId` is the agent's prompt
  subject.
- **Attachments:** `DataContent` in that message becomes envelope attachments.
- **Without a `QueryHandler`:** queries are yielded as `AgentQueryContent`; reply with `content.ReplyAsync(...)`.

### Let a model call other agents (`AgentTools`)

```csharp
await using var tools = new AgentTools(agents);
var options = new ChatOptions { Tools = [.. tools.AsAITools()] };
// Any IChatClient that invokes functions (e.g. .UseFunctionInvocation()) can now discover and prompt agents.
```

This is a port of the TS/Python agent-tools helper. The contract is in
[`docs/agent-tools.md`](../../docs/agent-tools.md), covering:

- detached calls with `wait_agent`;
- `answer_agent` for an agent's questions;
- per-prompt call scopes;
- saving returned attachments under `AttachmentRoots`.

`discover_agents` reports each agent's `identity` (`{account}.{user}` from its metadata) and `identity_verified`
(the agent's `id_sig` checks out).

### Sender identity (§13)

```csharp
using Synadia.AI.Agents.Identity;

await using var signed = new AgentsClient(nc, new AgentsClientOptions
{
    Identity = new SenderIdentityOptions { Signer = SenderSigner.FromCredsFile("me.creds"), Name = "my-app" },
});
Console.WriteLine(await signed.GetSelfIdAsync());   // {account}.{user}, via $SYS.REQ.USER.INFO
```

Every prompt then carries a signed `Agent-Sender` header, which agents with `min_sender_trust=signed` require.
`PromptOptions.Sub` adds a per-prompt subject claim. An empty prompt throws `PromptEmptyException` before anything is
sent.

## Examples

These are .NET 10 file-based apps in [`examples/`](examples/), mirroring the TS and Python numbered demos. Start any
agent first. Two options:

- `dotnet run ../../agent-sdk/dotnet/examples/run-reference-agent.cs`;
- the TS `_run-reference-agent.ts`.

| Script | What it does |
| --- | --- |
| `01-discover.cs` | Enumerate agents (`$SRV.INFO.agents`) and print identity + capabilities. |
| `02-prompt-text.cs` | Stream a text prompt to the first agent. |
| `03-prompt-attachment.cs` | Prompt with a file attached (`DataContent`), with §5.4 validation. |
| `04-query-reply.cs` | Answer an agent's mid-stream queries from the console. |
| `05-liveness.cs` | Heartbeat listener plus a periodic liveness snapshot. |
| `06-chat.cs` | Multi-turn REPL through `Agent.AsIChatClient()` (MEAI). |

```sh
cd client-sdk/dotnet/examples
dotnet run 01-discover.cs
dotnet run 02-prompt-text.cs -- "say hello in five words"
dotnet run 04-query-reply.cs -- "ask what is your name?"
```

`NATS_URL` picks the server; the default is `nats://127.0.0.1:4222`.

## Build and test

```sh
cd client-sdk/dotnet
dotnet test                 # unit tests: wire format, fixtures (identity vectors, agent-tools schemas, attachments)
cd ../../agent-sdk/dotnet
dotnet test                 # end-to-end against a real nats-server, plus TS interop
```

The end-to-end tests start `nats-server` from `PATH` on a random free port.

The TS interop tests need `bun`, plus the TS SDKs installed and built: run `bun install && bun run build` in
`client-sdk/typescript` and in `agent-sdk/typescript`. Without them, the tests print a `SKIPPED:` note and pass.

### Python interop (manual check)

Python ↔ .NET is not in the automated suite. It was checked by hand against the local editable installs:

```sh
python -m venv .venv && .venv/Scripts/python -m pip install -e client-sdk/python -e agent-sdk/python
```

Both directions passed on one `nats-server`:

- **.NET caller → Python agent** (`agent-sdk/python/examples/_reference_agent.py`). These all worked:
  - `01-discover.cs`: protocol v0.3, `Compatible`.
  - `06-chat.cs`, which uses `AsIChatClient`: a two-turn chat, with history kept on the agent side.
  - `03-prompt-attachment.cs`: the agent echoed the attachment's filename.
- **Python caller → .NET agent** (`run-reference-agent.cs`). These all worked:
  - `01-discover.py`.
  - `02-prompt-text.py`.
  - `03-prompt-attachment.py`: an attachment round trip.
  - `04-query-reply.py`: a mid-stream query and reply, with the prompt `ask …`.
- **Python caller → .NET Ollama agent** (`06-approvals.cs`, formerly `ollama-agent.cs`). `02-prompt-text.py` streamed the model's answer.

On Windows, the Python reference agent stops at startup: `loop.add_signal_handler` raises `NotImplementedError`. Run it on
Linux or macOS, or through a wrapper that replaces `asyncio.BaseEventLoop.add_signal_handler` with a no-op.

## Documentation

- [`docs/protocol-mapping.md`](docs/protocol-mapping.md) maps spec sections to .NET types. It also covers the MEAI
  seams, the divergences from TS/Python, and the findings of the MEAI API spike.
- [`CHANGELOG.md`](CHANGELOG.md).
