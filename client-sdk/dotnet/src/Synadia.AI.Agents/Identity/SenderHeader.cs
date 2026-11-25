using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using NATS.Client.Core;
using NATS.NKeys;

namespace Synadia.AI.Agents.Identity;

/// <summary>A parsed (or built) <c>Agent-Sender</c> header (§13). Only the known fields; <c>v</c> is always 1.</summary>
public sealed record AgentSenderHeader
{
    /// <summary>The header version; always <c>1</c>.</summary>
    public int V => 1;

    /// <summary>The sender's account token.</summary>
    public required string Account { get; init; }

    /// <summary>The sender's user public NKEY.</summary>
    public required string User { get; init; }

    /// <summary>Optional display name (≤ 64 UTF-16 code units, no control characters).</summary>
    public string? Name { get; init; }

    /// <summary>The signed subject (signed headers only).</summary>
    public string? Sub { get; init; }

    /// <summary>The signing timestamp, <c>YYYY-MM-DDTHH:MM:SSZ</c> (signed headers only).</summary>
    public string? Ts { get; init; }

    /// <summary>The nonce, <c>[A-Za-z0-9_-]{1,64}</c> (signed headers only).</summary>
    public string? Nonce { get; init; }

    /// <summary>Unpadded base64url Ed25519 signature (signed headers only).</summary>
    public string? Sig { get; init; }

    /// <summary>True when <c>sig</c>, <c>sub</c>, <c>ts</c> and <c>nonce</c> are all present.</summary>
    public bool IsSigned => Sig is not null && Sub is not null && Ts is not null && Nonce is not null;
}

/// <summary>Trust level of a sender (§13).</summary>
public enum SenderTrust
{
    /// <summary>An unsigned claim: the header names an account/user but nothing proves it.</summary>
    Claimed,

    /// <summary>The signature verified: the user is proven; the account is proven iff <see cref="VerifiedSender.AccountAttested"/>.</summary>
    Verified,
}

/// <summary>The sender of a message, as classified from its <c>Agent-Sender</c> header.</summary>
public abstract record SenderInfo
{
    private protected SenderInfo(AgentSenderHeader header) => Header = header;

    /// <summary>The trust level.</summary>
    public abstract SenderTrust Trust { get; }

    /// <summary>The display name the header carried, if any (always self-asserted).</summary>
    public string? Name => Header.Name;

    /// <summary>The parsed header.</summary>
    public AgentSenderHeader Header { get; }

    /// <summary>The (claimed or verified) account token.</summary>
    public string Account => Header.Account;

    /// <summary>The (claimed or verified) user public NKEY.</summary>
    public string User => Header.User;
}

/// <summary>A sender whose signature verified.</summary>
public sealed record VerifiedSender : SenderInfo
{
    /// <summary>Create a verified sender.</summary>
    public VerifiedSender(AgentId id, bool accountAttested, AgentSenderHeader header) : base(header)
    {
        Id = id ?? throw new ArgumentNullException(nameof(id));
        AccountAttested = accountAttested;
    }

    /// <inheritdoc />
    public override SenderTrust Trust => SenderTrust.Verified;

    /// <summary>The verified agent ID.</summary>
    public AgentId Id { get; }

    /// <summary>
    /// True when the account was attested by the server (an account token in the arrival subject, or a
    /// <c>Nats-Request-Info</c> stamp in operator-attested mode); otherwise only the user is proven.
    /// </summary>
    public bool AccountAttested { get; }
}

/// <summary>An unsigned claim.</summary>
public sealed record ClaimedSender : SenderInfo
{
    /// <summary>Create a claimed sender.</summary>
    public ClaimedSender(AgentSenderHeader header) : base(header) { }

    /// <inheritdoc />
    public override SenderTrust Trust => SenderTrust.Claimed;
}

/// <summary>Whether a message is being served now (<see cref="Live"/>) or read back from storage (<see cref="Stored"/>).</summary>
public enum SenderVerificationMode
{
    /// <summary>A request being served now: freshness and nonce checks apply.</summary>
    Live,

    /// <summary>A stored record (e.g. JetStream): freshness and nonce lookup are skipped.</summary>
    Stored,
}

