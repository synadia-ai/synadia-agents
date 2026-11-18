using System.Text;

namespace Synadia.AI.Agents.Identity;

/// <summary>
/// The <c>id_sig</c> service-metadata signature (§13): an agent proves it holds the user NKEY it advertises in
/// <c>user_nkey</c> / <c>account</c>, bound to its <c>agent</c>, <c>owner</c> and prompt subject.
/// </summary>
public static class AgentIdSignature
{
    /// <summary>The tag that opens the signed input.</summary>
    public const string SignedInputTag = "AGENT-ID-V1";

    /// <summary>Service-metadata key of the user public NKEY.</summary>
    public const string UserNkeyKey = "user_nkey";

    /// <summary>Service-metadata key of the account token.</summary>
    public const string AccountKey = "account";

    /// <summary>Service-metadata key of the signature.</summary>
    public const string IdSigKey = "id_sig";

    /// <summary>The exact signed bytes: <c>AGENT-ID-V1\n{user}\n{account}\n{agent}\n{owner}\n{promptSubject}\n</c>.</summary>
    public static byte[] BuildSignedInput(string user, string account, string agent, string owner, string promptSubject)
        => Encoding.UTF8.GetBytes($"{SignedInputTag}\n{user}\n{account}\n{agent}\n{owner}\n{promptSubject}\n");

    /// <summary>Sign the identity binding; returns the unpadded base64url <c>id_sig</c> value.</summary>
    public static async ValueTask<string> SignAsync(ISenderSigner signer, AgentId id, string agent, string owner, string promptSubject,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(signer);
        ArgumentNullException.ThrowIfNull(id);
        var input = BuildSignedInput(id.User, id.Account, agent, owner, promptSubject);
        return Base64Url.Encode(await signer.SignAsync(input, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>
    /// Verify <c>id_sig</c> in service metadata against <paramref name="promptSubject"/>. False when any of
    /// <c>user_nkey</c>, <c>account</c>, <c>agent</c>, <c>owner</c>, <c>id_sig</c> is missing or the signature fails.
    /// </summary>
    public static bool Verify(IReadOnlyDictionary<string, string> metadata, string promptSubject)
    {
        ArgumentNullException.ThrowIfNull(metadata);
        ArgumentNullException.ThrowIfNull(promptSubject);
        if (!metadata.TryGetValue(UserNkeyKey, out var user) ||
            !metadata.TryGetValue(AccountKey, out var account) ||
            !metadata.TryGetValue("agent", out var agent) ||
            !metadata.TryGetValue("owner", out var owner) ||
            !metadata.TryGetValue(IdSigKey, out var idSig))
        {
            return false;
        }
        if (!AgentId.IsValidUserKey(user) || !Base64Url.TryDecode(idSig, out var sig) || sig.Length != 64) return false;
        return SenderHeader.VerifyWithPublicKey(user, BuildSignedInput(user, account, agent, owner, promptSubject), sig);
    }
}
