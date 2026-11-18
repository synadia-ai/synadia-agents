using System.Text.RegularExpressions;
using NATS.NKeys;

namespace Synadia.AI.Agents.Identity;

/// <summary>
/// A validated agent ID (sender-identity extension, §13): <c>{account}.{user}</c>, where <c>user</c> is a user public
/// NKEY and <c>account</c> an account public NKEY, a subject-safe config-mode account name or <c>$G</c>.
/// Equality is byte equality on the text form. There is no zero value: construct via <see cref="Create"/> or
/// <see cref="Parse"/>.
/// </summary>
public sealed partial record AgentId
{
    /// <summary>The canonical agent-ID pattern.</summary>
    public const string Pattern = @"^(A[A-Z2-7]{55}|[A-Za-z0-9_-]+|\$G)\.U[A-Z2-7]{55}$";

    /// <summary>Account tokens longer than this (UTF-8 bytes) are not representable in size budgets.</summary>
    public const int AccountLengthAllowanceBytes = 64;

    private const int NkeyPublicLength = 56;

    private AgentId(string account, string user)
    {
        Account = account;
        User = user;
    }

    /// <summary>The account token.</summary>
    public string Account { get; }

    /// <summary>The user token (a user public NKEY).</summary>
    public string User { get; }

    /// <summary>The canonical text form <c>{account}.{user}</c>.</summary>
    public override string ToString() => $"{Account}.{User}";

    /// <summary>Validate both tokens and build an ID.</summary>
    /// <exception cref="InvalidAgentIdException">Either token is invalid.</exception>
    public static AgentId Create(string account, string user)
    {
        ArgumentNullException.ThrowIfNull(account);
        ArgumentNullException.ThrowIfNull(user);
        AssertValidAccount(account);
        AssertValidUserKey(user);
        return new AgentId(account, user);
    }

    /// <summary>Parse the canonical text form; nothing else is accepted.</summary>
    /// <exception cref="InvalidAgentIdException">The text is not a valid agent ID.</exception>
    public static AgentId Parse(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (text.Length == 0) throw new InvalidAgentIdException("empty string");
        if (!AgentIdRegex().IsMatch(text)) throw new InvalidAgentIdException("expected {account}.{user} with a U… user public NKEY");
        var dot = text.IndexOf('.', StringComparison.Ordinal);
        return Create(text[..dot], text[(dot + 1)..]);
    }

    /// <summary>Parse without throwing.</summary>
    public static bool TryParse(string? text, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out AgentId? id)
    {
        id = null;
        if (text is null) return false;
        try
        {
            id = Parse(text);
            return true;
        }
        catch (InvalidAgentIdException)
        {
            return false;
        }
    }

    /// <summary>True iff <paramref name="account"/> has the shape of an account public NKEY (<c>A…</c>, 56 chars).</summary>
    public static bool IsAccountKeyShaped(string account)
    {
        ArgumentNullException.ThrowIfNull(account);
        return account.Length == NkeyPublicLength && account.StartsWith('A');
    }

    /// <summary>Validate <paramref name="user"/> as a user public NKEY (shape + nkeys prefix/CRC).</summary>
    /// <exception cref="InvalidAgentIdException">The key is invalid.</exception>
    public static void AssertValidUserKey(string user)
    {
        ArgumentNullException.ThrowIfNull(user);
        if (user.Length == 0) throw new InvalidAgentIdException("empty user token");
        if (!UserKeyRegex().IsMatch(user)) throw new InvalidAgentIdException("user token is not a user public NKEY (U + 55 base32 chars)");
        AssertValidNkey("user", PrefixByte.User, user);
    }

    /// <summary>Validate <paramref name="account"/> as an account public NKEY or a representable config-mode name.</summary>
    /// <exception cref="InvalidAgentIdException">The account is invalid.</exception>
    public static void AssertValidAccount(string account)
    {
        ArgumentNullException.ThrowIfNull(account);
        if (account.Length == 0) throw new InvalidAgentIdException("empty account token");
        if (IsAccountKeyShaped(account))
        {
            AssertValidNkey("account", PrefixByte.Account, account);
            return;
        }
        if (!AccountNameRegex().IsMatch(account))
        {
            throw new InvalidAgentIdException(
                "account token is neither an account public NKEY nor a subject-safe name ([A-Za-z0-9_-]+ or $G)");
        }
    }

    internal static bool IsValidUserKey(string user)
    {
        try
        {
            AssertValidUserKey(user);
            return true;
        }
        catch (InvalidAgentIdException)
        {
            return false;
        }
    }

    private static void AssertValidNkey(string kind, PrefixByte prefix, string key)
    {
        string? reason = null;
        try
        {
            if (!KeyPair.IsValidPublicKey(prefix, key)) reason = "invalid public key";
        }
        catch (Exception ex) when (ex is NKeysException or ArgumentException or FormatException or IndexOutOfRangeException)
        {
            reason = ex.Message;
        }
        if (reason is not null) throw new InvalidAgentIdException($"{kind} key fails the nkeys check ({reason})");
    }

    [GeneratedRegex(@"\A(A[A-Z2-7]{55}|[A-Za-z0-9_-]+|\$G)\.U[A-Z2-7]{55}\z", RegexOptions.CultureInvariant)]
    private static partial Regex AgentIdRegex();

    [GeneratedRegex(@"\AU[A-Z2-7]{55}\z", RegexOptions.CultureInvariant)]
    private static partial Regex UserKeyRegex();

    [GeneratedRegex(@"\A([A-Za-z0-9_-]+|\$G)\z", RegexOptions.CultureInvariant)]
    private static partial Regex AccountNameRegex();
}
