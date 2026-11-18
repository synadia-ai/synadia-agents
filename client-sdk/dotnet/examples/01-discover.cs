// Enumerate every reachable agent via $SRV.INFO.agents and print identity + capabilities.
//
//   dotnet run 01-discover.cs
//
// NATS_URL selects the server (default nats://127.0.0.1:4222).
#:project ../src/Synadia.AI.Agents/Synadia.AI.Agents.csproj

using NATS.Client.Core;
using Synadia.AI.Agents;

await using var nc = new NatsConnection(new NatsOpts { Url = Environment.GetEnvironmentVariable("NATS_URL") ?? "nats://127.0.0.1:4222" });
await using var agents = new AgentsClient(nc);

var found = await agents.DiscoverAsync();
if (found.Count == 0)
{
    Console.Error.WriteLine("no agents found — start one first (e.g. agent-sdk/dotnet/examples/run-reference-agent.cs).");
    return 2;
}

foreach (var agent in found)
{
    var info = agent.Info;
    Console.WriteLine($"{info.Agent}/{info.Owner}/{info.Name}{(info.Session is null ? "" : $" [{info.Session}]")}");
    Console.WriteLine($"  instance     {info.InstanceId}");
    Console.WriteLine($"  protocol     v{info.ProtocolVersion} ({info.Compatibility})");
    Console.WriteLine($"  description  {info.Description}");
    Console.WriteLine($"  prompt       {agent.PromptSubject} (queue \"{info.PromptEndpoint.QueueGroup}\")");
    Console.WriteLine($"  attachments  {(info.PromptEndpoint.AttachmentsOk == false ? "no" : "yes")}, max_payload {info.PromptEndpoint.MaxPayloadBytes?.ToString() ?? "unknown"}");
    if (info.SupportsSenderIdentity)
        Console.WriteLine($"  identity     min_sender_trust={info.PromptEndpoint.MinSenderTrust}");
}
return 0;
