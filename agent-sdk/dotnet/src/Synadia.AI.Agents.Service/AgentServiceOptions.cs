using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Synadia.AI.Agents.Service;

/// <summary>Configuration of an <see cref="AgentService"/> registration.</summary>
public sealed class AgentServiceOptions
{
    /// <summary>§2 <c>agent</c> token — the harness/agent type (e.g. <c>claude-code</c>). Required.</summary>
    public required string Agent { get; init; }

    /// <summary>§2 <c>owner</c> token — who runs it. Required.</summary>
    public required string Owner { get; init; }

    /// <summary>§2 <c>name</c> token — the session/instance name this registration serves. Required.</summary>
    public required string Name { get; init; }

    /// <summary>Optional session label advertised in metadata and heartbeats.</summary>
    public string? Session { get; init; }

    /// <summary><c>$SRV.INFO</c> description. Default: <c>"{agent} agent {name}"</c>.</summary>
    public string? Description { get; init; }

    /// <summary><c>$SRV.INFO</c> version. Default <c>0.0.1</c> (matches the TypeScript and Python hosts).</summary>
    public string Version { get; init; } = "0.0.1";

    /// <summary>Extra service metadata. Required protocol keys always win over these.</summary>
    public IReadOnlyDictionary<string, string>? ExtraMetadata { get; init; }

    /// <summary>§2.1 <c>attachments_ok</c>. Default <c>true</c>.</summary>
    public bool AttachmentsOk { get; init; } = true;

    /// <summary>
    /// §2.1 <c>max_payload</c> override in bytes. Clamped to the server's negotiated limit; when null the server
    /// limit is advertised (or <c>1MB</c> if the server reported none).
    /// </summary>
    public long? MaxPayload { get; init; }

    /// <summary>§8.2 heartbeat cadence. Default 30 s.</summary>
    public TimeSpan HeartbeatInterval { get; init; } = AgentProtocol.DefaultHeartbeatInterval;

    /// <summary>Periodic keep-alive <c>ack</c> cadence while a handler runs (§6.4). <c>null</c> disables. Default 30 s.</summary>
    public TimeSpan? KeepAliveInterval { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>Sender-identity <c>min_sender_trust</c> advertised on the prompt endpoint: <c>any</c> (default) or <c>signed</c>.
    /// With <c>signed</c>, prompts without a verified <c>Agent-Sender</c> are refused with <c>401 signature required</c>.</summary>
    public string MinSenderTrust { get; init; } = "any";

    /// <summary>
    /// Host sender identity (§13). <c>null</c> (default): no self lookup and no <c>user_nkey</c> / <c>account</c> /
    /// <c>id_sig</c> metadata. An instance without a signer registers unsigned identity metadata (best effort); with a
    /// signer, startup fails unless it binds to the live connection, and <c>id_sig</c> plus signed heartbeats are added.
    /// Classifying inbound senders does not require this.
    /// </summary>
    public AgentServiceIdentityOptions? Identity { get; init; }

    /// <summary>Replay window for <c>Agent-Sender</c> <c>ts</c> and the nonce cache. Default 30 s.</summary>
    public TimeSpan ReplayWindow { get; init; } = global::Synadia.AI.Agents.Identity.SenderHeader.DefaultReplayWindow;

    /// <summary>
    /// Optional final admission hook, run after classification and before the ack. <c>false</c> for a verified sender
    /// → <c>403 sender rejected</c>; for a claimed / absent one → <c>401 signature required</c>; a throw → <c>500</c>.
    /// </summary>
    public AcceptSenderHook? AcceptSender { get; init; }

    /// <summary>
    /// Operator-attested mode (off by default). Enable only when the deployment has closed this endpoint so every
    /// request crossed a service import and <c>Nats-Request-Info</c> is the server's stamp; signed account / user must
    /// then agree with it.
    /// </summary>
    public bool OperatorAttested { get; init; }

    /// <summary>
    /// 1-based token position at which the server inserts the importing account into the arrival subject (cross-account
    /// <c>{{account}}</c> import mappings). <c>null</c> (default): the signed <c>sub</c> must equal the arrival subject.
    /// </summary>
    public int? AccountTokenPosition { get; init; }

    /// <summary>Default timeout for <see cref="PromptStream.AskAsync(string, IEnumerable{Microsoft.Extensions.AI.DataContent}?, TimeSpan?, CancellationToken)"/>.</summary>
    public TimeSpan DefaultQueryTimeout { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>Provider of extra heartbeat fields, read on every beat. Reserved §8.3 keys are refused.</summary>
    public Func<IReadOnlyDictionary<string, JsonElement>>? HeartbeatExtras { get; init; }

    /// <summary>How long <see cref="AgentService.StopAsync"/> waits for in-flight prompts after cancelling them.</summary>
    public TimeSpan DrainTimeout { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>Logger.</summary>
    public ILogger? Logger { get; init; }

    /// <summary>Clock (tests).</summary>
    public TimeProvider? TimeProvider { get; init; }
}

/// <summary>Host sender-identity settings (see <see cref="AgentServiceOptions.Identity"/>).</summary>
public sealed class AgentServiceIdentityOptions
{
    /// <summary>Signer for <c>id_sig</c> and heartbeats; must be the connection's user NKEY. <c>null</c> for unsigned metadata.</summary>
    public global::Synadia.AI.Agents.Identity.ISenderSigner? Signer { get; init; }
}
