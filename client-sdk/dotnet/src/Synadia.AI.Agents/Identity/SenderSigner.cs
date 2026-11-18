using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using NATS.NKeys;

namespace Synadia.AI.Agents.Identity;

/// <summary>
/// Signs <c>Agent-Sender</c> headers (and <c>id_sig</c> metadata) on behalf of one NATS user NKEY. Implement it
/// yourself to sign with an HSM / KMS; <see cref="SenderSigner"/> is the built-in seed-backed implementation.
/// </summary>
public interface ISenderSigner
{
    /// <summary>The user public NKEY (<c>U…</c>) this signer signs for.</summary>
    string PublicKey { get; }

    /// <summary>
    /// The user JWT when the signer came from a credentials file; live connection binding then compares its user and
    /// account with <c>$SYS.REQ.USER.INFO</c>.
    /// </summary>
    string? Jwt { get; }

    /// <summary>Ed25519 signature (64 bytes) over <paramref name="data"/>.</summary>
    ValueTask<byte[]> SignAsync(ReadOnlyMemory<byte> data, CancellationToken cancellationToken = default);
}

/// <summary>
/// The built-in <see cref="ISenderSigner"/>: an in-memory user NKEY pair. The seed text is not retained;
/// <see cref="ToString"/> and error messages only ever show the public key.
/// </summary>
public sealed partial class SenderSigner : ISenderSigner, IDisposable
{
    private readonly object _gate = new();
    private KeyPair? _keyPair;

    private SenderSigner(KeyPair keyPair, string? jwt)
    {
        _keyPair = keyPair;
        PublicKey = keyPair.GetPublicKey();
        Jwt = jwt;
    }

    /// <inheritdoc />
    public string PublicKey { get; }

    /// <inheritdoc />
    public string? Jwt { get; }

    /// <summary>
    /// Build a signer from a user seed (<c>SU…</c>). Surrounding whitespace is ignored and a
    /// <c>-----BEGIN USER NKEY SEED-----</c> block is accepted too.
    /// </summary>
    /// <exception cref="IdentityException">The text is not a valid user seed.</exception>
    public static SenderSigner FromSeed(string seed)
    {
        ArgumentNullException.ThrowIfNull(seed);
        return new SenderSigner(KeyPairFromSeed(NormalizeUserSeed(seed)), null);
    }

    /// <summary>
    /// Build a signer from credentials-file text (<c>.creds</c>). The signer carries the user JWT; a seed that does not
    /// belong to the JWT's <c>sub</c> is rejected with <see cref="IdentityMismatchException"/>.
    /// </summary>
    /// <exception cref="IdentityException">The creds text is malformed or inconsistent.</exception>
    public static SenderSigner FromCreds(string credsText)
    {
        ArgumentNullException.ThrowIfNull(credsText);
        var (jwt, seed) = ParseCreds(credsText);
        return FromSeedAndJwt(seed, jwt);
    }

    /// <summary><see cref="FromCreds"/> over a file path (a leading <c>~/</c> is expanded).</summary>
    /// <exception cref="IdentityException">The file cannot be read or is malformed.</exception>
    public static SenderSigner FromCredsFile(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        var resolved = ExpandHome(path);
        string text;
        try
        {
            text = File.ReadAllText(resolved);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
        {
            throw new IdentityException($"failed to read creds file {resolved}", ex);
        }
        return FromCreds(text);
    }

    /// <summary>Build a signer from a seed and a user JWT; the JWT's <c>sub</c> must be the seed's public key.</summary>
    /// <exception cref="IdentityException">The seed or JWT is invalid, or they disagree.</exception>
    public static SenderSigner FromSeedAndJwt(string seed, string jwt)
    {
        ArgumentNullException.ThrowIfNull(seed);
        ArgumentNullException.ThrowIfNull(jwt);
        var signer = new SenderSigner(KeyPairFromSeed(NormalizeUserSeed(seed)), jwt);
        try
        {
            var jwtUser = IdentityFromJwt(jwt).User;
            if (jwtUser == signer.PublicKey) return signer;
            throw new IdentityMismatchException(signer.PublicKey, signer.PublicKey, credentialUser: jwtUser);
        }
        catch
        {
            signer.Dispose();
            throw;
        }
    }

    /// <summary>
    /// The agent ID a user JWT carries: <c>sub</c> is the user NKEY; the account is <c>nats.issuer_account</c> when a
    /// signing key issued the JWT, else <c>iss</c>. The JWT is decoded, not verified.
    /// </summary>
    /// <exception cref="IdentityException">The JWT is malformed or carries no usable pair.</exception>
    public static AgentId IdentityFromJwt(string jwt)
    {
        ArgumentNullException.ThrowIfNull(jwt);
        using var doc = DecodeJwtPayload(jwt);
        var root = doc.RootElement;
        string? sub = root.TryGetProperty("sub", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
        string? iss = root.TryGetProperty("iss", out var i) && i.ValueKind == JsonValueKind.String ? i.GetString() : null;
        string? issuerAccount = null;
        if (root.TryGetProperty("nats", out var nats) && nats.ValueKind == JsonValueKind.Object &&
            nats.TryGetProperty("issuer_account", out var ia) && ia.ValueKind == JsonValueKind.String)
        {
            issuerAccount = ia.GetString();
        }
        var account = !string.IsNullOrEmpty(issuerAccount) ? issuerAccount : iss;
        if (sub is null || account is null) throw new IdentityUnavailableException("credentials JWT lacks a string `sub` or `iss`");
        try
        {
            return AgentId.Create(account, sub);
        }
        catch (InvalidAgentIdException ex)
        {
            throw new IdentityUnavailableException($"credentials JWT does not carry a usable (account, user) pair: {ex.Message}");
        }
    }

    /// <inheritdoc />
    public ValueTask<byte[]> SignAsync(ReadOnlyMemory<byte> data, CancellationToken cancellationToken = default)
        => ValueTask.FromResult(Sign(data.Span));

    /// <summary>Synchronous Ed25519 signature (64 bytes) over <paramref name="data"/>.</summary>
    /// <exception cref="ObjectDisposedException">The signer has been disposed.</exception>
    public byte[] Sign(ReadOnlySpan<byte> data)
    {
        var copy = data.ToArray();
        var sig = new byte[64];
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_keyPair is null, this);
            _keyPair.Sign(copy, sig);
        }
        return sig;
    }

