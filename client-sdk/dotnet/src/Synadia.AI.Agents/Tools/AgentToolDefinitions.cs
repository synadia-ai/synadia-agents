using System.Text.Json;
using System.Text.Json.Nodes;

namespace Synadia.AI.Agents.Tools;

/// <summary>The six agent tools, by name, as the contract (<c>docs/agent-tools.md</c>) defines them.</summary>
public static class AgentToolNames
{
    /// <summary><c>discover_agents</c>: list the agents on the network.</summary>
    public const string DiscoverAgents = "discover_agents";
    /// <summary><c>prompt_agent</c>: send one agent a prompt.</summary>
    public const string PromptAgent = "prompt_agent";
    /// <summary><c>wait_agent</c>: collect the result of detached calls.</summary>
    public const string WaitAgent = "wait_agent";
    /// <summary><c>answer_agent</c>: answer a question a prompted agent asked.</summary>
    public const string AnswerAgent = "answer_agent";
    /// <summary><c>cancel_agent</c>: stop calls.</summary>
    public const string CancelAgent = "cancel_agent";
    /// <summary><c>list_agent_calls</c>: list the calls tracked.</summary>
    public const string ListAgentCalls = "list_agent_calls";

    /// <summary>All six, in the contract's order.</summary>
    public static IReadOnlyList<string> All { get; } =
        [DiscoverAgents, PromptAgent, WaitAgent, AnswerAgent, CancelAgent, ListAgentCalls];

    /// <summary>The three an agent offers when it runs no calls at once: discover, prompt, answer.</summary>
    public static IReadOnlyList<string> Blocking { get; } = [DiscoverAgents, PromptAgent, AnswerAgent];

    /// <summary>Whether <paramref name="name"/> is one of the six.</summary>
    public static bool IsAgentTool(string name) => All.Contains(name, StringComparer.Ordinal);
}

/// <summary>
/// One tool as a model is shown it: a name, the description it reads, and its parameters as a
/// JSON Schema. A host maps it to its own tool format without changing a word.
/// </summary>
public sealed class AgentToolDefinition
{
    internal AgentToolDefinition(string name, string description, JsonObject parameters)
    {
        Name = name;
        Description = description;
        _parameters = parameters;
        ParametersSchema = JsonDocument.Parse(parameters.ToJsonString()).RootElement.Clone();
    }

    /// <summary>The tool's name.</summary>
    public string Name { get; }

    /// <summary>The description the model reads.</summary>
    public string Description { get; }

    /// <summary>The parameters JSON Schema, as a fresh mutable copy on every read.</summary>
    public JsonObject Parameters => (JsonObject)_parameters.DeepClone();
    private readonly JsonObject _parameters;

    /// <summary>The parameters JSON Schema as an immutable element.</summary>
    public JsonElement ParametersSchema { get; }
}

/// <summary>The embedded agent-tool definitions (copies of <c>test-fixtures/agent-tools/</c>).</summary>
public static class AgentToolDefinitions
{
    private static readonly Lazy<IReadOnlyDictionary<string, JsonObject>> s_raw = new(() =>
        AgentToolNames.All.ToDictionary(n => n, n => (JsonObject)JsonNode.Parse(Read(n))!, StringComparer.Ordinal));

    private static readonly Lazy<IReadOnlyDictionary<string, string>> s_blocking = new(() =>
    {
        var obj = (JsonObject)JsonNode.Parse(Read("blocking"))!;
        return obj.ToDictionary(kv => kv.Key, kv => kv.Value!.GetValue<string>(), StringComparer.Ordinal);
    });

    /// <summary>The raw embedded JSON text for <paramref name="name"/> (a tool name or <c>blocking</c>).</summary>
    public static string Read(string name)
    {
        using var stream = typeof(AgentToolDefinitions).Assembly.GetManifestResourceStream($"Synadia.AI.Agents.Tools.{name}.json")
            ?? throw new ArgumentException($"no embedded agent-tool definition named \"{name}\"", nameof(name));
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    /// <summary>All six definitions, in the contract's order.</summary>
    public static IReadOnlyList<AgentToolDefinition> All() => Offered(AgentToolNames.All);

    /// <summary>
    /// The definitions of the tools offered, in the contract's order. Without <c>wait_agent</c>
    /// nothing can be detached: each definition loses its <c>wait</c> parameter, and a description
    /// that mentions <c>wait_agent</c> is replaced by its blocking-only words from <c>blocking.json</c>.
    /// </summary>
    public static IReadOnlyList<AgentToolDefinition> Offered(IEnumerable<string> offered)
    {
        var set = new HashSet<string>(offered, StringComparer.Ordinal);
        var withWait = set.Contains(AgentToolNames.WaitAgent);
        var list = new List<AgentToolDefinition>();
        foreach (var name in AgentToolNames.All)
        {
            if (!set.Contains(name)) continue;
            var raw = (JsonObject)s_raw.Value[name].DeepClone();
            var description = raw["description"]!.GetValue<string>();
            var parameters = (JsonObject)raw["parameters"]!;
            if (!withWait)
            {
                ((JsonObject?)parameters["properties"])?.Remove("wait");
                if (description.Contains(AgentToolNames.WaitAgent, StringComparison.Ordinal))
                {
                    description = s_blocking.Value.TryGetValue(name, out var blocking)
                        ? blocking
                        : throw new InvalidOperationException($"AgentTools: no blocking-only description for {name}");
                }
            }
            parameters.Parent?.AsObject().Remove("parameters");
            list.Add(new AgentToolDefinition(name, description, parameters));
        }
        return list;
    }
}
