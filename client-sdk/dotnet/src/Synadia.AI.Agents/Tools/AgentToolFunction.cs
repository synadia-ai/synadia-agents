using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.AI;
using Identity_ = Synadia.AI.Agents.Identity;

namespace Synadia.AI.Agents.Tools;

/// <summary>An agent's identity as discovery sees it (sender-identity extension, §13).</summary>
internal static class AgentIdentityView
{
    /// <summary>The agent ID registered via <c>user_nkey</c> + <c>account</c> metadata (<c>{account}.{user}</c>), or null.</summary>
    public static string? Identity(Agent agent)
    {
        var md = agent.Info.Metadata;
        if (!md.TryGetValue(Identity_.AgentIdSignature.UserNkeyKey, out var user) ||
            !md.TryGetValue(Identity_.AgentIdSignature.AccountKey, out var account))
        {
            return null;
        }
        return Identity_.AgentId.TryParse($"{account}.{user}", out var id) ? id.ToString() : null;
    }

    /// <summary>True iff <c>id_sig</c> is present and verifies over the instance's prompt subject.</summary>
    public static bool Verified(Agent agent)
        => agent.Info.Metadata.ContainsKey(Identity_.AgentIdSignature.IdSigKey)
           && Identity_.AgentIdSignature.Verify(agent.Info.Metadata, agent.PromptSubject);
}

/// <summary>One agent tool as a Microsoft.Extensions.AI function; its schema is the contract's text verbatim.</summary>
internal sealed class AgentToolFunction : AIFunction
{
    private readonly AgentTools _tools;
    private readonly AgentToolDefinition _definition;

    public AgentToolFunction(AgentTools tools, AgentToolDefinition definition)
    {
        _tools = tools;
        _definition = definition;
    }

    public override string Name => _definition.Name;

    public override string Description => _definition.Description;

    public override JsonElement JsonSchema => _definition.ParametersSchema;

    public override JsonSerializerOptions JsonSerializerOptions => AIJsonUtilities.DefaultOptions;

    protected override async ValueTask<object?> InvokeCoreAsync(AIFunctionArguments arguments, CancellationToken cancellationToken)
    {
        var args = new JsonObject();
        foreach (var kv in arguments)
            args[kv.Key] = ToNode(kv.Value);
        var result = await _tools.ExecuteAsync(_definition.Name, args, toolCallId: null, cancellationToken).ConfigureAwait(false);
        return JsonDocument.Parse(result.ToJsonString()).RootElement.Clone();
    }

    private static JsonNode? ToNode(object? value) => value switch
    {
        null => null,
        JsonNode node => node.DeepClone(),
        JsonElement element => JsonNode.Parse(element.GetRawText()),
        string s => JsonValue.Create(s),
        bool b => JsonValue.Create(b),
        int i => JsonValue.Create(i),
        long l => JsonValue.Create(l),
        double d => JsonValue.Create(d),
        _ => JsonSerializer.SerializeToNode(value, AIJsonUtilities.DefaultOptions.GetTypeInfo(value.GetType())),
    };
}
