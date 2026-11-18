using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using NATS.Client.Core;
using Synadia.AI.Agents.Identity;

namespace Synadia.AI.Agents.Service;

/// <summary>
/// Remembers verified <c>(user, nonce)</c> pairs until their <c>ts</c> leaves the replay window (§13), in one-second
/// expiry buckets. Bounded: past <see cref="MaxEntries"/> the oldest buckets are evicted (with a warning — evicted
/// nonces could be replayed within the window). Thread-safe.
/// </summary>
public sealed class NonceCache
{
    /// <summary>Default entry cap.</summary>
    public const int DefaultMaxEntries = 100_000;

    private readonly long _windowMs;
    private readonly ILogger _logger;
    private readonly Dictionary<string, long> _expiry = new(StringComparer.Ordinal);
    private readonly SortedDictionary<long, HashSet<string>> _buckets = new();
    private readonly object _gate = new();
    private bool _capWarned;

    /// <summary>Create a cache.</summary>
    /// <param name="replayWindow">The <c>ts</c> window (default 30 s).</param>
    /// <param name="maxEntries">Entry cap (default 100 000).</param>
    /// <param name="logger">Receives the cap warning.</param>
    public NonceCache(TimeSpan? replayWindow = null, int maxEntries = DefaultMaxEntries, ILogger? logger = null)
    {
        _windowMs = (long)(replayWindow ?? SenderHeader.DefaultReplayWindow).TotalMilliseconds;
        MaxEntries = maxEntries;
        _logger = logger ?? NullLogger.Instance;
    }

    /// <summary>The entry cap.</summary>
    public int MaxEntries { get; }

    /// <summary>Live entries.</summary>
    public int Count
    {
        get
        {
            lock (_gate) return _expiry.Count;
        }
    }

    /// <summary>Whether <c>(user, nonce)</c> is remembered and unexpired at <paramref name="nowMs"/> (Unix ms).</summary>
    public bool Has(string user, string nonce, long nowMs)
    {
        lock (_gate)
        {
            Sweep(nowMs);
            return _expiry.TryGetValue($"{user}.{nonce}", out var exp) && exp > nowMs;
        }
    }

    /// <summary>
    /// Remember <c>(user, nonce)</c> signed at <paramref name="tsMs"/>. <c>false</c> when it is already remembered
    /// (a replay). Entries already outside the window are not stored.
    /// </summary>
    public bool Record(string user, string nonce, long tsMs, long nowMs)
    {
        lock (_gate)
        {
            Sweep(nowMs);
            var key = $"{user}.{nonce}";
            if (_expiry.TryGetValue(key, out var existing) && existing > nowMs) return false;
            var expiresAt = tsMs + _windowMs;
            if (expiresAt <= nowMs) return true;
            var bucket = FloorDiv(expiresAt, 1000);
            _expiry[key] = expiresAt;
            if (!_buckets.TryGetValue(bucket, out var set)) _buckets[bucket] = set = new HashSet<string>(StringComparer.Ordinal);
            set.Add(key);
            EnforceCap();
            return true;
        }
    }

    /// <summary>Drop every bucket that expired before the current second.</summary>
    public void Sweep(long nowMs)
    {
        lock (_gate)
        {
            var nowBucket = FloorDiv(nowMs, 1000);
            while (_buckets.Count > 0)
            {
                var first = _buckets.First();
                if (first.Key >= nowBucket) break;
                foreach (var key in first.Value)
                {
                    if (_expiry.TryGetValue(key, out var exp) && FloorDiv(exp, 1000) == first.Key) _expiry.Remove(key);
                }
                _buckets.Remove(first.Key);
            }
            if (_capWarned && _expiry.Count <= MaxEntries / 2) _capWarned = false;
        }
    }

    private void EnforceCap()
    {
        if (_expiry.Count <= MaxEntries) return;
        if (!_capWarned)
        {
            _capWarned = true;
            _logger.LogWarning(
                "nonce cache reached its cap ({MaxEntries}); evicting the oldest entries — evicted nonces may be replayed within the ts window",
                MaxEntries);
        }
        while (_expiry.Count > MaxEntries && _buckets.Count > 0)
        {
            var first = _buckets.First();
            foreach (var key in first.Value) _expiry.Remove(key);
            _buckets.Remove(first.Key);
        }
    }

