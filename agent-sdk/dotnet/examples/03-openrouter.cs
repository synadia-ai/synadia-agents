// 03 · LLM agent (OpenRouter) — forward each prompt to OpenRouter, stream the reply (.NET).
//
// Same shape as 02-ollama, but the backend is the hosted, OpenAI-compatible OpenRouter API instead of a local Ollama.
// Requires an API key; no GPU needed. The agent code is identical to 02 — only the IChatClient changes: here it is the
// official OpenAI client (Microsoft.Extensions.AI.OpenAI's AsIChatClient) pointed at OpenRouter's base URL.
// .NET mirror of 03-openrouter.ts / 03-openrouter.py.
//
//   export OPENROUTER_API_KEY=sk-or-...       # https://openrouter.ai/keys
//   dotnet run 03-openrouter.cs               # agents.prompt.openrouter.<you>.main
//
// Backend config via env: OPENROUTER_API_KEY (required), OPENROUTER_MODEL (default openai/gpt-4o-mini).
// OPENAI_BASE_URL (default https://openrouter.ai/api/v1) points the same client at any other OpenAI-compatible endpoint;
// with it set the key is optional — e.g. Ollama's /v1:
//   OPENAI_BASE_URL=http://localhost:11434/v1 OPENROUTER_MODEL=qwen3.5:4b dotnet run 03-openrouter.cs
//
// Identity/connection flags as in 01-echo (this example registers agent="openrouter"). Run with -h for every flag.
#:package Microsoft.Extensions.AI.OpenAI@11.0.0
#:project _shared/ExampleHost.csproj
#:property PublishAot=false

using System.ClientModel;
using Microsoft.Extensions.AI;
using OpenAI;
using Synadia.AI.Agents.Examples;
using Synadia.AI.Agents.Service;

var apiKey = Environment.GetEnvironmentVariable("OPENROUTER_API_KEY");
var baseUrl = Environment.GetEnvironmentVariable("OPENAI_BASE_URL") ?? "https://openrouter.ai/api/v1";
var model = Environment.GetEnvironmentVariable("OPENROUTER_MODEL") ?? "openai/gpt-4o-mini";
var description = $"LLM agent — streams replies from a hosted OpenRouter model ({model})";

// Checked before connecting (so a missing key doesn't need a NATS server to report) but not for --help.
if (string.IsNullOrEmpty(apiKey) && Environment.GetEnvironmentVariable("OPENAI_BASE_URL") is null
    && !args.Any(a => a is "-h" or "--help"))
{
    Console.Error.WriteLine("error: OPENROUTER_API_KEY is not set (get one at https://openrouter.ai/keys)");
    return 2;
}

await using var host = await ExampleHost.ConnectAsync(args, agent: "openrouter", description);

using IChatClient openRouter = new OpenAIClient(
        new ApiKeyCredential(string.IsNullOrEmpty(apiKey) ? "unused" : apiKey),
        new OpenAIClientOptions { Endpoint = new Uri(baseUrl), NetworkTimeout = TimeSpan.FromMinutes(10) })
    .GetChatClient(model)
    .AsIChatClient();

await using var service = new AgentService(host.Connection, host.ServiceOptions(description));
service.ServeChatClient(openRouter);

await service.StartAsync();
Console.WriteLine($"openrouter agent listening on {service.Subject.Prompt}");
Console.WriteLine($"model '{model}' at {baseUrl}");
Console.WriteLine("press Ctrl+C to stop");
await ExampleHost.WaitForShutdownAsync();
return 0;
