using System.Text.Json.Nodes;
using Microsoft.Extensions.AI;
using NATS.Client.Core;
using Synadia.AI.Agents.Testing;
using Synadia.AI.Agents.Tools;

namespace Synadia.AI.Agents.Service.Tests;

[Collection(NatsCollection.Name)]
public sealed class AgentToolsEndToEndTests(NatsServerFixture nats)
{
    private sealed class Harness : IAsyncDisposable
    {
        public required NatsConnection Host { get; init; }
        public required NatsConnection Caller { get; init; }
        public required ReferenceAgent Agent { get; init; }
        public required AgentsClient Client { get; init; }
        public required AgentTools Tools { get; init; }
        public required string Owner { get; init; }
        public string Address => $"agents.prompt.demo-agent.{Owner}.example";

        public async ValueTask DisposeAsync()
        {
            await Tools.DisposeAsync();
            await Client.DisposeAsync();
            await Agent.DisposeAsync();
            await Host.DisposeAsync();
            await Caller.DisposeAsync();
        }
    }

    private async Task<Harness> StartAsync(AgentToolsOptions? options = null)
    {
        var owner = Unique.Owner();
        var host = await nats.ConnectAsync();
        var caller = await nats.ConnectAsync();
        var agent = new ReferenceAgent(host, new ReferenceAgentOptions { Owner = owner });
        await agent.StartAsync();
        var client = new AgentsClient(caller);
        return new Harness { Host = host, Caller = caller, Agent = agent, Client = client, Tools = new AgentTools(client, options), Owner = owner };
    }

    private static string Str(JsonObject o, string key) => o[key]!.GetValue<string>();

    [Fact]
    public async Task DiscoverListsTheAgentOncePerAddress()
    {
        await using var h = await StartAsync();
        var result = await h.Tools.ExecuteAsync(AgentToolNames.DiscoverAgents, $$"""{"owner":"{{h.Owner}}"}""");
        var entry = Assert.Single(result["agents"]!.AsArray())!.AsObject();
        Assert.Equal(h.Address, Str(entry, "address"));
        Assert.Equal("demo-agent", Str(entry, "agent"));
        Assert.Equal(h.Owner, Str(entry, "owner"));
        Assert.Equal("example", Str(entry, "name"));
        Assert.True(entry["accepts_attachments"]!.GetValue<bool>());
        Assert.False(entry["requires_signed_prompts"]!.GetValue<bool>());
        Assert.Equal(1, entry["instances"]!.GetValue<int>());
        Assert.False(result.ContainsKey("open_calls"));
    }

    [Fact]
    public async Task BlockingPromptReturnsTheReply()
    {
        await using var h = await StartAsync();
        var result = await h.Tools.ExecuteAsync(AgentToolNames.PromptAgent, $$"""{"address":"{{h.Address}}","prompt":"hi","label":"greet"}""");
        Assert.Equal("completed", Str(result, "state"));
        Assert.Equal("echo: hi", Str(result, "reply"));
        Assert.Equal("greet", Str(result, "label"));
        Assert.False(string.IsNullOrEmpty(Str(result, "call_id")));
    }

    [Fact]
    public async Task UnknownAddressIsRefused()
    {
        await using var h = await StartAsync();
        var result = await h.Tools.ExecuteAsync(AgentToolNames.PromptAgent, """{"address":"agents.prompt.none.none.none","prompt":"hi"}""");
        Assert.StartsWith("no agent answers at", Str(result, "error"), StringComparison.Ordinal);
        Assert.False(result.ContainsKey("call_id"));
    }

    [Fact]
    public async Task QuestionIsAnsweredWithAnswerAgent()
    {
        await using var h = await StartAsync();
        var asked = await h.Tools.ExecuteAsync(AgentToolNames.PromptAgent, $$"""{"address":"{{h.Address}}","prompt":"ask your name?"}""");
        Assert.Equal("input_required", Str(asked, "state"));
        Assert.Equal("your name?", Str(asked, "question"));
        Assert.Equal(1, asked["open_calls"]!.GetValue<int>());

        var answered = await h.Tools.ExecuteAsync(AgentToolNames.AnswerAgent, $$"""{"call_id":"{{Str(asked, "call_id")}}","answer":"dotnet"}""");
        Assert.Equal("completed", Str(answered, "state"));
        Assert.Equal("you answered: dotnet", Str(answered, "reply"));
        Assert.False(answered.ContainsKey("open_calls"));
    }

