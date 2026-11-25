using System.Text.Json.Serialization;

namespace Synadia.AI.Agents;

/// <summary>One endpoint from a <c>$SRV.INFO</c> record (spec §2.1, §4.3).</summary>
public sealed record AgentEndpointInfo
{
    /// <summary>Endpoint name (<c>prompt</c>, <c>status</c>, …).</summary>
    public required string Name { get; init; }

    /// <summary>Subject the endpoint listens on.</summary>
    public required string Subject { get; init; }

    /// <summary>Queue group; empty when none. Spec §3.3 requires <c>agents</c> on <c>prompt</c>.</summary>
    public string QueueGroup { get; init; } = "";

    /// <summary>Raw endpoint metadata (unknown keys preserved).</summary>
    public IReadOnlyDictionary<string, string> Metadata { get; init; } = new Dictionary<string, string>();

    /// <summary><c>max_payload</c> in bytes, when declared and parseable (prompt endpoint only).</summary>
    public long? MaxPayloadBytes { get; init; }

    /// <summary><c>attachments_ok</c>, when declared (prompt endpoint only).</summary>
    public bool? AttachmentsOk { get; init; }

    /// <summary>
    /// <c>min_sender_trust</c> (sender-identity extension), when declared. <c>"any"</c> verbatim; any other value
    /// is treated as <c>"signed"</c> — the strictest level a caller can satisfy.
    /// </summary>
    public string? MinSenderTrust { get; init; }

    internal static AgentEndpointInfo From(SrvEndpointDto raw)
    {
        var metadata = raw.Metadata is null
            ? new Dictionary<string, string>()
            : new Dictionary<string, string>(raw.Metadata, StringComparer.Ordinal);
        var info = new AgentEndpointInfo
        {
            Name = raw.Name ?? "",
            Subject = raw.Subject ?? "",
            QueueGroup = raw.QueueGroup ?? "",
            Metadata = metadata,
        };
        if (info.Name != AgentProtocol.PromptEndpointName) return info;

        long? maxPayload = metadata.TryGetValue(AgentProtocol.MaxPayloadKey, out var mp) && HumanBytes.TryParse(mp, out var b) ? b : null;
        bool? attachmentsOk = metadata.TryGetValue(AgentProtocol.AttachmentsOkKey, out var ao)
            ? ao switch { "true" => true, "false" => false, _ => null }
            : null;
        string? minTrust = metadata.TryGetValue(AgentProtocol.MinSenderTrustKey, out var mst)
            ? (mst == "any" ? "any" : "signed")
            : null;
        return info with { MaxPayloadBytes = maxPayload, AttachmentsOk = attachmentsOk, MinSenderTrust = minTrust };
    }
}

/// <summary>
/// The pure-data view of one running agent instance, assembled from its <c>$SRV.INFO</c> record (spec §4.3).
/// </summary>
public sealed record AgentInfo
{
    /// <summary>Service id — unique per running instance; equals <c>heartbeat.instance_id</c>.</summary>
    public required string InstanceId { get; init; }

    /// <summary><c>metadata.agent</c> (harness id).</summary>
    public required string Agent { get; init; }

    /// <summary><c>metadata.owner</c>.</summary>
    public required string Owner { get; init; }

    /// <summary>Instance name: 5th token of the prompt subject (empty when the subject is non-standard).</summary>
    public required string Name { get; init; }

    /// <summary><c>metadata.session</c> when present and non-empty.</summary>
    public string? Session { get; init; }

    /// <summary><c>metadata.protocol_version</c> verbatim.</summary>
    public required string ProtocolVersion { get; init; }

    /// <summary>Service description.</summary>
    public string Description { get; init; } = "";

    /// <summary>Harness version (service <c>version</c>).</summary>
    public string Version { get; init; } = "";

    /// <summary>Full service metadata; unknown keys preserved.</summary>
    public IReadOnlyDictionary<string, string> Metadata { get; init; } = new Dictionary<string, string>();

