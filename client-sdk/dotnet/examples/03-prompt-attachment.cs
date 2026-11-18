// Prompt with a file attached. Attachments are Microsoft.Extensions.AI DataContent; the SDK validates against the
// agent's advertised max_payload / attachments_ok (§5.4) before publishing.
//
//   dotnet run 03-prompt-attachment.cs -- path/to/file.txt "summarize this"
#:project ../src/Synadia.AI.Agents/Synadia.AI.Agents.csproj

using NATS.Client.Core;
using Synadia.AI.Agents;

if (args.Length == 0)
{
    Console.Error.WriteLine("usage: dotnet run 03-prompt-attachment.cs -- <file> [prompt]");
    return 64;
}
var prompt = args.Length > 1 ? string.Join(' ', args[1..]) : "please look at the attached file";
var attachment = await PromptEnvelope.AttachmentFromFileAsync(args[0]);

await using var nc = new NatsConnection(new NatsOpts { Url = Environment.GetEnvironmentVariable("NATS_URL") ?? "nats://127.0.0.1:4222" });
await using var agents = new AgentsClient(nc);

var found = await agents.DiscoverAsync();
if (found.Count == 0)
{
    Console.Error.WriteLine("no agents found — start one first.");
    return 2;
}
var agent = found[0];
Console.Error.WriteLine($"→ {agent} with {attachment.Name} ({attachment.MediaType}, {attachment.Data.Length} bytes)");

try
{
    await foreach (var chunk in agent.PromptAsync(new PromptEnvelope(prompt, [attachment])))
    {
        switch (chunk)
        {
            case AgentStatusChunk s:
                Console.Error.WriteLine($"[status] {s.Status}");
                break;
            case AgentResponseChunk r:
                Console.Write(r.Text);
                foreach (var a in r.Attachments)
                    Console.Error.WriteLine($"\n[attachment] {a.Name} ({a.MediaType}, {a.Data.Length} bytes)");
                break;
        }
    }
}
catch (AttachmentsNotSupportedException)
{
    Console.Error.WriteLine("agent does not accept attachments (attachments_ok=false)");
    return 1;
}
catch (PayloadTooLargeException e)
{
    Console.Error.WriteLine($"too large: {e.Size} bytes > max_payload {e.Limit}");
    return 1;
}
Console.WriteLine();
return 0;
