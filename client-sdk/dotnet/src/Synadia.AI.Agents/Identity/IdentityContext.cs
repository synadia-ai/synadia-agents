using NATS.Client.Core;

namespace Synadia.AI.Agents.Identity;

/// <summary>Sender-identity settings of an <see cref="AgentsClient"/> (§13).</summary>
/// <remarks>
/// Leave <see cref="AgentsClientOptions.Identity"/> <c>null</c> to send no <c>Agent-Sender</c> header at all. With a
/// <see cref="Signer"/> every prompt / status request carries a signed header; without one an unsigned claim is
/// sent (when <see cref="SendUnsignedClaim"/>) and silently dropped when the connection has no NKEY identity.
/// </remarks>
public sealed class SenderIdentityOptions
{
    /// <summary>Signer whose public key must be the connection's user NKEY. <c>null</c> for unsigned claims.</summary>
    public ISenderSigner? Signer { get; set; }

    /// <summary>Optional display name carried as <c>name</c> (≤ 64 chars, no control characters).</summary>
    public string? Name { get; set; }

    /// <summary>Without a signer, send an unsigned claim. Default <c>true</c>.</summary>
    public bool SendUnsignedClaim { get; set; } = true;
}

/// <summary>What a request will carry: the identity, signed or not, and the exact framed header size.</summary>
internal sealed record SenderHeaderPlan(AgentId Id, bool Signed, string Sub, int WireBytes, ISenderSigner? Signer, string? Name)
{
    public async ValueTask<AgentSenderHeader> BuildAsync(ReadOnlyMemory<byte> payload, string? nonce, CancellationToken ct)
        => Signed
            ? await SenderHeader.SignAsync(Signer!, Id, Sub, payload, Name, nonce: nonce, cancellationToken: ct).ConfigureAwait(false)
            : SenderHeader.BuildClaim(Id, Name);
}

/// <summary>
/// Per-client identity state: the signer / name / claim policy and the per-connection <c>selfId</c> memo. A request
/// awaits the lookup at most once per connection; failures are retried after 30 s, and the memo is dropped on
/// reconnect. A signer configuration always propagates lookup failures; an unsigned one proceeds without a header.
/// </summary>
internal sealed class IdentityContext : IDisposable
{
    internal static readonly TimeSpan FailureTtl = TimeSpan.FromSeconds(30);

    private readonly INatsConnection _nc;
    private readonly TimeProvider _time;
    private readonly object _gate = new();
    private Task<AgentId>? _lookup;
    private long _failedAt;

    public IdentityContext(INatsConnection nc, SenderIdentityOptions options, TimeProvider? time)
    {
        if (options.Name is not null) SenderHeader.AssertValidName(options.Name);
        _nc = nc;
        _time = time ?? TimeProvider.System;
        Signer = options.Signer;
        Name = options.Name;
        SendUnsignedClaim = options.SendUnsignedClaim;
        _nc.ConnectionDisconnected += OnConnectionChangedAsync;
        _nc.ConnectionOpened += OnConnectionChangedAsync;
    }

    public ISenderSigner? Signer { get; }

    public string? Name { get; }

    public bool SendUnsignedClaim { get; }

    public Task<AgentId> SelfIdAsync(CancellationToken ct)
    {
        Task<AgentId> lookup;
        lock (_gate)
        {
            if (_lookup is null || (_lookup.IsFaulted && Expired())) _lookup = StartLookup();
            lookup = _lookup;
        }
        return lookup.WaitAsync(ct);
    }

    public Task<AgentId> RefreshAsync(CancellationToken ct)
    {
        Task<AgentId> lookup;
        lock (_gate) lookup = _lookup = StartLookup();
        return lookup.WaitAsync(ct);
    }

    /// <summary>The settled lookup, or <c>null</c> while pending / never started / failure expired.</summary>
    public Task<AgentId>? Peek()
    {
        lock (_gate)
        {
            if (_lookup is null || !_lookup.IsCompleted) return null;
            if (_lookup.IsFaulted && Expired()) return null;
            return _lookup;
        }
    }

    public void Kickoff()
    {
        if (Signer is null && !SendUnsignedClaim) return;
        _ = SelfIdAsync(CancellationToken.None).ContinueWith(static t => _ = t.Exception, CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    }

    public bool MayAttachHeader()
    {
        if (Signer is not null) return true;
        if (!SendUnsignedClaim) return false;
        return Peek() is not { IsFaulted: true } t || t.Exception!.InnerException is not NoIdentityException;
    }

    public async Task<AgentId?> ResolveForRequestAsync(bool requireSigned, CancellationToken ct)
    {
        var identityRequired = requireSigned || Signer is not null;
        var settled = Peek();
        if (settled is not null)
        {
            if (settled.IsCompletedSuccessfully) return settled.Result;
            var error = settled.Exception!.InnerException!;
            if (error is IdentityMismatchException || identityRequired) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw(error);
            return null;
        }
        bool expiredFailure;
        lock (_gate) expiredFailure = _lookup is { IsFaulted: true } && Expired();
        if (!identityRequired && expiredFailure)
        {
            Kickoff();
            return null;
        }
        try
        {
            return await SelfIdAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException && ex is not IdentityMismatchException && !identityRequired)
        {
            return null;
        }
    }

    public async Task<SenderHeaderPlan?> PlanAsync(string sub, bool requireSigned, CancellationToken ct)
    {
        if (requireSigned && Signer is null) throw new SenderSignatureRequiredException(sub);
        if (Signer is null && !SendUnsignedClaim) return null;
        var id = await ResolveForRequestAsync(requireSigned, ct).ConfigureAwait(false);
        if (id is null) return null;
        var signed = Signer is not null;
        return new SenderHeaderPlan(id, signed, sub, SenderHeader.ExpectedHeaderBytes(id, sub, signed, Name), Signer, Name);
    }

    public void Dispose()
    {
        _nc.ConnectionDisconnected -= OnConnectionChangedAsync;
        _nc.ConnectionOpened -= OnConnectionChangedAsync;
    }

    private async Task<AgentId> StartLookup()
    {
        try
        {
            return await SelfId.LookupAsync(_nc, Signer).ConfigureAwait(false);
        }
        catch
        {
            Interlocked.Exchange(ref _failedAt, _time.GetTimestamp());
            throw;
        }
    }

    private bool Expired() => _time.GetElapsedTime(Interlocked.Read(ref _failedAt)) >= FailureTtl;

    private ValueTask OnConnectionChangedAsync(object? sender, NatsEventArgs args)
    {
        lock (_gate) _lookup = null;
        return ValueTask.CompletedTask;
    }
}
