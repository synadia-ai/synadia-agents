// Send a text prompt to the first discovered agent and stream the response.
//
//   dotnet run 02-prompt-text.cs -- "say hello in five words"
#:project ../src/Synadia.AI.Agents/Synadia.AI.Agents.csproj

using NATS.Client.Core;
using Synadia.AI.Agents;

var prompt = args.Length > 0 ? string.Join(' ', args) : "hello";

await using var nc = new NatsConnection(new NatsOpts { Url = Environment.GetEnvironmentVariable("NATS_URL") ?? "nats://127.0.0.1:4222" });
await using var agents = new AgentsClient(nc);

var found = await agents.DiscoverAsync();
if (found.Count == 0)
{
    Console.Error.WriteLine("no agents found — start one first.");
    return 2;
}
var agent = found[0];
Console.Error.WriteLine($"→ {agent}");

await foreach (var chunk in agent.PromptAsync(prompt))
{
    switch (chunk)
    {
        case AgentStatusChunk s:
            Console.Error.WriteLine($"[status] {s.Status}");
            break;
        case AgentResponseChunk r:
            Console.Write(r.Text);
            break;
    }
}
Console.WriteLine();
return 0;
