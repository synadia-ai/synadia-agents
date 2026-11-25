using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.AI;
using NATS.Client.Core;
using Synadia.AI.Agents.Tools;

namespace Synadia.AI.Agents.Tests;

public class AgentToolDefinitionTests
{
    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "agent-tools", name));

    private static JsonObject FixtureTool(string tool) => (JsonObject)JsonNode.Parse(Fixture(tool + ".json"))!;

    public static TheoryData<string> ToolNames() => [.. AgentToolNames.All];

    [Theory]
    [MemberData(nameof(ToolNames))]
    public void EmbeddedCopyEqualsFixture(string tool)
    {
        Assert.True(JsonNode.DeepEquals(FixtureTool(tool), JsonNode.Parse(AgentToolDefinitions.Read(tool))));
    }

    [Fact]
    public void EmbeddedBlockingEqualsFixture()
    {
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(Fixture("blocking.json")), JsonNode.Parse(AgentToolDefinitions.Read("blocking"))));
    }

    [Fact]
    public void AllDefinitionsMatchFixturesInContractOrder()
    {
        var defs = AgentToolDefinitions.All();
        Assert.Equal(AgentToolNames.All, defs.Select(d => d.Name));
        foreach (var def in defs)
        {
            var fixture = FixtureTool(def.Name);
            Assert.Equal(fixture["description"]!.GetValue<string>(), def.Description);
            Assert.True(JsonNode.DeepEquals(fixture["parameters"], def.Parameters));
            Assert.True(JsonNode.DeepEquals(fixture["parameters"], JsonNode.Parse(def.ParametersSchema.GetRawText())));
        }
    }

    [Fact]
    public void BlockingSetDropsWaitAndSwapsDescriptions()
    {
        var blocking = (JsonObject)JsonNode.Parse(Fixture("blocking.json"))!;
        var defs = AgentToolDefinitions.Offered(AgentToolNames.Blocking);
        Assert.Equal(AgentToolNames.Blocking, defs.Select(d => d.Name));
        foreach (var def in defs)
        {
            var fixture = FixtureTool(def.Name);
            var expectedParameters = (JsonObject)fixture["parameters"]!.DeepClone();
            ((JsonObject)expectedParameters["properties"]!).Remove("wait");
            Assert.True(JsonNode.DeepEquals(expectedParameters, def.Parameters));
            Assert.DoesNotContain("wait_agent", def.Description, StringComparison.Ordinal);
            var expectedDescription = blocking[def.Name]?.GetValue<string>() ?? fixture["description"]!.GetValue<string>();
            Assert.Equal(expectedDescription, def.Description);
        }
    }

    [Fact]
    public void ParametersIsAFreshCopy()
    {
        var def = AgentToolDefinitions.All()[1];
        def.Parameters["mutated"] = true;
        Assert.False(def.Parameters.ContainsKey("mutated"));
    }

    [Fact]
    public async Task AsAIToolsSchemasAreFixtureTextVerbatim()
    {
        await using var tools = new AgentTools(new AgentsClient(new NatsConnection()));
        var functions = tools.AsAITools().Cast<AIFunction>().ToList();
        Assert.Equal(AgentToolNames.All, functions.Select(f => f.Name));
        foreach (var f in functions)
        {
            var fixture = FixtureTool(f.Name);
            Assert.Equal(fixture["description"]!.GetValue<string>(), f.Description);
            Assert.True(JsonNode.DeepEquals(fixture["parameters"], JsonNode.Parse(f.JsonSchema.GetRawText())));
        }
    }

    [Theory]
    [InlineData("wait_agent")]
    [InlineData("prompt_agent")]
    [InlineData("prompt_agent,nope")]
    public void InvalidToolSetsThrow(string set)
    {
        Assert.ThrowsAny<ArgumentException>(() => new AgentTools(new AgentsClient(new NatsConnection()), new AgentToolsOptions { Tools = set.Split(',') }));
    }

    [Theory]
    [InlineData("prompt_agent", """{"prompt":"hi"}""", "prompt_agent: \"address\" is required, as discover_agents returned it")]
    [InlineData("prompt_agent", """{"address":"agents.prompt.a.b.c","prompt":""}""", "prompt_agent: \"prompt\" is required and must not be empty")]
    [InlineData("prompt_agent", """{"address":"agents.prompt.a.b.c","prompt":"x","wait":"no"}""", "prompt_agent: \"wait\" must be true or false")]
    [InlineData("prompt_agent", """{"address":"agents.prompt.a.b.c","prompt":"x","attachments":"a.txt"}""", "prompt_agent: \"attachments\" must be a list of file paths")]
    [InlineData("answer_agent", """{"answer":"yes"}""", "answer_agent: \"call_id\" is required, as it came with the question")]
    [InlineData("wait_agent", """{"call_ids":["x"],"timeout_ms":-1}""", "wait_agent: \"timeout_ms\" must be a whole number of milliseconds, 0 or more")]
    public async Task BadArgumentsAreRefusedWithoutACall(string tool, string args, string error)
    {
        await using var tools = new AgentTools(new AgentsClient(new NatsConnection()));
        var result = await tools.ExecuteAsync(tool, args);
        Assert.Equal(error, result["error"]!.GetValue<string>());
        Assert.False(result.ContainsKey("call_id"));
    }

    [Fact]
    public async Task UnknownCallIdsAreRefused()
    {
        await using var tools = new AgentTools(new AgentsClient(new NatsConnection()));
        var result = await tools.ExecuteAsync(AgentToolNames.AnswerAgent, """{"call_id":"nope","answer":"x"}""");
        Assert.True(result.ContainsKey("error"));
        var list = await tools.ExecuteAsync(AgentToolNames.ListAgentCalls, "{}");
        Assert.Empty(list["calls"]!.AsArray());
    }

    [Fact]
    public async Task ToolNotOfferedIsRefused()
    {
        await using var tools = new AgentTools(new AgentsClient(new NatsConnection()), new AgentToolsOptions { Tools = AgentToolNames.Blocking });
        var result = await tools.ExecuteAsync(AgentToolNames.WaitAgent, """{"call_ids":["x"]}""");
        Assert.StartsWith("the tool \"wait_agent\" is not offered", result["error"]!.GetValue<string>(), StringComparison.Ordinal);
    }
}