    [Fact]
    public async Task DetachedCallsAreCollectedWithWaitAgent()
    {
        await using var h = await StartAsync();
        var a = await h.Tools.ExecuteAsync(AgentToolNames.PromptAgent, $$"""{"address":"{{h.Address}}","prompt":"slow 300","wait":false}""");
        Assert.Equal("running", Str(a, "state"));
        var b = await h.Tools.ExecuteAsync(AgentToolNames.PromptAgent, $$"""{"address":"{{h.Address}}","prompt":"slow 50","wait":false}""");
        Assert.Equal(2, b["open_calls"]!.GetValue<int>());

        var timedOut = await h.Tools.ExecuteAsync(AgentToolNames.WaitAgent, $$"""{"call_ids":["{{Str(a, "call_id")}}"],"timeout_ms":0}""");
        Assert.Equal("running", Str(timedOut, "state"));
        Assert.Single(timedOut["call_ids"]!.AsArray());

        var ids = new[] { Str(a, "call_id"), Str(b, "call_id") };
        var done = new HashSet<string>();
        for (var i = 0; i < 2; i++)
        {
            var open = ids.Where(id => !done.Contains(id)).ToArray();
            var r = await h.Tools.ExecuteAsync(AgentToolNames.WaitAgent, new JsonObject { ["call_ids"] = new JsonArray(open.Select(x => (JsonNode)x).ToArray()), ["timeout_ms"] = 10_000 });
            Assert.Equal("completed", Str(r, "state"));
            Assert.StartsWith("echo: slow", Str(r, "reply"), StringComparison.Ordinal);
            done.Add(Str(r, "call_id"));
        }
        Assert.Equal(ids.Order(), done.Order());

        var again = await h.Tools.ExecuteAsync(AgentToolNames.WaitAgent, $$"""{"call_ids":["{{ids[0]}}"]}""");
        Assert.Equal("completed", Str(again, "state"));

        var list = await h.Tools.ExecuteAsync(AgentToolNames.ListAgentCalls, "{}");
        Assert.Equal(2, list["calls"]!.AsArray().Count);
    }

    [Fact]
    public async Task CancelStopsARunningCall()
    {
        await using var h = await StartAsync();
        var started = await h.Tools.ExecuteAsync(AgentToolNames.PromptAgent, $$"""{"address":"{{h.Address}}","prompt":"slow 20000","wait":false}""");
        var cancelled = await h.Tools.ExecuteAsync(AgentToolNames.CancelAgent, $$"""{"call_ids":["{{Str(started, "call_id")}}"]}""");
        var entry = Assert.Single(cancelled["calls"]!.AsArray())!.AsObject();
        Assert.Equal("cancelled", Str(entry, "state"));
        Assert.False(cancelled.ContainsKey("open_calls"));
    }

    [Fact]
    public async Task ReturnedAttachmentsAreSavedLocally()
    {
        var dir = Path.Combine(Path.GetTempPath(), "agent-tools-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var file = Path.Combine(dir, "note.txt");
            await File.WriteAllTextAsync(file, "hello file");
            await using var h = await StartAsync(new AgentToolsOptions { AttachmentRoots = [dir] });
            var result = await h.Tools.ExecuteAsync(AgentToolNames.PromptAgent,
                new JsonObject { ["address"] = h.Address, ["prompt"] = "see file", ["attachments"] = new JsonArray(file) });
            Assert.Equal("completed", Str(result, "state"));
            var saved = Assert.Single(result["attachments"]!.AsArray())!.AsObject();
            Assert.Equal("note.txt", Str(saved, "filename"));
            Assert.Equal(10, saved["size_bytes"]!.GetValue<long>());
            var path = Str(saved, "path");
            Assert.NotEqual(file, path);
            Assert.Equal("hello file", await File.ReadAllTextAsync(path));

            var outside = await h.Tools.ExecuteAsync(AgentToolNames.PromptAgent,
                new JsonObject { ["address"] = h.Address, ["prompt"] = "x", ["attachments"] = new JsonArray(typeof(AgentToolsEndToEndTests).Assembly.Location) });
            Assert.Contains("outside the directories", Str(outside, "error"), StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(dir, true);
        }
    }

    [Fact]
    public async Task ScopeEndRefusesOpenQuestionsAndCancelsCalls()
    {
        await using var h = await StartAsync();
        string? callId = null;
        var inside = await h.Tools.RunInPromptScopeAsync(async () =>
        {
            var asked = await h.Tools.ExecuteAsync(AgentToolNames.PromptAgent, $$"""{"address":"{{h.Address}}","prompt":"ask anything?"}""");
            callId = Str(asked, "call_id");
            Assert.Contains("before you answer", Str(asked, "open_calls_note"), StringComparison.Ordinal);
            return Str(asked, "state");
        });
        Assert.Equal("input_required", inside);
        // The served scope is gone: its calls are not visible from the root scope.
        var answered = await h.Tools.ExecuteAsync(AgentToolNames.AnswerAgent, $$"""{"call_id":"{{callId}}","answer":"late"}""");
        Assert.True(answered.ContainsKey("error"));
    }

    [Fact]
    public async Task LoopGuardRefusesPromptingTheCaller()
    {
        await using var h = await StartAsync(new AgentToolsOptions { SelfAddress = "agents.prompt.me.me.me" });
        var self = await h.Tools.ExecuteAsync(AgentToolNames.PromptAgent, """{"address":"agents.prompt.me.me.me","prompt":"hi"}""");
        Assert.Contains("your own address", Str(self, "error"), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AIFunctionsDriveTheToolsThroughMeai()
    {
        await using var h = await StartAsync();
        var prompt = h.Tools.AsAITools().OfType<AIFunction>().Single(f => f.Name == AgentToolNames.PromptAgent);
        var result = await prompt.InvokeAsync(new AIFunctionArguments { ["address"] = h.Address, ["prompt"] = "via meai" });
        var json = JsonNode.Parse(((System.Text.Json.JsonElement)result!).GetRawText())!.AsObject();
        Assert.Equal("echo: via meai", Str(json, "reply"));
    }
}
