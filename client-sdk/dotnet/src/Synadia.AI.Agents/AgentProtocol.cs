namespace Synadia.AI.Agents;

/// <summary>
/// Constants fixed by the Synadia Agent Protocol for NATS (spec §2, §3).
/// </summary>
public static class AgentProtocol
{
    /// <summary>Spec §3.1: the micro-service <c>name</c> that gates discovery.</summary>
    public const string ServiceName = "agents";

    /// <summary>Spec §3.3: queue group the <c>prompt</c> endpoint MUST register with.</summary>
    public const string PromptQueueGroup = "agents";

    /// <summary>Spec §8.7: queue group of the <c>status</c> endpoint (same as prompt).</summary>
    public const string StatusQueueGroup = "agents";

    /// <summary>Name of the prompt endpoint.</summary>
    public const string PromptEndpointName = "prompt";

    /// <summary>Name of the status endpoint (§8.7).</summary>
    public const string StatusEndpointName = "status";

    /// <summary>Heartbeat wildcard (§8.1): <c>agents.hb.&lt;agent&gt;.&lt;owner&gt;.&lt;name&gt;</c>.</summary>
    public const string HeartbeatWildcard = "agents.hb.*.*.*";

    /// <summary>Header carrying the §9.1 service error code.</summary>
    public const string ErrorCodeHeader = "Nats-Service-Error-Code";

    /// <summary>Header carrying the §9.1 service error description.</summary>
    public const string ErrorHeader = "Nats-Service-Error";

    /// <summary>Prompt endpoint metadata key: max request size (§2.1).</summary>
    public const string MaxPayloadKey = "max_payload";

    /// <summary>Prompt endpoint metadata key: whether attachments are accepted (§2.1).</summary>
    public const string AttachmentsOkKey = "attachments_ok";

    /// <summary>Prompt endpoint metadata key: minimum sender trust (sender-identity extension).</summary>
    public const string MinSenderTrustKey = "min_sender_trust";

    /// <summary>Default heartbeat cadence (§8.2).</summary>
    public static readonly TimeSpan DefaultHeartbeatInterval = TimeSpan.FromSeconds(30);

    /// <summary>Default caller-side inactivity timeout for prompt streams (§6.6).</summary>
    public static readonly TimeSpan DefaultInactivityTimeout = TimeSpan.FromSeconds(60);

    /// <summary>Default caller-side overall deadline for prompt streams.</summary>
    public static readonly TimeSpan DefaultPromptMaxWait = TimeSpan.FromMinutes(10);

    /// <summary>Default timeout of a status request (§8.7).</summary>
    public static readonly TimeSpan DefaultStatusTimeout = TimeSpan.FromSeconds(2);

    /// <summary>Default discovery stall window: stop once no reply arrived for this long.</summary>
    public static readonly TimeSpan DefaultDiscoverStall = TimeSpan.FromMilliseconds(750);

    /// <summary>Default discovery overall cap.</summary>
    public static readonly TimeSpan DefaultDiscoverMaxWait = TimeSpan.FromMilliseconds(2000);

    /// <summary>Liveness slack: online iff the last heartbeat is within <c>3 × interval_s</c> (§8.2).</summary>
    public const int LivenessSlack = 3;
}