public class AttachmentSaverTests
{
    private static JsonDocument Fixture(string name)
        => JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "attachments", name)));

    // System.Text.Json refuses lone surrogates (the fixture has "\ud800"); JS and Python keep them, so unescape by hand.
    private static string JsonStringLenient(JsonElement element)
    {
        var raw = element.GetRawText();
        var sb = new System.Text.StringBuilder(raw.Length);
        for (var i = 1; i < raw.Length - 1; i++)
        {
            var c = raw[i];
            if (c != '\\') { sb.Append(c); continue; }
            c = raw[++i];
            sb.Append(c switch
            {
                'b' => '\b',
                'f' => '\f',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                'u' => (char)Convert.ToInt32(raw.Substring(i + 1, 4), 16),
                _ => c,
            });
            if (c == 'u') i += 4;
        }
        return sb.ToString();
    }

    [Fact]
    public void SafeNamesMatchFixture()
    {
        using var doc = Fixture("save-names.json");
        var max = doc.RootElement.GetProperty("max_name_bytes").GetInt32();
        var rows = doc.RootElement.GetProperty("names").EnumerateArray().ToList();
        Assert.NotEmpty(rows);
        foreach (var row in rows)
        {
            var input = JsonStringLenient(row.GetProperty("input"));
            var position = row.TryGetProperty("position", out var p) ? p.GetInt32() : 1;
            var expected = JsonStringLenient(row.GetProperty("expected"));
            var actual = AttachmentSaver.SafeName(input, position);
            Assert.True(expected == actual, $"{row.GetProperty("note").GetString()}: expected \"{expected}\", got \"{actual}\"");
            Assert.True(System.Text.Encoding.UTF8.GetByteCount(actual) <= max);
        }
    }

    [Fact]
    public void StrictBase64MatchesFixture()
    {
        using var doc = Fixture("base64-content.json");
        foreach (var row in doc.RootElement.GetProperty("cases").EnumerateArray())
        {
            var content = row.GetProperty("content").GetString()!;
            if (row.GetProperty("valid").GetBoolean())
                Assert.Equal(row.GetProperty("hex").GetString(), Convert.ToHexString(PromptEnvelope.DecodeStrictBase64(content)).ToLowerInvariant());
            else
                Assert.Throws<FormatException>(() => PromptEnvelope.DecodeStrictBase64(content));
        }
    }

    [Fact]
    public async Task SaveWritesUniqueFilesAndHonoursTheLimit()
    {
        var dir = Path.Combine(Path.GetTempPath(), "saver-" + Guid.NewGuid().ToString("N"));
        try
        {
            var saved = await AttachmentSaver.SaveAsync(
                [
                    PromptEnvelope.CreateAttachment("a.txt", "one"u8.ToArray()),
                    PromptEnvelope.CreateAttachment("a.txt", "two"u8.ToArray()),
                    PromptEnvelope.CreateAttachment("../evil.txt", "xyz"u8.ToArray()),
                    PromptEnvelope.CreateAttachment("big.bin", new byte[10]),
                ],
                dir, maxTotalBytes: 12);
            Assert.Equal(4, saved.Count);
            Assert.Equal("one", File.ReadAllText(saved[0].Path!));
            Assert.Equal("two", File.ReadAllText(saved[1].Path!));
            Assert.NotEqual(saved[0].Path, saved[1].Path);
            Assert.Equal(Path.GetFullPath(dir), Path.GetDirectoryName(saved[2].Path!));
            Assert.Null(saved[3].Path);
            Assert.Equal(AttachmentSkipReason.OverLimit, saved[3].Skipped);

            var invalid = await AttachmentSaver.SaveAsync([("bad.txt", "not base64!")], dir);
            Assert.Equal(AttachmentSkipReason.InvalidContent, Assert.Single(invalid).Skipped);
            Assert.Equal(0, invalid[0].SizeBytes);
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }
}
