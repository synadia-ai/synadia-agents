// 06 · LLM agent with tool approvals and agent delegation (.NET) — the rung beyond the shared ladder.
//
// 05-tools let the model call a tool freely. Real agents also have tools a human should sign off on. Here a
// Microsoft.Extensions.AI ApprovalRequiredAIFunction marks `restart_service` as needing approval: ServeChatClient turns
// the model's ToolApprovalRequestContent into a §7 mid-stream `query` to the caller ("Allow tool 'restart_service' …?
// (yes/no)"), and the caller's answer resumes the model. `current_time` runs freely. With --agent-tools the model can
// also discover and prompt other agents on the network (AgentTools.AsAITools()).
//
//   ollama pull qwen3.5:4b                         # once
//   dotnet run 06-approvals.cs                     # agents.prompt.approvals.<you>.main
//   dotnet run 06-approvals.cs -- --agent-tools    # also let the model discover/prompt other agents
//   dotnet run 06-approvals.cs -- --think          # keep qwen's (slow) thinking; streamed as status chunks
//
// Drive it with a caller that answers queries: client-sdk/typescript/examples/04-query-reply.ts or
// client-sdk/dotnet/examples/06-chat.cs (both talk to the first agent they discover, so run this one on its own server).
//
// Backend config via env: OLLAMA_URL (alias OLLAMA_ENDPOINT; default http://localhost:11434 — a trailing /v1 from the
// OpenAI-compatible URL is stripped), OLLAMA_MODEL (default qwen3.5:4b). The model client is OllamaSharp:
// OllamaApiClient implements IChatClient directly against Ollama's native /api/chat (it replaces the deprecated
// Microsoft.Extensions.AI.Ollama package). OllamaSharp 5.5.2 is compiled against MEAI 10.8 and runs unchanged on MEAI 11.
//
// Identity/connection flags as in 01-echo (this example registers agent="approvals"). Run with -h for every flag.
#:package Microsoft.Extensions.AI@11.0.0
#:package OllamaSharp@5.5.2
#:project _shared/ExampleHost.csproj
#:property PublishAot=false

using System.ComponentModel;
using Microsoft.Extensions.AI;
using OllamaSharp;
using Synadia.AI.Agents;
using Synadia.AI.Agents.Examples;
using Synadia.AI.Agents.Service;
using Synadia.AI.Agents.Tools;

var ollamaUrl = (Environment.GetEnvironmentVariable("OLLAMA_URL") ?? Environment.GetEnvironmentVariable("OLLAMA_ENDPOINT")
    ?? "http://localhost:11434").TrimEnd('/');
if (ollamaUrl.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)) ollamaUrl = ollamaUrl[..^3];
var model = Environment.GetEnvironmentVariable("OLLAMA_MODEL") ?? "qwen3.5:4b";
var description = $"{model} via Ollama, with approval-gated tools, served with Microsoft.Extensions.AI";

await using var host = await ExampleHost.ConnectAsync(args, agent: "approvals", description, new Dictionary<string, string>
{
    ["--agent-tools"] = "let the model discover and prompt other agents",
    ["--think"] = "keep the model's thinking and stream it as status chunks",
});
var useAgentTools = host.Has("--agent-tools");
var think = host.Has("--think");

// A cold model load can take well over HttpClient's default 100 s.
using var http = new HttpClient { BaseAddress = new Uri(ollamaUrl), Timeout = TimeSpan.FromMinutes(10) };
using IChatClient chatClient = new ChatClientBuilder(new OllamaApiClient(http, model)).UseFunctionInvocation().Build();

[Description("Returns the current local date and time.")]
static string CurrentTime() => DateTimeOffset.Now.ToString("F");

[Description("Restarts a named service. Destructive: requires the caller's approval.")]
static string RestartService([Description("The service name")] string name) => $"service '{name}' restarted";

List<AITool> tools =
[
    AIFunctionFactory.Create(CurrentTime, "current_time"),
    new ApprovalRequiredAIFunction(AIFunctionFactory.Create(RestartService, "restart_service")),
];

await using var service = new AgentService(host.Connection, host.ServiceOptions(description));

await using var agentsClient = new AgentsClient(host.Connection);
await using AgentTools? agentTools = useAgentTools
    ? new AgentTools(agentsClient, new AgentToolsOptions { SelfAddress = service.Subject.Prompt })
    : null;

service.ServeChatClient(chatClient, new ChatClientServeOptions
{
    Instructions = "You are a concise, friendly assistant reachable over NATS. Use tools only when they help. "
        + (useAgentTools ? "You can discover other agents with discover_agents and delegate with prompt_agent." : ""),
    ChatOptions = new ChatOptions
    {
        Tools = tools,
        // qwen3.5 thinks by default (slow). OllamaSharp maps Effort = None to Ollama's `think: false`; --think keeps
        // thinking and streams the reasoning as status chunks.
        Reasoning = think ? null : new ReasoningOptions { Effort = ReasoningEffort.None },
    },
    IncludeReasoning = think,
    AgentTools = agentTools,
});

await service.StartAsync();
Console.WriteLine($"approvals agent listening on {service.Subject.Prompt}");
Console.WriteLine($"model '{model}' at {ollamaUrl}");
Console.WriteLine("press Ctrl+C to stop");
await ExampleHost.WaitForShutdownAsync();