    private static long FloorDiv(long a, long b) => (long)Math.Floor(a / (double)b);
}

/// <summary>Outcome of <see cref="SenderGate.AdmitPromptAsync"/>.</summary>
/// <param name="Admitted">Whether the request may be served.</param>
/// <param name="Sender">The classified sender (when admitted; <c>null</c> for no header).</param>
/// <param name="Code">Error code when refused (400, 401, 403 or 500).</param>
/// <param name="Description">Error description when refused.</param>
/// <param name="Detail">Log-only reason when refused (never sent to the caller).</param>
public sealed record SenderAdmission(bool Admitted, SenderInfo? Sender, int Code = 0, string? Description = null, string? Detail = null);

/// <summary>Decides whether a sender may be served after classification; <c>null</c> is a request without a header.</summary>
public delegate ValueTask<bool> AcceptSenderHook(SenderInfo? sender, CancellationToken cancellationToken);

/// <summary>
/// Host-side classification of inbound requests (§13): verifies <c>Agent-Sender</c> in live mode, keeps the
/// replay-nonce cache, enforces <c>min_sender_trust</c> and runs the optional accept hook.
/// </summary>
public sealed class SenderGate
{
    private readonly int? _accountTokenPosition;
    private readonly AcceptSenderHook? _acceptSender;
    private readonly ILogger _logger;
    private readonly TimeProvider _time;
    private readonly TimeSpan _replayWindow;

    /// <summary>Create a gate.</summary>
    /// <param name="minSenderTrust"><c>any</c> or <c>signed</c>.</param>
    /// <param name="replayWindow"><c>ts</c> window; default 30 s.</param>
    /// <param name="accountTokenPosition">1-based arrival-subject token the server inserts the account at, if any.</param>
    /// <param name="operatorAttested">The server is in operator / accounts mode and stamps <c>Nats-Request-Info</c>.</param>
    /// <param name="acceptSender">Optional final admission hook.</param>
    /// <param name="nonceCache">Shared cache; a new one by default.</param>
    /// <param name="logger">Logger.</param>
    /// <param name="timeProvider">Clock.</param>
    public SenderGate(string minSenderTrust = "any", TimeSpan? replayWindow = null, int? accountTokenPosition = null,
        bool operatorAttested = false, AcceptSenderHook? acceptSender = null, NonceCache? nonceCache = null, ILogger? logger = null,
        TimeProvider? timeProvider = null)
    {
        if (minSenderTrust is not ("any" or "signed")) throw new ArgumentException("minSenderTrust must be \"any\" or \"signed\"", nameof(minSenderTrust));
        MinSenderTrust = minSenderTrust;
        _replayWindow = replayWindow ?? SenderHeader.DefaultReplayWindow;
        if (_replayWindow <= TimeSpan.Zero) throw new ArgumentException("replayWindow must be positive", nameof(replayWindow));
        _accountTokenPosition = accountTokenPosition is { } p && p < 1
            ? throw new ArgumentException("accountTokenPosition must be an integer >= 1 (1-based)", nameof(accountTokenPosition))
            : accountTokenPosition;
        OperatorAttested = operatorAttested;
        _acceptSender = acceptSender;
        _logger = logger ?? NullLogger.Instance;
        _time = timeProvider ?? TimeProvider.System;
        NonceCache = nonceCache ?? new NonceCache(_replayWindow, logger: _logger);
    }

    /// <summary><c>any</c> or <c>signed</c>.</summary>
    public string MinSenderTrust { get; }

    /// <summary>Whether <c>Nats-Request-Info</c> is cross-checked.</summary>
    public bool OperatorAttested { get; }

    /// <summary>The replay-nonce cache.</summary>
    public NonceCache NonceCache { get; }

