# Synadia.AI.Agents

Call AI agents over NATS from .NET: discover them, stream their answers, and answer their questions mid-stream. Use it
to reach agents that speak the [Synadia Agent Protocol](https://github.com/synadia-ai/synadia-agent-sdk-docs), in any
language, and to use them as a Microsoft.Extensions.AI `IChatClient`.

> Preview — APIs may change before 1.0.

```shell
dotnet add package Synadia.AI.Agents --prerelease
```

## Requirements

- .NET 8 or .NET 10.
- A NATS server (`nats-server`) with at least one agent on it. To try it out, run the
  [reference agent](https://github.com/synadia-ai/synadia-agents/blob/main/agent-sdk/dotnet/examples/run-reference-agent.cs).

## Quick start

```csharp
using NATS.Client.Core;
using Synadia.AI.Agents;

await using var nats = new NatsConnection(new NatsOpts { Url = "nats://127.0.0.1:4222" });
await using var agents = new AgentsClient(nats);

var agent = (await agents.DiscoverAsync(new AgentFilter { Agent = "demo-agent" }))[0];
await foreach (var chunk in agent.PromptAsync("hello"))
{
    if (chunk is AgentResponseChunk response) Console.WriteLine(response.Text);
}
```

Against the reference agent, this prints:

```text
echo: hello
```

## Use an agent as an `IChatClient`

```csharp
using Microsoft.Extensions.AI;

IChatClient chat = agent.AsIChatClient();
ChatResponse reply = await chat.GetResponseAsync("What can you do?");
Console.WriteLine(reply.Text);
```

Only the newest user message is sent. The agent keeps the conversation. To keep separate conversations with one agent,
set `ChatOptions.ConversationId`; the agent receives it as the `session_id` extra.

## Answer a question from the agent

An agent can stop mid-stream and ask the caller something. Reply in the same loop:

```csharp
await foreach (var chunk in agent.PromptAsync("ask Which city?"))
{
    switch (chunk)
    {
        case AgentQueryChunk query: await query.ReplyAsync("Lisbon"); break;
        case AgentResponseChunk response: Console.WriteLine(response.Text); break;
    }
}
// you answered: Lisbon
```

Through `IChatClient`, set `AgentChatClientOptions.QueryHandler`, or handle the `AgentQueryContent` that the stream
yields and call its `ReplyAsync`.

## Send files

Attachments are Microsoft.Extensions.AI `DataContent`:

```csharp
DataContent file = await PromptEnvelope.AttachmentFromFileAsync("report.pdf");
await foreach (var chunk in agent.PromptAsync(new PromptEnvelope("Summarize this.", [file]))) { /* … */ }
```

The SDK checks the agent's advertised limits first. It throws `AttachmentsNotSupportedException` or
`PayloadTooLargeException` instead of sending a prompt the agent would reject.

## `AsIChatClient` options

| Option | Default | Effect |
| --- | --- | --- |
| `QueryHandler` | `null` | Answers agent questions. Without it, questions surface as `AgentQueryContent`. |
| `IncludeStatus` | `true` | Surfaces status chunks as `AgentStatusContent`. |
| `PromptOptions` | `null` | Per-prompt settings: `MaxWait`, `InactivityTimeout`, headers. |

## Learn more

- [Protocol specification](https://github.com/synadia-ai/synadia-agent-sdk-docs)
- [SDK guide and protocol mapping](https://github.com/synadia-ai/synadia-agents/tree/main/client-sdk/dotnet)
- [Examples](https://github.com/synadia-ai/synadia-agents/tree/main/client-sdk/dotnet/examples)
- Host agents with [Synadia.AI.Agents.Service](https://www.nuget.org/packages/Synadia.AI.Agents.Service).
