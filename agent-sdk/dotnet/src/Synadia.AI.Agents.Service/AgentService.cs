using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using NATS.Client.Core;
using NATS.Client.Services;
using Synadia.AI.Agents.Identity;

namespace Synadia.AI.Agents.Service;

/// <summary>Handles one prompt. Write chunks to <paramref name="stream"/>; return to end the stream.</summary>
/// <param name="context">The decoded request.</param>
/// <param name="stream">Where to write chunks / ask queries.</param>
/// <param name="cancellationToken">Cancelled when the service stops.</param>
public delegate Task PromptHandler(PromptContext context, PromptStream stream, CancellationToken cancellationToken);

/// <summary>
/// Hosts one agent registration on NATS (spec §3): an <c>agents</c> micro service with a <c>prompt</c> endpoint
/// (queue <c>agents</c>), a <c>status</c> endpoint and periodic heartbeats on <c>agents.hb.{agent}.{owner}.{name}</c>.
/// </summary>
/// <remarks>
/// Per request the service decodes the envelope (400 on failure), sends the leading <c>ack</c> (§6.4) and periodic
/// keep-alives, runs the handler, maps exceptions to a §9 error frame, and always ends with the empty terminator (§6.5).
/// </remarks>
public sealed class AgentService : IAsyncDisposable
{
    private readonly INatsConnection _nc;
    private readonly AgentServiceOptions _options;
    private readonly ILogger _logger;
    private readonly TimeProvider _time;
    private readonly ConcurrentDictionary<Task, byte> _inflight = new();
    private PromptHandler? _handler;
    private INatsSvcServer? _service;
    private CancellationTokenSource? _cts;
    private Task? _heartbeatLoop;
    private Dictionary<string, string>? _promptMetadata;
    private readonly SenderGate _gate;
    private ISenderSigner? _heartbeatSigner;

    /// <summary>Create (not yet started) a registration.</summary>
    public AgentService(INatsConnection connection, AgentServiceOptions options)
    {
        _nc = connection ?? throw new ArgumentNullException(nameof(connection));
        _options = options ?? throw new ArgumentNullException(nameof(options));
        Subject = AgentSubject.Create(options.Agent, options.Owner, options.Name);
        if (options.MinSenderTrust is not ("any" or "signed"))
        {
            throw new ArgumentException("MinSenderTrust must be \"any\" or \"signed\"", nameof(options));
        }
        if (options.HeartbeatInterval <= TimeSpan.Zero) throw new ArgumentException("HeartbeatInterval must be positive", nameof(options));
        if (options.KeepAliveInterval is { } k && k <= TimeSpan.Zero) throw new ArgumentException("KeepAliveInterval must be positive", nameof(options));
        _logger = options.Logger ?? NullLogger.Instance;
        _time = options.TimeProvider ?? TimeProvider.System;
        if (options.ReplayWindow <= TimeSpan.Zero) throw new ArgumentException("ReplayWindow must be positive", nameof(options));
        _gate = new SenderGate(options.MinSenderTrust, options.ReplayWindow, options.AccountTokenPosition, options.OperatorAttested,
            options.AcceptSender, logger: _logger, timeProvider: _time);
    }

    /// <summary>The host's own identity (bound at start when <see cref="AgentServiceOptions.Identity"/> is set), else <c>null</c>.</summary>
    public AgentId? Identity { get; private set; }

    /// <summary>The inbound sender classifier (replay cache, <c>min_sender_trust</c>, accept hook).</summary>
    public SenderGate SenderGate => _gate;

    /// <summary>The registration's subjects.</summary>
    public AgentSubject Subject { get; }

    /// <summary>Options.</summary>
    public AgentServiceOptions Options => _options;

    /// <summary>The NATS connection.</summary>
    public INatsConnection Connection => _nc;

    /// <summary>The micro-service instance id (<c>$SRV.INFO</c> <c>id</c>, heartbeat <c>instance_id</c>); null before start.</summary>
    public string? InstanceId { get; private set; }

    /// <summary>Whether <see cref="StartAsync"/> completed and <see cref="StopAsync"/> has not run.</summary>
    public bool IsRunning => _service is not null;

    /// <summary>The effective <c>max_payload</c> advertised on the prompt endpoint (after start).</summary>
    public string? AdvertisedMaxPayload => _promptMetadata?[AgentProtocol.MaxPayloadKey];

    /// <summary>Set the prompt handler (must be called before <see cref="StartAsync"/>).</summary>
    public AgentService OnPrompt(PromptHandler handler)
    {
        if (_service is not null) throw new InvalidOperationException("cannot change the handler after StartAsync");
        _handler = handler ?? throw new ArgumentNullException(nameof(handler));
        return this;
    }

