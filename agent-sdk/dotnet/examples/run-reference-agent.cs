// Run the spec-compliant .NET ReferenceAgent for the caller examples (any language) to discover and prompt.
//
//   dotnet run run-reference-agent.cs [-- --agent demo-agent --name example]
//
// Prompts: "ask <question>" (mid-stream query), "fail <code> <msg>", "slow <ms>", anything else echoes.
#:project ../src/Synadia.AI.Agents.Testing/Synadia.AI.Agents.Testing.csproj

using NATS.Client.Core;
using Synadia.AI.Agents.Testing;

string Arg(string name, string fallback)
{
    var i = Array.IndexOf(args, name);
    return i >= 0 && i + 1 < args.Length ? args[i + 1] : fallback;
}

await using var nc = new NatsConnection(new NatsOpts { Url = Environment.GetEnvironmentVariable("NATS_URL") ?? "nats://127.0.0.1:4222" });
await using var agent = new ReferenceAgent(nc, new ReferenceAgentOptions
{
    Agent = Arg("--agent", "demo-agent"),
    Name = Arg("--name", "example"),
});
await agent.StartAsync();
Console.WriteLine($"reference agent listening on {agent.Service.Subject} (instance {agent.Service.InstanceId}) — Ctrl-C to stop");

var done = new TaskCompletionSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; done.TrySetResult(); };
await done.Task;