    /// <summary>
    /// Verify the request's <c>Agent-Sender</c> (live mode). Returns the sender (or <c>null</c> when absent), or a
    /// refused <see cref="SenderAdmission"/> for a malformed (400) or failing (401) header.
    /// </summary>
    public SenderAdmission Classify(string subject, ReadOnlySpan<byte> payload, NatsHeaders? headers)
    {
        var now = _time.GetUtcNow();
        try
        {
            var sender = SenderHeader.Verify(subject, payload, headers, new SenderVerificationOptions
            {
                Mode = SenderVerificationMode.Live,
                ReplayWindow = _replayWindow,
                AccountTokenPosition = _accountTokenPosition,
                Now = now,
                NonceSeen = (user, nonce) => NonceCache.Has(user, nonce, now.ToUnixTimeMilliseconds()),
                OperatorAttested = OperatorAttested,
            });
            return new SenderAdmission(true, sender);
        }
        catch (MalformedSenderHeaderException ex)
        {
            return new SenderAdmission(false, null, 400, "malformed Agent-Sender header", ex.Message);
        }
        catch (SenderVerificationException ex)
        {
            return new SenderAdmission(false, null, ex.Code, ex.Description, ex.Detail);
        }
    }

    /// <summary>Full prompt admission: classify → <c>min_sender_trust</c> → record nonce → accept hook.</summary>
    public async ValueTask<SenderAdmission> AdmitPromptAsync(string subject, ReadOnlyMemory<byte> payload, NatsHeaders? headers,
        CancellationToken cancellationToken = default)
    {
        var classified = Classify(subject, payload.Span, headers);
        if (!classified.Admitted) return Refuse(subject, classified);
        var sender = classified.Sender;

        if (MinSenderTrust == "signed" && sender is not VerifiedSender)
        {
            return Refuse(subject, new SenderAdmission(false, null, 401, SenderHeader.SignatureRequiredDescription,
                $"endpoint requires a verified sender; got {SenderHeader.Format(sender)}"));
        }

        if (sender is VerifiedSender v && !RecordNonce(v))
        {
            return Refuse(subject, new SenderAdmission(false, null, 401, SenderHeader.SenderRejectedDescription,
                $"nonce already seen for {v.User}"));
        }

        if (_acceptSender is not null)
        {
            bool accepted;
            try
            {
                accepted = await _acceptSender(sender, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "AcceptSender hook threw; request not served (subject {Subject}, sender {Sender})",
                    subject, SenderHeader.Format(sender));
                return new SenderAdmission(false, null, 500, "server error", "acceptSender hook threw");
            }
            if (!accepted)
            {
                return Refuse(subject, sender is VerifiedSender
                    ? new SenderAdmission(false, null, 403, SenderHeader.SenderRejectedDescription,
                        $"verified sender not accepted: {SenderHeader.Format(sender)}")
                    : new SenderAdmission(false, null, 401, SenderHeader.SignatureRequiredDescription,
                        $"unauthenticated sender not accepted: {SenderHeader.Format(sender)}"));
            }
        }
        return new SenderAdmission(true, sender);
    }

    /// <summary>Status-request classification: never refuses; a failing or replayed header yields <c>null</c>.</summary>
    public SenderInfo? ClassifyStatus(string subject, ReadOnlySpan<byte> payload, NatsHeaders? headers)
    {
        var classified = Classify(subject, payload, headers);
        if (!classified.Admitted)
        {
            _logger.LogWarning("status request: Agent-Sender rejected (reply sent anyway) on {Subject}: {Code} {Reason}",
                subject, classified.Code, classified.Detail);
            return null;
        }
        if (classified.Sender is VerifiedSender v && !RecordNonce(v))
        {
            _logger.LogWarning("status request: nonce replayed (reply sent anyway) on {Subject} from {Sender}", subject, SenderHeader.Format(v));
            return null;
        }
        return classified.Sender;
    }

    private bool RecordNonce(VerifiedSender v)
    {
        var h = v.Header;
        if (h.Nonce is null || h.Ts is null) return true;
        return NonceCache.Record(h.User, h.Nonce, SenderHeader.ParseTimestamp(h.Ts).ToUnixTimeMilliseconds(),
            _time.GetUtcNow().ToUnixTimeMilliseconds());
    }

    private SenderAdmission Refuse(string subject, SenderAdmission r)
    {
        _logger.LogWarning("prompt request refused on sender identity on {Subject}: {Code} {Reason}", subject, r.Code, r.Detail);
        return r;
    }
}
