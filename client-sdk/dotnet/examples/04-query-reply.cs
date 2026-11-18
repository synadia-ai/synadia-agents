// Answer an agent's mid-stream queries (§7: clarifications, permission prompts) from the console.
// Against the reference agent, try:  dotnet run 04-query-reply.cs -- "ask what is your name?"
#:project ../src/Synadia.AI.Agents/Synadia.AI.Agents.csproj

using NATS.Client.Core;
using Synadia.AI.Agents;

var prompt = args.Length > 0 ? string.Join(' ', args) : "ask what is your name?";

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
        case AgentQueryChunk q:
            Console.Error.Write($"\n[agent asks] {q.Prompt}\n> ");
            var answer = Console.ReadLine() ?? "";
            await q.ReplyAsync(answer);
            break;
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