    /// <summary>
    /// Register with NATS. When this returns the endpoints are live at the server and the first heartbeat is out.
    /// </summary>
    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (_handler is null) throw new InvalidOperationException("call OnPrompt (or ServeChatClient) before StartAsync");
        if (_service is not null) throw new InvalidOperationException("already started");

        await _nc.ConnectAsync().ConfigureAwait(false);
        var metadata = new Dictionary<string, string>(StringComparer.Ordinal);
        if (_options.ExtraMetadata is not null)
        {
            foreach (var (k, v) in _options.ExtraMetadata) metadata[k] = v;
        }
        metadata["agent"] = Subject.Agent;
        metadata["owner"] = Subject.Owner;
        metadata["protocol_version"] = ProtocolVersion.Sdk.ToString();
        if (_options.Session is not null) metadata["session"] = _options.Session;
        else metadata.Remove("session");

        AgentId? identity = null;
        _heartbeatSigner = null;
        if (_options.Identity is { } idOptions)
        {
            try
            {
                identity = await SelfId.LookupAsync(_nc, idOptions.Signer, cancellationToken: cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (idOptions.Signer is null && ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "self-identity lookup failed; starting without identity metadata");
            }
        }
        if (identity is not null)
        {
            metadata[AgentIdSignature.UserNkeyKey] = identity.User;
            metadata[AgentIdSignature.AccountKey] = identity.Account;
            if (_options.Identity?.Signer is { } signer)
            {
                metadata[AgentIdSignature.IdSigKey] = await AgentIdSignature.SignAsync(signer, identity, Subject.Agent, Subject.Owner,
                    Subject.Prompt, cancellationToken).ConfigureAwait(false);
                _heartbeatSigner = signer;
            }
            else
            {
                metadata.Remove(AgentIdSignature.IdSigKey);
            }
        }
        else
        {
            metadata.Remove(AgentIdSignature.UserNkeyKey);
            metadata.Remove(AgentIdSignature.AccountKey);
            metadata.Remove(AgentIdSignature.IdSigKey);
        }
        Identity = identity;

        var svcContext = new NatsSvcContext(_nc);
        var config = new NatsSvcConfig(AgentProtocol.ServiceName, _options.Version)
        {
            Description = _options.Description ?? $"{Subject.Agent} agent {Subject.Name}",
            Metadata = metadata,
        };
        var service = await svcContext.AddServiceAsync(config, cancellationToken).ConfigureAwait(false);
        try
        {
            _promptMetadata = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [AgentProtocol.MaxPayloadKey] = EffectiveMaxPayload(),
                [AgentProtocol.AttachmentsOkKey] = _options.AttachmentsOk ? "true" : "false",
                [AgentProtocol.MinSenderTrustKey] = _options.MinSenderTrust,
            };
            _cts = new CancellationTokenSource();
            var stopping = _cts.Token;

            await service.AddEndpointAsync<byte[]>(msg =>
            {
                Track(DispatchPromptAsync(msg, stopping));
                return ValueTask.CompletedTask;
            }, AgentProtocol.PromptEndpointName, Subject.Prompt, AgentProtocol.PromptQueueGroup, _promptMetadata,
                cancellationToken: cancellationToken).ConfigureAwait(false);

            await service.AddEndpointAsync<byte[]>(msg =>
            {
                Track(DispatchStatusAsync(msg));
                return ValueTask.CompletedTask;
            }, AgentProtocol.StatusEndpointName, Subject.Status, AgentProtocol.StatusQueueGroup,
                cancellationToken: cancellationToken).ConfigureAwait(false);

            InstanceId = service.GetInfo().Id;
            // "Started" means registered at the server: flush before returning.
            await _nc.PingAsync(cancellationToken).ConfigureAwait(false);
            _service = service;

            await PublishHeartbeatAsync(cancellationToken).ConfigureAwait(false);
            _heartbeatLoop = Task.Run(() => HeartbeatLoopAsync(stopping), CancellationToken.None);
            _logger.LogInformation("agent {Agent}/{Owner}/{Name} listening on {Subject} (instance {Id})",
                Subject.Agent, Subject.Owner, Subject.Name, Subject.Prompt, InstanceId);
        }
        catch
        {
            _service = null;
            await service.StopAsync(CancellationToken.None).ConfigureAwait(false);
            throw;
        }
    }

    /// <summary>Deregister, stop heartbeats, and cancel/drain in-flight prompts (bounded by <see cref="AgentServiceOptions.DrainTimeout"/>).</summary>
    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        var service = _service;
        if (service is null) return;
        _service = null;
        _cts?.Cancel();
        try
        {
            await service.StopAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogDebug(ex, "service stop failed");
        }
        var pending = _inflight.Keys.ToArray();
        if (_heartbeatLoop is not null) pending = [.. pending, _heartbeatLoop];
        if (pending.Length > 0)
        {
            await Task.WhenAny(Task.WhenAll(pending), Task.Delay(_options.DrainTimeout, cancellationToken)).ConfigureAwait(false);
        }
        _cts?.Dispose();
        _cts = null;
        _heartbeatLoop = null;
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync() => await StopAsync().ConfigureAwait(false);

    /// <summary>Build the current heartbeat payload (also what the <c>status</c> endpoint returns).</summary>
    public HeartbeatPayload BuildHeartbeat()
    {
        var extras = (IReadOnlyDictionary<string, JsonElement>?)null;
        if (_options.HeartbeatExtras is { } provider)
        {
            try
            {
                var provided = provider();
                var clash = provided.Keys.Where(HeartbeatPayload.ReservedKeys.Contains).ToArray();
                if (clash.Length > 0)
                {
                    _logger.LogError("heartbeat extras reuse §8.3 field names ({Fields}); publishing without extras", string.Join(",", clash));
                }
                else
                {
                    extras = provided;
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "heartbeat extras provider failed; publishing without extras");
            }
        }
        return new HeartbeatPayload
        {
            Agent = Subject.Agent,
            Owner = Subject.Owner,
            Session = _options.Session,
            InstanceId = InstanceId ?? "",
            Timestamp = HeartbeatPayload.FormatTimestamp(_time.GetUtcNow()),
            IntervalSeconds = _options.HeartbeatInterval.TotalSeconds,
            ProtocolVersion = ProtocolVersion.Sdk.ToString(),
            Endpoints = _promptMetadata is null
                ? null
                : new Dictionary<string, HeartbeatEndpoint>
                {
                    [AgentProtocol.PromptEndpointName] = new(Subject.Prompt, new Dictionary<string, string>(_promptMetadata)),
                },
            Extras = extras ?? new Dictionary<string, JsonElement>(),
        };
    }

    private string EffectiveMaxPayload()
    {
        long? server = _nc.ServerInfo?.MaxPayload is > 0 and var mp ? mp : null;
        long? requested = _options.MaxPayload;
        if (requested is not null && requested <= 0) throw new ArgumentException("MaxPayload must be positive");
        if (requested is not null && server is not null) return HumanBytes.Format(Math.Min(requested.Value, server.Value));
        if (requested is not null) return HumanBytes.Format(requested.Value);
        if (server is not null) return HumanBytes.Format(server.Value);
        return "1MB";
    }

    private void Track(Task task)
    {
        _inflight.TryAdd(task, 0);
        _ = task.ContinueWith(t => _inflight.TryRemove(t, out _), CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    }

    private async Task HeartbeatLoopAsync(CancellationToken stopping)
    {
        using var timer = new PeriodicTimer(_options.HeartbeatInterval, _time);
        try
        {
            while (await timer.WaitForNextTickAsync(stopping).ConfigureAwait(false))
            {
                try
                {
                    await PublishHeartbeatAsync(stopping).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogWarning(ex, "heartbeat publish failed");
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    private async ValueTask PublishHeartbeatAsync(CancellationToken cancellationToken)
    {
        var payload = BuildHeartbeat();
        var data = payload.Encode();
        NatsHeaders? headers = null;
        if (_heartbeatSigner is { } signer && Identity is { } id)
        {
            try
            {
                var header = await SenderHeader.SignAsync(signer, id, Subject.Heartbeat, data, ts: payload.Timestamp,
                    cancellationToken: cancellationToken).ConfigureAwait(false);
                headers = new NatsHeaders { [SenderHeader.HeaderName] = SenderHeader.Serialize(header) };
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "heartbeat signing failed; publishing unsigned on {Subject}", Subject.Heartbeat);
            }
        }
        await _nc.PublishAsync(Subject.Heartbeat, data, headers, cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    private async Task DispatchStatusAsync(NatsSvcMsg<byte[]> msg)
    {
        await Task.Yield();
        try
        {
            var sender = _gate.ClassifyStatus(msg.Subject, msg.Data ?? [], msg.Headers);
            _logger.LogDebug("status request on {Subject} from {Sender}", msg.Subject, SenderHeader.Format(sender));
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "status sender classification failed");
        }
        try
        {
            await msg.ReplyAsync(BuildHeartbeat().Encode()).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "status reply failed");
        }
    }

    private async Task DispatchPromptAsync(NatsSvcMsg<byte[]> msg, CancellationToken stopping)
    {
        await Task.Yield(); // never run handler code on the endpoint loop
        if (string.IsNullOrEmpty(msg.ReplyTo))
        {
            _logger.LogDebug("dropping prompt without a reply subject on {Subject}", msg.Subject);
            return;
        }
        var stream = new PromptStream(_nc, msg.ReplyTo, _options.DefaultQueryTimeout);

        PromptEnvelope envelope;
        try
        {
            envelope = PromptEnvelope.Decode(msg.Data ?? []);
        }
        catch (InvalidEnvelopeException ex)
        {
            await SendErrorAsync(stream, 400, ex.Message).ConfigureAwait(false);
            await SendTerminatorAsync(stream).ConfigureAwait(false);
            return;
        }

        SenderInfo? sender;
        try
        {
            var admission = await _gate.AdmitPromptAsync(msg.Subject, msg.Data ?? [], msg.Headers, stopping).ConfigureAwait(false);
            if (!admission.Admitted)
            {
                await SendErrorAsync(stream, admission.Code, admission.Description ?? "sender rejected").ConfigureAwait(false);
                await SendTerminatorAsync(stream).ConfigureAwait(false);
                return;
            }
            sender = admission.Sender;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "sender classification failed on {Subject}", msg.Subject);
            await SendErrorAsync(stream, 500, "sender classification error").ConfigureAwait(false);
            await SendTerminatorAsync(stream).ConfigureAwait(false);
            return;
        }
        _logger.LogDebug("prompt request on {Subject} from {Sender}", msg.Subject, SenderHeader.Format(sender));

        var context = new PromptContext(envelope, msg.Subject, msg.Headers, Subject, sender);
        using var keepAliveCts = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        Task? keepAlive = null;
        try
        {
            await stream.SendAsync(AgentChunkCodec.EncodeStatus("ack"), null, stopping).ConfigureAwait(false);
            if (_options.KeepAliveInterval is { } every) keepAlive = KeepAliveAsync(stream, every, keepAliveCts.Token);
            await _handler!(context, stream, stopping).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            await StopKeepAliveAsync().ConfigureAwait(false);
            var (code, description) = ex switch
            {
                RequestRejectedException r => (r.Code, r.Description),
                AgentProtocolException p => (400, p.Message),
                OperationCanceledException when stopping.IsCancellationRequested => (503, "agent shutting down"),
                _ => (500, "handler error"),
            };
            if (code == 500) _logger.LogError(ex, "prompt handler failed on {Subject}", msg.Subject);
            else _logger.LogWarning("prompt request refused on {Subject}: {Code} {Description}", msg.Subject, code, description);
            await SendErrorAsync(stream, code, description).ConfigureAwait(false);
        }
        finally
        {
            await StopKeepAliveAsync().ConfigureAwait(false);
            stream.Close();
            await SendTerminatorAsync(stream).ConfigureAwait(false);
        }

        async Task StopKeepAliveAsync()
        {
            if (keepAlive is null) return;
            keepAliveCts.Cancel();
            try
            {
                await keepAlive.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
            keepAlive = null;
        }
    }

    private static async Task KeepAliveAsync(PromptStream stream, TimeSpan every, CancellationToken cancellationToken)
    {
        var ack = AgentChunkCodec.EncodeStatus("ack");
        using var timer = new PeriodicTimer(every);
        while (await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false))
        {
            try
            {
                await stream.SendAsync(ack, null, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task SendErrorAsync(PromptStream stream, int code, string description)
    {
        try
        {
            var headers = new NatsHeaders
            {
                [AgentProtocol.ErrorHeader] = SanitizeErrorDescription(description),
                [AgentProtocol.ErrorCodeHeader] = code.ToString(System.Globalization.CultureInfo.InvariantCulture),
            };
            await stream.SendRawAsync(ReadOnlyMemory<byte>.Empty, headers).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "error frame publish failed");
        }
    }

    private async Task SendTerminatorAsync(PromptStream stream)
    {
        try
        {
            await stream.SendRawAsync(ReadOnlyMemory<byte>.Empty, null).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "terminator publish failed");
        }
    }

    /// <summary>Flatten to one line (" | " joins) and cap at 200 characters, as the TypeScript host does.</summary>
    internal static string SanitizeErrorDescription(string description)
    {
        var flat = string.Join(" | ", (description ?? "").Split('\n').Select(s => s.Trim()).Where(s => s.Length > 0));
        return flat.Length > 200 ? flat[..197] + "..." : flat;
    }
}
