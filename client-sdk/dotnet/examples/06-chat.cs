// Interactive multi-turn chat REPL against the first discovered agent — through the Microsoft.Extensions.AI seam:
// Agent.AsIChatClient() is a plain IChatClient, so anything built for MEAI (middleware, Agent Framework, …) can talk
// to a NATS agent. Status chunks surface as AgentStatusContent; mid-stream queries as AgentQueryContent.
//
//   dotnet run 06-chat.cs            commands: /help · /quit
#:project ../src/Synadia.AI.Agents/Synadia.AI.Agents.csproj

using Microsoft.Extensions.AI;
using NATS.Client.Core;
using Synadia.AI.Agents;

await using var nc = new NatsConnection(new NatsOpts { Url = Environment.GetEnvironmentVariable("NATS_URL") ?? "nats://127.0.0.1:4222" });
await using var agents = new AgentsClient(nc);

var found = await agents.DiscoverAsync();
if (found.Count == 0)
{
    Console.Error.WriteLine("no agents found — start one first.");
    return 2;
}
var agent = found[0];
Console.WriteLine($"chatting with {agent.Info.Agent}/{agent.Info.Owner}/{agent.Info.Name}  (/help, /quit)\n");

using IChatClient chat = agent.AsIChatClient(new AgentChatClientOptions
{
    QueryHandler = (query, ct) =>
    {
        Console.Write($"\n[agent asks] {query.Prompt}\n> ");
        return ValueTask.FromResult(Console.ReadLine());
    },
});

// The adapter sends only the newest user message; the agent owns conversation state.
List<ChatMessage> history = [];
while (true)
{
    Console.Write("❯ ");
    var line = Console.ReadLine()?.Trim();
    if (line is null || line is "/quit" or "/q" or "/exit") break;
    if (line.Length == 0) continue;
    if (line.StartsWith('/')) { Console.WriteLine("commands: /help · /quit"); continue; }

    history.Add(new ChatMessage(ChatRole.User, line));
    List<ChatResponseUpdate> updates = [];
    await foreach (var update in chat.GetStreamingResponseAsync(history))
    {
        updates.Add(update);
        foreach (var content in update.Contents)
        {
            if (content is AgentStatusContent status && !status.IsAck)
                Console.Write($"\u001b[2m[{status.Status}]\u001b[0m ");
            else if (content is TextContent text)
                Console.Write(text.Text);
        }
    }
    Console.WriteLine("\n");
    history.AddMessages(updates);
}
return 0;
