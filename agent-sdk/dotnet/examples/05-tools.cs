// 05 · LLM agent with a tool backed by a NATS microservice (.NET).
//
// The top of the ladder. Examples 2-4 gave the agent a model; this gives it a *tool*, and wires that tool to a NATS
// microservice. .NET mirror of 05-tools.ts / 05-tools.py. The point of the demo:
//
//   any microservice already on your NATS network can become an agent capability — the agent need not embed the
//   database, device, or credential that sits behind it.
//
// The agent here holds only an LLM and a NATS connection; it can't read a sensor itself. When the model needs live data
// it calls the tool, the tool makes a single NATS request, and a microservice answers. For a self-contained demo the
// service is hosted in this same file (NATS.Client.Services); in production it runs elsewhere.
//
// Where the TS/Python versions hand-roll the two model round trips (tool decision, then streamed answer), here the tool
// is a plain C# method turned into an AIFunction (AIFunctionFactory), and FunctionInvokingChatClient
// (.UseFunctionInvocation()) runs the call-tool-and-resume loop — for as many rounds as the model needs.
//
//   ollama pull qwen3.5:4b                    # once (any tool-capable model works)
//   dotnet run 05-tools.cs                    # agents.prompt.tools.<you>.main + the `sensors` service
//
// Backend config via env: OLLAMA_URL (alias OLLAMA_ENDPOINT; default http://localhost:11434), OLLAMA_MODEL (default
// qwen3.5:4b). Identity/connection flags as in 01-echo (this example registers agent="tools"). Run -h for every flag.
#:package Microsoft.Extensions.AI@11.0.0
#:package OllamaSharp@5.5.2
#:project _shared/ExampleHost.csproj
#:property PublishAot=false

using System.ComponentModel;
using System.Globalization;
using Microsoft.Extensions.AI;
using NATS.Client.Core;
using NATS.Client.Services;
using OllamaSharp;
using Synadia.AI.Agents.Examples;
using Synadia.AI.Agents.Service;

// Subject the sensor microservice listens on. The agent's tool sends requests here; nothing else couples the agent to
// the service.
const string SensorSubject = "sensors.read";

// The microservice's data — a stand-in for "some service already on your network". Room 3 is deliberately too warm,
// so the agent has something to flag.
var readings = new Dictionary<string, double>
{
    ["cold-storage-1"] = 3.4,
    ["cold-storage-2"] = 2.8,
    ["cold-storage-3"] = 6.2,
};

var ollamaUrl = (Environment.GetEnvironmentVariable("OLLAMA_URL") ?? Environment.GetEnvironmentVariable("OLLAMA_ENDPOINT")
    ?? "http://localhost:11434").TrimEnd('/');
if (ollamaUrl.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)) ollamaUrl = ollamaUrl[..^3];
var model = Environment.GetEnvironmentVariable("OLLAMA_MODEL") ?? "qwen3.5:4b";
const string Description = "LLM agent with a read_sensor tool backed by a NATS microservice";

await using var host = await ExampleHost.ConnectAsync(args, agent: "tools", Description);
var nc = host.Connection;

// The microservice the agent's tool will call. In production this is a separate process somewhere on the network —
// here it just shares the agent's connection so the demo is self-contained. Request body: the bare location.
var services = new NatsSvcContext(nc);
await using var sensors = await services.AddServiceAsync(
    new NatsSvcConfig("sensors", "0.1.0") { Description = "Returns the current temperature (°C) for a location" });
await sensors.AddEndpointAsync<string>(
    async msg => await msg.ReplyAsync(readings.TryGetValue(msg.Data ?? "", out var celsius)
        ? celsius.ToString(CultureInfo.InvariantCulture)
        : "unknown"),
    name: "read",
    subject: SensorSubject);

// The tool. Its body is the whole point: one NATS request to the microservice.
[Description("Read the current temperature in Celsius at a location.")]
async Task<string> ReadSensor([Description("sensor location, e.g. 'cold-storage-3'")] string location)
{
    var reply = await nc.RequestAsync<string, string>(SensorSubject, location,
        replyOpts: new NatsSubOpts { Timeout = TimeSpan.FromSeconds(5) });
    var result = reply.Data is null or "unknown" ? $"no sensor at '{location}'" : $"{location} is {reply.Data}°C";
    Console.WriteLine($"  read_sensor({location}) → {result}");
    return result;
}

// A cold model load can take well over HttpClient's default 100 s.
using var http = new HttpClient { BaseAddress = new Uri(ollamaUrl), Timeout = TimeSpan.FromMinutes(10) };
using IChatClient chatClient = new ChatClientBuilder(new OllamaApiClient(http, model))
    .UseFunctionInvocation() // runs read_sensor whenever the model asks, then resumes the model with the result
    .Build();

await using var service = new AgentService(nc, host.ServiceOptions(Description));
service.ServeChatClient(chatClient, new ChatClientServeOptions
{
    ChatOptions = new ChatOptions
    {
        Tools = [AIFunctionFactory.Create(ReadSensor, "read_sensor")],
        // qwen3.5 thinks by default (slow); OllamaSharp maps ReasoningEffort.None to Ollama's `think: false`.
        Reasoning = new ReasoningOptions { Effort = ReasoningEffort.None },
    },
});

await service.StartAsync();
Console.WriteLine($"tools agent listening on {service.Subject.Prompt}");
Console.WriteLine($"sensor service on '{SensorSubject}', model '{model}' at {ollamaUrl}");
Console.WriteLine("press Ctrl+C to stop");
await ExampleHost.WaitForShutdownAsync();
