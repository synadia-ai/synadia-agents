# Synadia.AI.Agents.Testing

Test code that calls or hosts agents on NATS against a real server. It starts a throwaway `nats-server` on a free port
and runs a spec-compliant reference agent, so tests need no shared infrastructure.

> Preview — APIs may change before 1.0.

```shell
dotnet add package Synadia.AI.Agents.Testing --prerelease
```

## Requirements

- .NET 8 or .NET 10.
- `nats-server` on `PATH`, or its path in the `NATS_SERVER_BIN` environment variable.

## Quick start (xUnit)

```csharp
using NATS.Client.Core;
using Synadia.AI.Agents;
using Synadia.AI.Agents.Testing;

public class ReferenceAgentTests
{
    [Fact]
    public async Task EchoesThePrompt()
    {
        await using var server = await NatsServerProcess.StartAsync();
        await using var nats = new NatsConnection(new NatsOpts { Url = server.Url });
        await using var reference = new ReferenceAgent(nats);
        await reference.StartAsync();

        await using var agents = new AgentsClient(nats);
        var agent = (await agents.DiscoverAsync(new AgentFilter { Agent = "demo-agent" }))[0];

        var text = "";
        await foreach (var chunk in agent.PromptAsync("hello"))
            if (chunk is AgentResponseChunk response) text += response.Text;

        Assert.Equal("echo: hello", text);
    }
}
```

`NatsServerProcess.IsAvailable()` reports whether `nats-server` can be found, so you can skip instead of fail.

## What the reference agent does

Its behavior depends on the prompt:

| Prompt | Response |
| --- | --- |
| `ask <question>` | Asks `<question>` mid-stream, then answers `you answered: <answer>`. |
| `fail <code> <message>` | Sends an error frame; the caller throws `AgentServiceException`. |
| `slow <ms>` | Sends a `working` status, waits, then echoes. |
| anything else | `echo: <prompt>`, plus earlier turns of the same session and any attachment names. |

## Test a caller's question handling

```csharp
await foreach (var chunk in agent.PromptAsync("ask Which city?"))
    if (chunk is AgentQueryChunk query) await query.ReplyAsync("Lisbon");
// The final response chunk is "you answered: Lisbon".
```

## Test your own agent

Host it on the same throwaway server:

```csharp
await using var service = new AgentService(nats, new AgentServiceOptions { Agent = "mine", Owner = "test", Name = "unit" })
    .OnPrompt((context, stream, cancellationToken) => stream.WriteAsync("ok", cancellationToken: cancellationToken).AsTask());
await service.StartAsync();
```

## `ReferenceAgentOptions`

| Option | Default | Effect |
| --- | --- | --- |
| `Agent` / `Owner` / `Name` | `demo-agent` / your user name / `example` | The agent's subject tokens. |
| `Prefix` | `echo: ` | Prefix of each echo. |
| `AttachmentsOk` | `true` | Whether the agent accepts attachments. |
| `EchoAttachments` | `true` | Sends received attachments back. |
| `MaxPayload` | `null` | Payload limit the agent advertises. |
| `QueryTimeout` | 30 seconds | How long `ask` waits for an answer. |
| `HeartbeatInterval` | 5 seconds | How often the agent sends heartbeats. |

## Learn more

- [Protocol specification](https://github.com/synadia-ai/synadia-agent-sdk-docs)
- [Host SDK guide](https://github.com/synadia-ai/synadia-agents/tree/main/agent-sdk/dotnet)
- Companion packages: [Synadia.AI.Agents](https://www.nuget.org/packages/Synadia.AI.Agents) (call agents) and
  [Synadia.AI.Agents.Service](https://www.nuget.org/packages/Synadia.AI.Agents.Service) (host agents).
