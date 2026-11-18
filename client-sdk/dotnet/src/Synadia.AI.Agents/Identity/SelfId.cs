using System.Text.Json;
using NATS.Client.Core;

namespace Synadia.AI.Agents.Identity;

/// <summary>
/// The connection's own agent ID, from <c>$SYS.REQ.USER.INFO</c> (§13). Every server answers that subject for the
/// requesting connection; no system-account access is needed.
/// </summary>
public static class SelfId
{
    /// <summary>The subject asked for the connection's identity.</summary>
    public const string UserInfoSubject = "$SYS.REQ.USER.INFO";

    /// <summary>Spec default timeout of the lookup (2 s).</summary>
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(2);

    /// <summary>
    /// One uncached lookup. A configured <paramref name="signer"/> must match the live user; when it carries a JWT,
    /// both its user and account must equal the live answer.
    /// </summary>
    /// <exception cref="NoIdentityException">The connection has no NKEY user.</exception>
    /// <exception cref="IdentityUnavailableException">The server did not answer usefully.</exception>
    /// <exception cref="IdentityMismatchException">The signer does not belong to the connection.</exception>
    public static async Task<AgentId> LookupAsync(INatsConnection connection, ISenderSigner? signer = null, TimeSpan? timeout = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(connection);
        var liveId = await RequestUserInfoAsync(connection, timeout ?? DefaultTimeout, cancellationToken).ConfigureAwait(false);
        BindSigner(liveId, signer);
        return liveId;
    }

    internal static void BindSigner(AgentId liveId, ISenderSigner? signer)
    {
        if (signer is null) return;
        if (liveId.User != signer.PublicKey) throw new IdentityMismatchException(signer.PublicKey, liveId.User);
        if (signer.Jwt is null) return;
        var signerId = SenderSigner.IdentityFromJwt(signer.Jwt);
        if (signerId.User != signer.PublicKey)
            throw new IdentityMismatchException(signer.PublicKey, liveId.User, credentialUser: signerId.User);
        if (signerId != liveId)
            throw new IdentityMismatchException(signer.PublicKey, liveId.User, signerId.Account, liveId.Account);
    }

    private static async Task<AgentId> RequestUserInfoAsync(INatsConnection nc, TimeSpan timeout, CancellationToken cancellationToken)
    {
        NatsMsg<ReadOnlyMemory<byte>> reply;
        try
        {
            reply = await nc.RequestAsync<byte[], ReadOnlyMemory<byte>>(UserInfoSubject, [],
                replyOpts: new NatsSubOpts { Timeout = timeout }, cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        catch (NatsNoRespondersException ex)
        {
            throw new IdentityUnavailableException($"no responder for {UserInfoSubject} (server without the system responder?)", ex);
        }
        catch (NatsNoReplyException ex)
        {
            throw new IdentityUnavailableException($"no reply from {UserInfoSubject} within {timeout.TotalMilliseconds:0} ms", ex);
        }
        catch (NatsException ex)
        {
            throw new IdentityUnavailableException($"{UserInfoSubject} request failed: {ex.Message}", ex);
        }
        if (reply.HasNoResponders)
            throw new IdentityUnavailableException($"no responder for {UserInfoSubject} (server without the system responder?)");
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(reply.Data);
        }
        catch (JsonException)
        {
            throw new IdentityUnavailableException($"{UserInfoSubject} reply is not JSON");
        }
        using (doc) return FromUserInfo(doc.RootElement);
    }

    /// <summary>
    /// Derive the agent ID from a parsed <c>$SYS.REQ.USER.INFO</c> reply (<c>{"data":{"user":…,"account":…}}</c>).
    /// Unknown fields are ignored.
    /// </summary>
    /// <exception cref="NoIdentityException">No NKEY user, or an account the agent-ID form cannot carry.</exception>
    /// <exception cref="IdentityUnavailableException">The reply is not the expected shape.</exception>
    public static AgentId FromUserInfo(JsonElement reply)
    {
        if (reply.ValueKind != JsonValueKind.Object) throw new IdentityUnavailableException($"{UserInfoSubject} reply is not a JSON object");
        if (reply.TryGetProperty("error", out var error) && error.ValueKind is not JsonValueKind.Undefined)
            throw new IdentityUnavailableException($"{UserInfoSubject} answered with an error: {error.GetRawText()}");
        if (!reply.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            throw new IdentityUnavailableException($"{UserInfoSubject} reply has no `data` object");
        if (!data.TryGetProperty("user", out var u) || u.ValueKind != JsonValueKind.String ||
            !data.TryGetProperty("account", out var a) || a.ValueKind != JsonValueKind.String)
        {
            throw new IdentityUnavailableException($"{UserInfoSubject} reply lacks string `user` / `account`");
        }
        var user = u.GetString()!;
        var account = a.GetString()!;
        if (user.Length == 0) throw new NoIdentityException("no authentication — the server reports an empty user");
        if (user == "[REDACTED]") throw new NoIdentityException("token authentication — the server reports a redacted user");
        if (!AgentId.IsValidUserKey(user))
        {
            var sb = new System.Text.StringBuilder();
            SenderHeader.AppendJsonString(sb, user);
            throw new NoIdentityException($"password authentication — the server reports the user name {sb}, not an NKEY");
        }
        if (System.Text.Encoding.UTF8.GetByteCount(account) > AgentId.AccountLengthAllowanceBytes)
        {
            throw new NoIdentityException(
                $"the account name is longer than {AgentId.AccountLengthAllowanceBytes} bytes and cannot be carried by the agent-ID form");
        }
        try
        {
            return AgentId.Create(account, user);
        }
        catch (InvalidAgentIdException ex)
        {
            var sb = new System.Text.StringBuilder();
            SenderHeader.AppendJsonString(sb, account);
            throw new NoIdentityException($"the account name {sb} cannot be carried by the agent-ID form ({ex.Message})");
        }
    }
}
