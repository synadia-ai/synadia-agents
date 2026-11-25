// 02 · LLM agent (Ollama) — forward each prompt to a local Ollama, stream the reply (.NET).
//
// Step 2 of the ladder: take 01-echo and swap the one-line `echo:` reply for a real model. In .NET that is not a new
// handler at all: the model is a Microsoft.Extensions.AI IChatClient, and ServeChatClient hosts *any* IChatClient as
// an agent — every streamed token becomes a `response` chunk. .NET mirror of 02-ollama.ts / 02-ollama.py.
//
//   ollama pull qwen3.5:4b                    # once
//   dotnet run 02-ollama.cs                   # agents.prompt.ollama.<you>.main
//   dotnet run 02-ollama.cs -- --think        # keep the model's (slow) thinking; streamed as `status` chunks
//
// Backend config via env: OLLAMA_URL (alias OLLAMA_ENDPOINT; default http://localhost:11434 — a trailing /v1 from the
// OpenAI-compatible URL is stripped), OLLAMA_MODEL (default qwen3.5:4b). The client is OllamaSharp's OllamaApiClient,
// which implements IChatClient against Ollama's native /api/chat.
//
// Identity/connection flags as in 01-echo (this example registers agent="ollama"). Run with -h for every flag.
#:package OllamaSharp@5.5.2
#:project _shared/ExampleHost.csproj
#:property PublishAot=false

using Microsoft.Extensions.AI;
using OllamaSharp;
using Synadia.AI.Agents.Examples;
using Synadia.AI.Agents.Service;

var ollamaUrl = (Environment.GetEnvironmentVariable("OLLAMA_URL") ?? Environment.GetEnvironmentVariable("OLLAMA_ENDPOINT")
    ?? "http://localhost:11434").TrimEnd('/');
if (ollamaUrl.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)) ollamaUrl = ollamaUrl[..^3];
var model = Environment.GetEnvironmentVariable("OLLAMA_MODEL") ?? "qwen3.5:4b";
var description = $"LLM agent — streams replies from a local Ollama model ({model})";

await using var host = await ExampleHost.ConnectAsync(args, agent: "ollama", description,
    new Dictionary<string, string> { ["--think"] = "keep the model's thinking and stream it as status chunks" });
var think = host.Has("--think");

// A cold model load can take well over HttpClient's default 100 s.
using var http = new HttpClient { BaseAddress = new Uri(ollamaUrl), Timeout = TimeSpan.FromMinutes(10) };
using IChatClient ollama = new OllamaApiClient(http, model);

await using var service = new AgentService(host.Connection, host.ServiceOptions(description));

// The whole agent: one call. Thinking models (qwen3.5) think by default, which is slow; OllamaSharp maps
// ReasoningEffort.None to Ollama's `think: false`.
service.ServeChatClient(ollama, new ChatClientServeOptions
{
    ChatOptions = new ChatOptions { Reasoning = think ? null : new ReasoningOptions { Effort = ReasoningEffort.None } },
    IncludeReasoning = think,
});

await service.StartAsync();
Console.WriteLine($"ollama agent listening on {service.Subject.Prompt}");
Console.WriteLine($"model '{model}' at {ollamaUrl}");
Console.WriteLine("press Ctrl+C to stop");
await ExampleHost.WaitForShutdownAsync();