/// <summary>Options of <see cref="SenderHeader.Verify(AgentSenderHeader, string, ReadOnlySpan{byte}, SenderVerificationOptions)"/>.</summary>
public sealed record SenderVerificationOptions
{
    /// <summary>Live or stored. Default <see cref="SenderVerificationMode.Live"/>.</summary>
    public SenderVerificationMode Mode { get; init; } = SenderVerificationMode.Live;

    /// <summary>
    /// 1-based position of a server-inserted account token in the arrival subject (cross-account imports with
    /// account-token mapping). Must be ≥ 1.
    /// </summary>
    public int? AccountTokenPosition { get; init; }

    /// <summary>Accepted clock skew of <c>ts</c> in live mode. Default 30 s.</summary>
    public TimeSpan ReplayWindow { get; init; } = SenderHeader.DefaultReplayWindow;

    /// <summary>"Now" for the freshness check; defaults to the system clock.</summary>
    public DateTimeOffset? Now { get; init; }

    /// <summary>Live mode: returns true when <c>(user, nonce)</c> was already seen (lookup only; never records).</summary>
    public Func<string, string, bool>? NonceSeen { get; init; }

    /// <summary>Cross-check <c>Nats-Request-Info</c> (operator mode with server stamps).</summary>
    public bool OperatorAttested { get; init; }

    /// <summary>The message headers (read only for <c>Nats-Request-Info</c> in operator-attested mode).</summary>
    public NatsHeaders? Headers { get; init; }
}

/// <summary>
/// Codec, signing and verification of the <c>Agent-Sender</c> header (sender-identity extension, §13). The canonical
/// encoding is byte-identical to the TypeScript and Python SDKs.
/// </summary>
public static partial class SenderHeader
{
    /// <summary>The header name (exact case).</summary>
    public const string HeaderName = "Agent-Sender";

    /// <summary>The header version.</summary>
    public const int Version = 1;

    /// <summary>The tag that opens the signed input.</summary>
    public const string SignedInputTag = "AGENT-SENDER-V1";

    /// <summary>Maximum header value size in UTF-8 bytes.</summary>
    public const int MaxValueBytes = 2048;

    /// <summary>Maximum display-name length in UTF-16 code units.</summary>
    public const int MaxNameLength = 64;

    /// <summary>NATS header framing bytes of one <c>Agent-Sender</c> header (<c>NATS/1.0\r\n</c>, name, <c>: </c>, CRLFs).</summary>
    public const int FramingBytes = 28;

    /// <summary>Error description for a rejected signed sender (<c>401</c> / <c>403</c>).</summary>
    public const string SenderRejectedDescription = "sender rejected";

    /// <summary>Error description when a signature is required but absent (<c>401</c>).</summary>
    public const string SignatureRequiredDescription = "signature required";

    /// <summary>The <c>Nats-Request-Info</c> header the server stamps on cross-account requests.</summary>
    public const string RequestInfoHeader = "Nats-Request-Info";

    /// <summary>Default accepted clock skew (30 s).</summary>
    public static readonly TimeSpan DefaultReplayWindow = TimeSpan.FromMilliseconds(30_000);

    private const int SignatureBytes = 64;
    private const int SignatureB64UrlLength = 86;
    private const int TsLength = 20;
    private const int NuidLength = 22;
    private const int MaxNonceLength = 64;
    private const int UserKeyLength = 56;
    private const string NuidAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    // ---------------------------------------------------------------- names

