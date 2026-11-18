// 01 · Echo agent — the smallest Synadia Agent Protocol agent (.NET).
//
// Replies to every prompt with `echo: <prompt text>`. No LLM, no state — just enough to show the shape of an agent
// built on AgentService: connect to NATS, construct the service, handle prompts, start, shut down. .NET mirror of
// agent-sdk/typescript/examples/01-echo.ts and agent-sdk/python/examples/01-echo.py.
//
//   dotnet run 01-echo.cs                                     # agents.prompt.echo.<you>.main
//   dotnet run 01-echo.cs -- --owner alice --session-name demo --heartbeat-interval 2
//
// Identity → subject agents.prompt.echo.<owner>.<name>: --owner / --session-name, else the SYNADIA_* ladder
// ($SYNADIA_ECHO_OWNER > $SYNADIA_OWNER > legacy $NATS_AGENT_OWNER, and the _NAME analogue). Connection: --url /
// $NATS_URL (+ --nkey / --creds), else localhost. Run with -h for every flag; see README.md for the full table.
#:project _shared/ExampleHost.csproj
#:property PublishAot=false

using Synadia.AI.Agents.Examples;
using Synadia.AI.Agents.Service;

const string Description = "Echo agent — replies with the prompt prefixed by 'echo: '";

await using var host = await ExampleHost.ConnectAsync(args, agent: "echo", Description);
await using var service = new AgentService(host.Connection, host.ServiceOptions(Description));

// The whole agent. Every incoming prompt runs this handler; whatever we write is the reply. Here we send one chunk;
// an LLM agent would send many, token by token.
service.OnPrompt(async (prompt, stream, ct) => await stream.WriteAsync($"echo: {prompt.Prompt}", cancellationToken: ct));

await service.StartAsync();
Console.WriteLine($"echo agent listening on {service.Subject.Prompt}");
Console.WriteLine("press Ctrl+C to stop");
await ExampleHost.WaitForShutdownAsync();
