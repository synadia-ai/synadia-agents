using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using NATS.Client.Core;

namespace Synadia.AI.Agents;

/// <summary>Liveness of one instance derived from its heartbeats (§8.2).</summary>
/// <param name="InstanceId">The instance id.</param>
/// <param name="LastSeen">When the last heartbeat was received (local clock).</param>
/// <param name="IntervalSeconds">The instance's advertised heartbeat cadence.</param>
/// <param name="IsOnline">True iff the last beat is within <c>3 × interval_s</c>.</param>
public sealed record AgentLiveness(string InstanceId, DateTimeOffset LastSeen, double IntervalSeconds, bool IsOnline);

/// <summary>A received heartbeat together with the subject it arrived on.</summary>
public sealed record AgentHeartbeat(string Subject, HeartbeatPayload Payload, DateTimeOffset ReceivedAt);

/// <summary>
/// Subscribes to <c>agents.hb.*.*.*</c> and tracks the latest heartbeat per <c>instance_id</c> (§8).
/// </summary>
public sealed class HeartbeatTracker : IAsyncDisposable
{
    private readonly INatsConnection _connection;
    private readonly ILogger _logger;
    private readonly TimeProvider _time;
    private readonly ConcurrentDictionary<string, AgentHeartbeat> _entries = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private CancellationTokenSource? _cts;
    private Task? _loop;

    /// <summary>Create a tracker; call <see cref="StartAsync"/> to begin listening.</summary>
    public HeartbeatTracker(INatsConnection connection, ILogger? logger = null, TimeProvider? timeProvider = null)
    {
        _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        _logger = logger ?? NullLogger.Instance;
        _time = timeProvider ?? TimeProvider.System;
    }

    /// <summary>Raised for every well-formed heartbeat. Handlers run on the subscription loop; keep them fast.</summary>
    public event Action<AgentHeartbeat>? HeartbeatReceived;

    /// <summary>True once <see cref="StartAsync"/> has subscribed.</summary>
    public bool IsStarted => _loop is not null;

    /// <summary>The latest heartbeat per instance id.</summary>
    public IReadOnlyDictionary<string, AgentHeartbeat> Latest => _entries;

    /// <summary>Subscribe (idempotent) and flush so beats published after this call are observed.</summary>
    public async ValueTask StartAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_loop is not null) return;
            var sub = await _connection.SubscribeCoreAsync<ReadOnlyMemory<byte>>(
                AgentProtocol.HeartbeatWildcard, cancellationToken: cancellationToken).ConfigureAwait(false);
            await _connection.PingAsync(cancellationToken).ConfigureAwait(false);
            _cts = new CancellationTokenSource();
            _loop = Task.Run(() => RunAsync(sub, _cts.Token), CancellationToken.None);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task RunAsync(INatsSub<ReadOnlyMemory<byte>> sub, CancellationToken ct)
    {
        await using var _ = sub;
        try
        {
            await foreach (var msg in sub.Msgs.ReadAllAsync(ct).ConfigureAwait(false))
            {
                var payload = HeartbeatPayload.TryDecode(msg.Data.Span);
                if (payload is null)
                {
                    _logger.LogDebug("dropping malformed heartbeat on {Subject}", msg.Subject);
                    continue;
                }
                var hb = new AgentHeartbeat(msg.Subject, payload, _time.GetUtcNow());
                _entries[payload.InstanceId] = hb;
                try
                {
                    HeartbeatReceived?.Invoke(hb);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "heartbeat listener threw");
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "heartbeat subscription failed");
        }
    }

    /// <summary>Liveness of <paramref name="instanceId"/>, or <c>null</c> if no beat has been seen.</summary>
    public AgentLiveness? GetLiveness(string instanceId)
    {
        if (!_entries.TryGetValue(instanceId, out var hb)) return null;
        var age = _time.GetUtcNow() - hb.ReceivedAt;
        var online = age.TotalSeconds <= AgentProtocol.LivenessSlack * hb.Payload.IntervalSeconds;
        return new AgentLiveness(instanceId, hb.ReceivedAt, hb.Payload.IntervalSeconds, online);
    }

    /// <summary>Unsubscribe.</summary>
    public async ValueTask StopAsync()
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_loop is null) return;
            _cts!.Cancel();
            try
            {
                await _loop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
            _cts.Dispose();
            _cts = null;
            _loop = null;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <inheritdoc />
    public ValueTask DisposeAsync() => StopAsync();
}
