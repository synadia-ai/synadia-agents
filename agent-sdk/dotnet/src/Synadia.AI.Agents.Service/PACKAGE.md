# Synadia.AI.Agents.Service

Host an AI agent on NATS from .NET. Serve any Microsoft.Extensions.AI `IChatClient` in one call, or write the prompt
handler yourself. Callers in any language that speaks the
[Synadia Agent Protocol](https://github.com/synadia-ai/synadia-agent-sdk-docs) can then discover and prompt it.

> Preview — APIs may change before 1.0.

```shell
dotnet add package Synadia.AI.Agents.Service --prerelease
```

## Requirements

- .NET 8 or .NET 10.
- A NATS server (`nats-server`).

## Quick start: serve a model

This serves a local Ollama model (via [OllamaSharp](https://www.nuget.org/packages/OllamaSharp)):

```csharp
using NATS.Client.Core;
using OllamaSharp;
using Synadia.AI.Agents.Service;

await using var nats = new NatsConnection(new NatsOpts { Url = "nats://127.0.0.1:4222" });
await using var service = new AgentService(nats, new AgentServiceOptions
{
    Agent = "ollama", Owner = "demo", Name = "local", Description = "A local model",
}).ServeChatClient(new OllamaApiClient(new Uri("http://localhost:11434"), "qwen3.5:4b"));

await service.StartAsync();
Console.WriteLine($"serving {service.Subject.Prompt}");
await Task.Delay(Timeout.Infinite);
```

It prints:

```text
serving agents.prompt.ollama.demo.local
```

The agent registers as a NATS micro service, streams the model's output as response chunks, and sends heartbeats.
Tool approvals (`ApprovalRequiredAIFunction`) become questions to the caller. `ServeChatClient` adds no wire feature;
callers see an ordinary protocol agent.

## Write the handler yourself

```csharp
service.OnPrompt(async (context, stream, cancellationToken) =>
{
    await stream.WriteStatusAsync("checking", cancellationToken);
    var answer = await stream.AskAsync("Delete all files? (yes/no)", cancellationToken: cancellationToken);
    if (answer.Prompt != "yes") throw new RequestRejectedException(403, "not confirmed");
    await stream.WriteAsync($"done: {context.Prompt}", cancellationToken: cancellationToken);
});
```

The SDK sends the end-of-stream terminator. A `RequestRejectedException` becomes a protocol error frame.

## Keep conversations

`ServeChatClient` keys each conversation by the caller's `session_id`.

- Over a stateful client (one that returns a `ConversationId`), it keeps only that id and sends just the new message.
- Over a stateless client, it keeps the history in memory, capped at `MaxHistoryMessages`.
- It keeps at most `MaxConversations` conversations and forgets the least recently used idle one first.

Session ids are not access control: anyone who knows an id can continue that conversation. To bind a conversation to a
verified caller, combine the id with the sender identity in `ConversationKey`.

## `ServeChatClient` options

| Option | Default | Effect |
| --- | --- | --- |
| `Instructions` | `null` | System instructions for every model call. |
| `ChatOptions` | `null` | Tools and model settings for every call. |
| `KeepHistory` | `true` | `false` sends each prompt with no history. |
| `MaxHistoryMessages` | `100` | Cap on the in-memory history of a stateless client. |
| `MaxConversations` | `1000` | Cap on conversations in memory; the least recently used idle one is evicted. |
| `ConversationKey` | `session_id` | Maps a prompt to its conversation. |
| `Approval` | `null` | Question text, answer parser and timeout for tool approvals. A timeout denies. |
| `QueryTimeout` | `DefaultQueryTimeout` (5 minutes) | How long to wait for the caller's answer. |
| `MaxInputRounds` | `8` | Cap on question rounds per prompt. |
| `IncludeReasoning` | `false` | Streams reasoning as status chunks. |
| `AgentTools` | `null` | Lets the model discover and prompt other agents. |

## Learn more

- [Protocol specification](https://github.com/synadia-ai/synadia-agent-sdk-docs)
- [Host SDK guide](https://github.com/synadia-ai/synadia-agents/tree/main/agent-sdk/dotnet)
- [Examples: echo, Ollama, OpenRouter, failover, tools, approvals](https://github.com/synadia-ai/synadia-agents/tree/main/agent-sdk/dotnet/examples)
- Call agents with [Synadia.AI.Agents](https://www.nuget.org/packages/Synadia.AI.Agents); test with
  [Synadia.AI.Agents.Testing](https://www.nuget.org/packages/Synadia.AI.Agents.Testing).
