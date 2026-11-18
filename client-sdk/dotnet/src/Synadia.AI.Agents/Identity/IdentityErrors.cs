namespace Synadia.AI.Agents.Identity;

/// <summary>Base class of every sender-identity error (§13).</summary>
public class IdentityException : AgentException
{
    /// <summary>Create an exception.</summary>
    public IdentityException(string message) : base(message) { }

    /// <summary>Create an exception with an inner cause.</summary>
    public IdentityException(string message, Exception? inner) : base(message, inner) { }
}

/// <summary>
/// The server answered <c>$SYS.REQ.USER.INFO</c> but the connection has no NKEY user (no authentication, a password or
/// token user), or reported a config-mode account name the canonical agent-ID form cannot carry.
/// </summary>
public sealed class NoIdentityException : IdentityException
{
    /// <summary>Create an exception.</summary>
    public NoIdentityException(string reason)
        : base($"this connection has no NKEY identity ({reason}); configure an nkey user on the server and connect with its seed, or connect with a credentials file")
        => Reason = reason;

    /// <summary>Why the connection has no usable identity.</summary>
    public string Reason { get; }
}

/// <summary>
/// The SDK does not know the connection's identity: <c>$SYS.REQ.USER.INFO</c> did not answer, a permission blocks it,
/// or the credentials JWT is unusable.
/// </summary>
public sealed class IdentityUnavailableException : IdentityException
{
    /// <summary>Create an exception.</summary>
    public IdentityUnavailableException(string message, Exception? inner = null) : base($"identity unavailable: {message}", inner) { }
}

/// <summary>The configured signer's user/account identity does not match the live connection.</summary>
public sealed class IdentityMismatchException : IdentityException
{
    /// <summary>Create an exception.</summary>
    public IdentityMismatchException(string signerPublicKey, string identityUser, string? signerAccount = null,
        string? identityAccount = null, string? credentialUser = null)
        : base(credentialUser is not null
            ? $"identity mismatch: the configured signer holds {signerPublicKey} but its credentials JWT names user {credentialUser}"
            : signerAccount is not null && identityAccount is not null
                ? $"identity mismatch: the configured signer represents {signerAccount}.{signerPublicKey} but the live connection is {identityAccount}.{identityUser}"
                : $"identity mismatch: the configured signer holds {signerPublicKey} but the connection's user NKEY is {identityUser}")
    {
        SignerPublicKey = signerPublicKey;
        IdentityUser = identityUser;
        SignerAccount = signerAccount;
        IdentityAccount = identityAccount;
        CredentialUser = credentialUser;
    }

    /// <summary>The signer's user public key.</summary>
    public string SignerPublicKey { get; }

    /// <summary>The live connection's user (or the credential user).</summary>
    public string IdentityUser { get; }

    /// <summary>The account the signer's JWT names, when the accounts disagree.</summary>
    public string? SignerAccount { get; }

    /// <summary>The live connection's account, when the accounts disagree.</summary>
    public string? IdentityAccount { get; }

    /// <summary>The user the credentials JWT names, when it disagrees with the seed.</summary>
    public string? CredentialUser { get; }
}

/// <summary><see cref="AgentId.Parse"/> / <see cref="AgentId.Create"/> rejected the input.</summary>
public sealed class InvalidAgentIdException : IdentityException
{
    /// <summary>Create an exception.</summary>
    public InvalidAgentIdException(string message) : base($"invalid agent id: {message}") { }
}

/// <summary>The <c>Agent-Sender</c> header failed the parser (hosts answer <c>400</c>).</summary>
public sealed class MalformedSenderHeaderException : IdentityException
{
    /// <summary>Create an exception.</summary>
    public MalformedSenderHeaderException(string message) : base($"malformed Agent-Sender header: {message}") { }
}

/// <summary>
/// The agent requires a signed sender (<c>min_sender_trust=signed</c>) but no signer is configured. Raised before any
/// I/O; mirrors the host's <c>401 signature required</c>.
/// </summary>
public sealed class SenderSignatureRequiredException : IdentityException
{
    /// <summary>Create an exception.</summary>
    public SenderSignatureRequiredException(string subject)
        : base($"{subject} requires a signed Agent-Sender header (min_sender_trust=signed) but no identity.signer is configured")
        => Subject = subject;

    /// <summary>Always <c>401</c>.</summary>
    public int Code => 401;

    /// <summary>Always <c>"signature required"</c>.</summary>
    public string Description => SenderHeader.SignatureRequiredDescription;

    /// <summary>The prompt subject.</summary>
    public string Subject { get; }
}

/// <summary>A signed <c>Agent-Sender</c> header failed verification (stale, replayed, foreign subject, bad signature, …).</summary>
public sealed class SenderVerificationException : IdentityException
{
    /// <summary>Create an exception.</summary>
    public SenderVerificationException(int code, string description, string detail)
        : base($"sender verification failed ({code}): {detail}")
    {
        Code = code;
        Description = description;
        Detail = detail;
    }

    /// <summary>The error code a host answers with (<c>401</c>).</summary>
    public int Code { get; }

    /// <summary>The <c>Nats-Service-Error</c> description (<c>"sender rejected"</c>).</summary>
    public string Description { get; }

    /// <summary>Why verification failed (for logs; never sent to the caller).</summary>
    public string Detail { get; }
}