    /// <summary>All endpoints the instance registered.</summary>
    public IReadOnlyList<AgentEndpointInfo> Endpoints { get; init; } = [];

    /// <summary>The <c>prompt</c> endpoint (always present on a valid record).</summary>
    public required AgentEndpointInfo PromptEndpoint { get; init; }

    /// <summary>The <c>status</c> endpoint, when registered (§8.7).</summary>
    public AgentEndpointInfo? StatusEndpoint => Endpoints.FirstOrDefault(e => e.Name == AgentProtocol.StatusEndpointName);

    /// <summary>True iff the prompt endpoint advertises <c>min_sender_trust</c> (sender-identity extension).</summary>
    public bool SupportsSenderIdentity => PromptEndpoint.MinSenderTrust is not null;

    /// <summary>Compatibility of <see cref="ProtocolVersion"/> with this SDK (§11.1); <c>null</c> when unparseable.</summary>
    public VersionCompatibility? Compatibility
        => global::Synadia.AI.Agents.ProtocolVersion.TryParse(ProtocolVersion, out var v) ? v.CompareTo() : null;

    /// <summary>The subject address, when the prompt subject follows the v0.3 layout.</summary>
    public AgentSubject? Subject
        => AgentSubject.TryParse(PromptEndpoint.Subject, out var s, out var verb) && verb == "prompt" ? s : null;

    /// <summary>
    /// Build an <see cref="AgentInfo"/> from a raw record; <c>null</c> when it is not a protocol-compliant agent.
    /// </summary>
    internal static AgentInfo? From(SrvInfoDto info)
    {
        if (info.Name != AgentProtocol.ServiceName || string.IsNullOrEmpty(info.Id)) return null;
        var metadata = info.Metadata ?? new Dictionary<string, string>();
        if (!metadata.TryGetValue("agent", out var agent) ||
            !metadata.TryGetValue("owner", out var owner) ||
            !metadata.TryGetValue("protocol_version", out var pv))
        {
            return null;
        }
        var endpoints = (info.Endpoints ?? []).Select(AgentEndpointInfo.From).ToArray();
        var prompt = endpoints.FirstOrDefault(e => e.Name == AgentProtocol.PromptEndpointName);
        if (prompt is null) return null;
        var tokens = prompt.Subject.Split('.');
        var name = tokens.Length > 4 ? tokens[4] : "";
        metadata.TryGetValue("session", out var session);
        return new AgentInfo
        {
            InstanceId = info.Id!,
            Agent = agent,
            Owner = owner,
            Name = name,
            Session = string.IsNullOrEmpty(session) ? null : session,
            ProtocolVersion = pv,
            Description = info.Description ?? "",
            Version = info.Version ?? "",
            Metadata = new Dictionary<string, string>(metadata, StringComparer.Ordinal),
            Endpoints = endpoints,
            PromptEndpoint = prompt,
        };
    }
}

internal sealed class SrvInfoDto
{
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("id")] public string? Id { get; set; }
    [JsonPropertyName("version")] public string? Version { get; set; }
    [JsonPropertyName("description")] public string? Description { get; set; }
    [JsonPropertyName("metadata")] public Dictionary<string, string>? Metadata { get; set; }
    [JsonPropertyName("endpoints")] public List<SrvEndpointDto>? Endpoints { get; set; }
}

internal sealed class SrvEndpointDto
{
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("subject")] public string? Subject { get; set; }
    [JsonPropertyName("queue_group")] public string? QueueGroup { get; set; }
    [JsonPropertyName("metadata")] public Dictionary<string, string>? Metadata { get; set; }
}

internal sealed class SrvPingDto
{
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("id")] public string? Id { get; set; }
    [JsonPropertyName("version")] public string? Version { get; set; }
    [JsonPropertyName("metadata")] public Dictionary<string, string>? Metadata { get; set; }
}

[JsonSourceGenerationOptions(DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(SrvInfoDto))]
[JsonSerializable(typeof(SrvPingDto))]
internal sealed partial class AgentsJsonContext : JsonSerializerContext;