    /// <summary>Validate a display name: ≤ 64 UTF-16 code units, no C0/C1/DEL/U+2028/U+2029, no lone surrogates.</summary>
    /// <exception cref="IdentityException">The name is invalid (the message never includes the name).</exception>
    public static void AssertValidName(string name)
    {
        ArgumentNullException.ThrowIfNull(name);
        if (name.Length > MaxNameLength) throw new IdentityException($"identity.name exceeds {MaxNameLength} UTF-16 code units");
        for (var i = 0; i < name.Length; i++)
        {
            var c = name[i];
            if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c == 0x2028 || c == 0x2029)
                throw new IdentityException("identity.name contains a control character");
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 >= name.Length || !char.IsLowSurrogate(name[i + 1])) throw new IdentityException("identity.name contains a lone surrogate");
                i++;
            }
            else if (char.IsLowSurrogate(c))
            {
                throw new IdentityException("identity.name contains a lone surrogate");
            }
        }
    }

    private static bool IsValidName(string name)
    {
        try
        {
            AssertValidName(name);
            return true;
        }
        catch (IdentityException)
        {
            return false;
        }
    }

    /// <summary>True iff <paramref name="nonce"/> fits the header grammar <c>[A-Za-z0-9_-]{1,64}</c>.</summary>
    public static bool IsValidNonce(string nonce) => nonce is not null && NonceRegex().IsMatch(nonce);

    // ---------------------------------------------------------- serialise

    /// <summary>Canonical single-line JSON (field order <c>v, account, user, name, sub, ts, nonce, sig</c>; absent fields omitted).</summary>
    public static string Serialize(AgentSenderHeader header)
    {
        ArgumentNullException.ThrowIfNull(header);
        var sb = new StringBuilder(256);
        sb.Append("{\"v\":1");
        AppendField(sb, "account", header.Account);
        AppendField(sb, "user", header.User);
        if (header.Name is not null) AppendField(sb, "name", header.Name);
        if (header.Sub is not null) AppendField(sb, "sub", header.Sub);
        if (header.Ts is not null) AppendField(sb, "ts", header.Ts);
        if (header.Nonce is not null) AppendField(sb, "nonce", header.Nonce);
        if (header.Sig is not null) AppendField(sb, "sig", header.Sig);
        sb.Append('}');
        return sb.ToString();
    }

    private static void AppendField(StringBuilder sb, string key, string value)
    {
        sb.Append(",\"").Append(key).Append("\":");
        AppendJsonString(sb, value);
    }

    // JSON.stringify-compatible string escaping (ES2019 well-formed stringify).
    internal static void AppendJsonString(StringBuilder sb, string value)
    {
        sb.Append('"');
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20)
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
                    {
                        sb.Append(c).Append(value[++i]);
                    }
                    else if (char.IsSurrogate(c))
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(c);
                    }
                    break;
            }
        }
        sb.Append('"');
    }

    /// <summary>Wire length of a header including NATS framing: 28 bytes + the UTF-8 value length.</summary>
    public static int EncodedHeaderLength(string value) => FramingBytes + Encoding.UTF8.GetByteCount(value);

    /// <summary>
    /// Sound upper bound on the framed size of any header this SDK would send for <paramref name="subject"/> /
    /// <paramref name="name"/> (a 64-byte account allowance and the maximum field widths).
    /// </summary>
    public static int MaxHeaderBytes(string subject, string? name = null)
        => EncodedHeaderLength(Serialize(new AgentSenderHeader
        {
            Account = new string('A', AgentId.AccountLengthAllowanceBytes),
            User = new string('U', UserKeyLength),
            Name = name,
            Sub = subject,
            Ts = new string('T', TsLength),
            Nonce = new string('N', MaxNonceLength),
            Sig = new string('S', SignatureB64UrlLength),
        }));

    /// <summary>Exact framed size of the header this SDK sends for a known identity (default 22-char nonce).</summary>
    public static int ExpectedHeaderBytes(AgentId id, string sub, bool signed, string? name = null)
    {
        ArgumentNullException.ThrowIfNull(id);
        var header = new AgentSenderHeader { Account = id.Account, User = id.User, Name = name };
        if (signed)
        {
            header = header with
            {
                Sub = sub,
                Ts = new string('T', TsLength),
                Nonce = new string('N', NuidLength),
                Sig = new string('S', SignatureB64UrlLength),
            };
        }
        return EncodedHeaderLength(Serialize(header));
    }

    // -------------------------------------------------------------- parse

    /// <summary>
    /// Read the raw <c>Agent-Sender</c> value (exact-case name). <c>null</c> when absent.
    /// </summary>
    /// <exception cref="MalformedSenderHeaderException">More than one value.</exception>
    public static string? ReadValue(NatsHeaders? headers)
    {
        if (headers is null || !headers.TryGetValue(HeaderName, out var values) || values.Count == 0) return null;
        if (values.Count > 1) throw new MalformedSenderHeaderException("more than one Agent-Sender value");
        return values[0];
    }

    /// <summary>
    /// Parse a header value. Returns <c>null</c> for a well-formed header with an unknown <c>v</c> (treat it as absent).
    /// Unknown fields are ignored.
    /// </summary>
    /// <exception cref="MalformedSenderHeaderException">The value is malformed.</exception>
    public static AgentSenderHeader? Parse(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (Encoding.UTF8.GetByteCount(value) > MaxValueBytes)
            throw new MalformedSenderHeaderException($"value exceeds {MaxValueBytes} bytes");
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(value);
        }
        catch (JsonException)
        {
            throw new MalformedSenderHeaderException("not valid JSON");
        }
        using (doc)
        {
            try
            {
                return ParseObject(doc.RootElement);
            }
            catch (InvalidOperationException)
            {
                // Invalid surrogate escapes surface from GetString(); JSON.parse would accept them, but no valid field can carry one.
                throw new MalformedSenderHeaderException("not valid JSON");
            }
        }
    }

    private static AgentSenderHeader? ParseObject(JsonElement o)
    {
        if (o.ValueKind != JsonValueKind.Object) throw new MalformedSenderHeaderException("not a JSON object");
        if (!o.TryGetProperty("v", out var v) || v.ValueKind != JsonValueKind.Number)
            throw new MalformedSenderHeaderException("`v` must be a JSON number");
        if (!v.TryGetDouble(out var vd) || vd != Version) return null;

        if (!TryGetString(o, "account", out var account) | !TryGetString(o, "user", out var user) || account is null || user is null)
            throw new MalformedSenderHeaderException("`account` and `user` must be strings");
        try
        {
            AgentId.Create(account, user);
        }
        catch (InvalidAgentIdException ex)
        {
            throw new MalformedSenderHeaderException(ex.Message);
        }

        string? name = null, sub = null, ts = null, nonce = null, sig = null;
        if (o.TryGetProperty("name", out var n))
        {
            if (n.ValueKind != JsonValueKind.String || !IsValidName(name = n.GetString()!))
                throw new MalformedSenderHeaderException("`name` is not a valid display name");
        }
        if (o.TryGetProperty("sub", out var s))
        {
            if (s.ValueKind != JsonValueKind.String || !SubjectRegex().IsMatch(sub = s.GetString()!))
                throw new MalformedSenderHeaderException("`sub` is not a NATS subject");
        }
        if (o.TryGetProperty("ts", out var t))
        {
            if (t.ValueKind != JsonValueKind.String || !TryParseTimestamp(ts = t.GetString()!, out _))
                throw new MalformedSenderHeaderException("`ts` is not an RFC 3339 UTC timestamp");
        }
        if (o.TryGetProperty("nonce", out var no))
        {
            if (no.ValueKind != JsonValueKind.String || !NonceRegex().IsMatch(nonce = no.GetString()!))
                throw new MalformedSenderHeaderException("`nonce` must match [A-Za-z0-9_-]{1,64}");
        }
        if (o.TryGetProperty("sig", out var sg))
        {
            if (sg.ValueKind != JsonValueKind.String) throw new MalformedSenderHeaderException("`sig` must be a string");
            sig = sg.GetString()!;
            if (!Base64Url.TryDecode(sig, out var bytes)) throw new MalformedSenderHeaderException("`sig` is not base64url");
            if (bytes.Length != SignatureBytes) throw new MalformedSenderHeaderException("`sig` must decode to 64 bytes");
            if (sub is null || ts is null || nonce is null)
                throw new MalformedSenderHeaderException("`sig` requires `sub`, `ts` and `nonce`");
        }
        return new AgentSenderHeader { Account = account, User = user, Name = name, Sub = sub, Ts = ts, Nonce = nonce, Sig = sig };
    }

    private static bool TryGetString(JsonElement o, string key, out string? value)
    {
        value = null;
        if (!o.TryGetProperty(key, out var e) || e.ValueKind != JsonValueKind.String) return false;
        value = e.GetString();
        return true;
    }

    // --------------------------------------------------------- timestamps

    /// <summary>Format a signing timestamp: <c>YYYY-MM-DDTHH:MM:SSZ</c>, UTC, truncated to the second.</summary>
    public static string FormatTimestamp(DateTimeOffset time)
    {
        var utc = time.UtcDateTime;
        utc = new DateTime(utc.Ticks - (utc.Ticks % TimeSpan.TicksPerSecond), DateTimeKind.Utc);
        return utc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
    }

    /// <summary>Parse a header <c>ts</c> to an instant (millisecond precision, like <c>Date.parse</c>).</summary>
    /// <exception cref="FormatException">Not a valid header timestamp.</exception>
    public static DateTimeOffset ParseTimestamp(string ts)
        => TryParseTimestamp(ts, out var value) ? value : throw new FormatException("not an Agent-Sender timestamp");

    private static bool TryParseTimestamp(string ts, out DateTimeOffset value)
    {
        value = default;
        if (!TsRegex().IsMatch(ts)) return false;
        if (!DateTime.TryParseExact(ts.AsSpan(0, 19), "yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var dt))
        {
            return false;
        }
        var ms = 0;
        if (ts[19] == '.')
        {
            var digits = ts.AsSpan(20, ts.Length - 21);
            for (var i = 0; i < 3; i++) ms = (ms * 10) + (i < digits.Length ? digits[i] - '0' : 0);
        }
        value = new DateTimeOffset(DateTime.SpecifyKind(dt, DateTimeKind.Utc)).AddMilliseconds(ms);
        return true;
    }

    // ------------------------------------------------------------ signing

    /// <summary>
    /// The exact bytes that are signed (never sent):
    /// <c>AGENT-SENDER-V1\n{account}\n{user}\n{sub}\n{ts}\n{nonce}\n{sha256hex(payload)}\n</c>.
    /// </summary>
    public static byte[] BuildSignedInput(string account, string user, string subject, string ts, string nonce, ReadOnlySpan<byte> payload)
        => Encoding.UTF8.GetBytes($"{SignedInputTag}\n{account}\n{user}\n{subject}\n{ts}\n{nonce}\n{Sha256Hex(payload)}\n");

    internal static string Sha256Hex(ReadOnlySpan<byte> payload)
        => Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant();

    /// <summary>A fresh 22-character base62 nonce (NUID-sized).</summary>
    public static string NewNonce() => new(RandomNumberGenerator.GetItems<char>(NuidAlphabet, NuidLength));

    /// <summary>Build and sign a header over <paramref name="payload"/>. <c>ts</c> and <c>nonce</c> are fresh unless overridden.</summary>
    /// <param name="signer">The signer; its public key must be <paramref name="id"/>'s user.</param>
    /// <param name="id">The sender's agent ID.</param>
    /// <param name="sub">The subject to sign (what the caller publishes to, or the exporter's subject behind a rename).</param>
    /// <param name="payload">The exact payload bytes that will be published.</param>
    /// <param name="name">Optional display name.</param>
    /// <param name="ts">Timestamp override (tests / vectors).</param>
    /// <param name="nonce">Nonce override (tests / vectors).</param>
    /// <param name="cancellationToken">Cancellation.</param>
    public static async ValueTask<AgentSenderHeader> SignAsync(ISenderSigner signer, AgentId id, string sub, ReadOnlyMemory<byte> payload,
        string? name = null, string? ts = null, string? nonce = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(signer);
        ArgumentNullException.ThrowIfNull(id);
        ArgumentNullException.ThrowIfNull(sub);
        ts ??= FormatTimestamp(DateTimeOffset.UtcNow);
        nonce ??= NewNonce();
        var input = BuildSignedInput(id.Account, id.User, sub, ts, nonce, payload.Span);
        var sig = await signer.SignAsync(input, cancellationToken).ConfigureAwait(false);
        return new AgentSenderHeader
        {
            Account = id.Account,
            User = id.User,
            Name = name,
            Sub = sub,
            Ts = ts,
            Nonce = nonce,
            Sig = Base64Url.Encode(sig),
        };
    }

    /// <summary>An unsigned claim: exactly <c>v, account, user, name?</c>.</summary>
    public static AgentSenderHeader BuildClaim(AgentId id, string? name = null)
    {
        ArgumentNullException.ThrowIfNull(id);
        return new AgentSenderHeader { Account = id.Account, User = id.User, Name = name };
    }

    // ------------------------------------------------------- verification

    /// <summary>
    /// <c>sub</c> acceptance against the arrival subject. Returns a rejection detail, or <c>null</c> when accepted.
    /// </summary>
    public static string? CheckSubjectAcceptance(string account, string sub, string arrivalSubject, int? accountTokenPosition)
    {
        ArgumentNullException.ThrowIfNull(sub);
        ArgumentNullException.ThrowIfNull(arrivalSubject);
        if (accountTokenPosition is not { } p)
        {
            return sub == arrivalSubject ? null : $"sub {Js(sub)} is not the arrival subject {Js(arrivalSubject)}";
        }
        var tokens = arrivalSubject.Split('.');
        if (p > tokens.Length) return $"accountTokenPosition {p} is beyond the {tokens.Length}-token arrival subject";
        var inserted = tokens[p - 1];
        if (inserted != account)
            return $"arrival subject token {Js(inserted)} at position {p} is not the header account {Js(account)}";
        var stripped = string.Join('.', tokens.Take(p - 1).Concat(tokens.Skip(p)));
        if (sub == arrivalSubject || sub == stripped) return null;
        return $"sub {Js(sub)} is neither the arrival subject {Js(arrivalSubject)} nor {Js(stripped)}";
    }

    internal static int? NormalizeAccountTokenPosition(int? p)
    {
        if (p is null) return null;
        if (p < 1) throw new IdentityException("accountTokenPosition must be an integer >= 1 (1-based)");
        return p;
    }

    /// <summary>
    /// Verify a parsed header against the message it arrived with. Check order: <c>ts</c> window (live) → <c>sub</c>
    /// acceptance → <c>Nats-Request-Info</c> cross-check (operator-attested) → nonce lookup (live) → Ed25519. An
    /// unsigned header yields a <see cref="ClaimedSender"/> without any check. A returned <see cref="VerifiedSender"/>
    /// does not mean the nonce was recorded — the receiver records it after admission.
    /// </summary>
    /// <exception cref="SenderVerificationException">A check failed (<c>401 sender rejected</c>).</exception>
    public static SenderInfo Verify(AgentSenderHeader header, string arrivalSubject, ReadOnlySpan<byte> payload, SenderVerificationOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(header);
        ArgumentNullException.ThrowIfNull(arrivalSubject);
        options ??= new SenderVerificationOptions();
        if (!header.IsSigned) return new ClaimedSender(header);
        var sub = header.Sub!;
        var ts = header.Ts!;
        var nonce = header.Nonce!;
        var position = NormalizeAccountTokenPosition(options.AccountTokenPosition);

        if (options.Mode == SenderVerificationMode.Live)
        {
            var window = (long)options.ReplayWindow.TotalMilliseconds;
            var now = (options.Now ?? DateTimeOffset.UtcNow).ToUnixTimeMilliseconds();
            if (!TryParseTimestamp(ts, out var tsAt)) Reject($"ts {ts} is not a valid timestamp");
            var skew = Math.Abs(now - tsAt.ToUnixTimeMilliseconds());
            if (skew > window) Reject($"ts {ts} is {Math.Round(skew / 1000.0, MidpointRounding.AwayFromZero)} s from now (window {window} ms)");
        }

        var subjectProblem = CheckSubjectAcceptance(header.Account, sub, arrivalSubject, position);
        if (subjectProblem is not null) Reject(subjectProblem);

        var accountAttested = false;
        if (options.OperatorAttested)
        {
            var present = RequestInfo.TryRead(options.Headers, out var stamp);
            if (present && stamp is null) Reject("Nats-Request-Info is present but is not a server stamp (operator-attested mode)");
            if (stamp is not null)
            {
                if (stamp.Account is not null && stamp.Account != header.Account)
                    Reject($"Nats-Request-Info acc {Js(stamp.Account)} disagrees with the signed account {Js(header.Account)}");
                if (stamp.User is not null && stamp.User != header.User)
                    Reject($"Nats-Request-Info user {Js(stamp.User)} disagrees with the signed user {header.User}");
            }
            accountAttested = position is not null || stamp?.Account is not null;
        }

        if (options.Mode == SenderVerificationMode.Live && options.NonceSeen?.Invoke(header.User, nonce) == true)
            Reject($"nonce already seen for {header.User}");

        var input = BuildSignedInput(header.Account, header.User, sub, ts, nonce, payload);
        if (!Base64Url.TryDecode(header.Sig!, out var sig) || !VerifyWithPublicKey(header.User, input, sig))
            Reject($"signature does not verify for {header.User}");

        return new VerifiedSender(AgentId.Create(header.Account, header.User), accountAttested, header);
    }

    /// <summary>
    /// The spec's <c>VerifySender(msg, mode)</c>: read and parse <c>Agent-Sender</c> from <paramref name="headers"/>, then
    /// <see cref="Verify(AgentSenderHeader, string, ReadOnlySpan{byte}, SenderVerificationOptions)"/> with
    /// <paramref name="subject"/> as the arrival subject. <c>null</c> when there is no header or its <c>v</c> is unknown.
    /// </summary>
    /// <exception cref="MalformedSenderHeaderException">The header is malformed (hosts answer <c>400</c>).</exception>
    /// <exception cref="SenderVerificationException">A check failed (<c>401</c>).</exception>
    public static SenderInfo? Verify(string subject, ReadOnlySpan<byte> payload, NatsHeaders? headers, SenderVerificationOptions? options = null)
    {
        var value = ReadValue(headers);
        if (value is null) return null;
        var header = Parse(value);
        if (header is null) return null;
        return Verify(header, subject, payload, (options ?? new SenderVerificationOptions()) with { Headers = headers });
    }

    /// <summary>
    /// Human-readable sender for logs: <c>"(no sender)"</c>, <c>"{id} (verified)"</c>,
    /// <c>"{id} (verified user, claimed account)"</c> or <c>"{account}.{user} (claimed)"</c>.
    /// </summary>
    public static string Format(SenderInfo? sender) => sender switch
    {
        null => "(no sender)",
        VerifiedSender { AccountAttested: true } v => $"{v.Id} (verified)",
        VerifiedSender v => $"{v.Id} (verified user, claimed account)",
        _ => $"{sender.Account}.{sender.User} (claimed)",
    };

    internal static bool VerifyWithPublicKey(string publicKey, byte[] data, byte[] signature)
    {
        try
        {
            using var kp = KeyPair.FromPublicKey(publicKey);
            return kp.Verify(data, signature);
        }
        catch (Exception ex) when (ex is NKeysException or ArgumentException or FormatException or IndexOutOfRangeException)
        {
            return false;
        }
    }

    [System.Diagnostics.CodeAnalysis.DoesNotReturn]
    private static void Reject(string detail) => throw new SenderVerificationException(401, SenderRejectedDescription, detail);

    private static string Js(string value)
    {
        var sb = new StringBuilder(value.Length + 2);
        AppendJsonString(sb, value);
        return sb.ToString();
    }

    [GeneratedRegex(@"\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z\z", RegexOptions.CultureInvariant)]
    private static partial Regex TsRegex();

    [GeneratedRegex(@"\A[A-Za-z0-9_-]{1,64}\z", RegexOptions.CultureInvariant)]
    private static partial Regex NonceRegex();

    // JS `\s` set spelled out (ECMAScript WhiteSpace + LineTerminator) so .NET matches byte-for-byte.
    [GeneratedRegex(@"\A[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff.\x00-\x1f\x7f]+(\.[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff.\x00-\x1f\x7f]+)*\z", RegexOptions.CultureInvariant)]
    private static partial Regex SubjectRegex();
}

/// <summary>A parsed <c>Nats-Request-Info</c> server stamp.</summary>
/// <param name="Account">The <c>acc</c> field.</param>
/// <param name="User">The <c>user</c> field.</param>
public sealed record RequestInfo(string? Account, string? User)
{
    /// <summary>Parse a stamp value; <c>null</c> when it is not a JSON object with string <c>acc</c>/<c>user</c>.</summary>
    public static RequestInfo? Parse(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        try
        {
            using var doc = JsonDocument.Parse(value);
            var o = doc.RootElement;
            if (o.ValueKind != JsonValueKind.Object) return null;
            string? acc = null, user = null;
            if (o.TryGetProperty("acc", out var a))
            {
                if (a.ValueKind != JsonValueKind.String) return null;
                acc = a.GetString();
            }
            if (o.TryGetProperty("user", out var u))
            {
                if (u.ValueKind != JsonValueKind.String) return null;
                user = u.GetString();
            }
            return new RequestInfo(acc, user);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Read the stamp from <paramref name="headers"/>. Returns false when absent; true with a <c>null</c>
    /// <paramref name="stamp"/> when present but invalid (or repeated).
    /// </summary>
    public static bool TryRead(NatsHeaders? headers, out RequestInfo? stamp)
    {
        stamp = null;
        if (headers is null || !headers.TryGetValue(SenderHeader.RequestInfoHeader, out var values) || values.Count == 0) return false;
        if (values.Count > 1) return true;
        stamp = Parse(values[0] ?? "");
        return true;
    }
}