    /// <summary>Clear the key material; later signatures fail.</summary>
    public void Dispose()
    {
        lock (_gate)
        {
            _keyPair?.Dispose();
            _keyPair = null;
        }
    }

    /// <inheritdoc />
    public override string ToString() => $"SenderSigner({PublicKey})";

    internal static (string Jwt, string Seed) ParseCreds(string text)
    {
        var jwt = ExtractBlock(text, BeginJwtRegex(), "NATS USER JWT");
        if (!JwtRegex().IsMatch(jwt)) throw new IdentityException("creds: the user JWT block is not a JWT");
        var seed = ExtractBlock(text, BeginSeedRegex(), "USER NKEY SEED");
        return (jwt, seed);
    }

    internal static string NormalizeUserSeed(string text)
    {
        var line = text.Contains("BEGIN", StringComparison.Ordinal)
            ? ExtractBlock(text, BeginSeedRegex(), "USER NKEY SEED")
            : text.Trim();
        if (!UserSeedRegex().IsMatch(line)) throw new IdentityException("invalid nkey seed: expected a user seed (SU + 56 base32 characters)");
        using var kp = KeyPairFromSeed(line);
        var publicKey = kp.GetPublicKey();
        if (!publicKey.StartsWith('U')) throw new IdentityException($"seed is not a user seed (derives {publicKey[..1]}… public key)");
        return line;
    }

    internal static JsonDocument DecodeJwtPayload(string jwt)
    {
        var parts = jwt.Split('.');
        if (parts.Length != 3) throw new IdentityException("JWT does not have three parts");
        JsonDocument doc;
        try
        {
            if (!Base64Url.TryDecode(parts[1].TrimEnd('='), out var bytes)) throw new FormatException();
            doc = JsonDocument.Parse(Encoding.UTF8.GetString(bytes));
        }
        catch (Exception ex) when (ex is FormatException or JsonException)
        {
            throw new IdentityException("JWT payload is not base64url-encoded JSON");
        }
        if (doc.RootElement.ValueKind != JsonValueKind.Object)
        {
            doc.Dispose();
            throw new IdentityException("JWT payload is not a JSON object");
        }
        return doc;
    }

    private static KeyPair KeyPairFromSeed(string seed)
    {
        try
        {
            var kp = KeyPair.FromSeed(seed);
            _ = kp.GetPublicKey();
            return kp;
        }
        catch (Exception ex) when (ex is not IdentityException)
        {
            throw new IdentityException($"invalid nkey seed ({ex.Message})");
        }
    }

    private static string ExtractBlock(string text, Regex begin, string label)
    {
        var lines = text.Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            if (!begin.IsMatch(TrimJs(lines[i]))) continue;
            for (var j = i + 1; j < lines.Length; j++)
            {
                var candidate = TrimJs(lines[j]);
                if (candidate.Length == 0) continue;
                if (candidate.StartsWith('-')) throw new IdentityException($"creds: empty {label} block at line {i + 1}");
                return candidate;
            }
            throw new IdentityException($"creds: {label} block at line {i + 1} has no content");
        }
        throw new IdentityException($"creds: no -----BEGIN {label}----- block found");
    }

    private static string TrimJs(string line) => line.TrimEnd('\r').Trim();

    private static string ExpandHome(string path)
    {
        if (path == "~" || path.StartsWith("~/", StringComparison.Ordinal) || path.StartsWith("~\\", StringComparison.Ordinal))
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return path.Length == 1 ? home : Path.Combine(home, path[2..]);
        }
        return path;
    }

    [GeneratedRegex(@"\ASU[A-Z2-7]{56}\z", RegexOptions.CultureInvariant)]
    private static partial Regex UserSeedRegex();

    [GeneratedRegex(@"\A[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\z", RegexOptions.CultureInvariant)]
    private static partial Regex JwtRegex();

    [GeneratedRegex(@"\A-+BEGIN NATS USER JWT-+\z", RegexOptions.CultureInvariant)]
    private static partial Regex BeginJwtRegex();

    [GeneratedRegex(@"\A-+BEGIN USER NKEY SEED-+\z", RegexOptions.CultureInvariant)]
    private static partial Regex BeginSeedRegex();
}
