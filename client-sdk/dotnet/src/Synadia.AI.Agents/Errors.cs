namespace Synadia.AI.Agents;

/// <summary>Base class for every exception raised by the Synadia agent SDKs.</summary>
public class AgentException : Exception
{
    /// <summary>Create an exception.</summary>
    public AgentException(string message) : base(message) { }

    /// <summary>Create an exception with an inner cause.</summary>
    public AgentException(string message, Exception? inner) : base(message, inner) { }
}

/// <summary>A wire-level protocol violation (malformed envelope, bad attachment, …). Hosts map it to 400.</summary>
public class AgentProtocolException : AgentException
{
    /// <summary>Create an exception.</summary>
    public AgentProtocolException(string message) : base(message) { }
}

/// <summary>A request envelope failed §5 validation.</summary>
public sealed class InvalidEnvelopeException : AgentProtocolException
{
    /// <summary>Create an exception.</summary>
    public InvalidEnvelopeException(string message) : base(message) { }
}

/// <summary>A subject token violates spec §2.</summary>
public sealed class InvalidSubjectTokenException : AgentException
{
    /// <summary>Create an exception.</summary>
    public InvalidSubjectTokenException(string field, string? token, string reason)
        : base($"invalid {field} token \"{token}\": {reason}")
    {
        Field = field;
        Token = token;
    }

    /// <summary>Which token (agent, owner, name) is invalid.</summary>
    public string Field { get; }

    /// <summary>The offending value.</summary>
    public string? Token { get; }
}

/// <summary>A human-readable size failed to parse.</summary>
public sealed class InvalidSizeException : AgentException
{
    /// <summary>Create an exception.</summary>
    public InvalidSizeException(string input, string reason) : base($"invalid size \"{input}\": {reason}") => Input = input;

    /// <summary>The offending input.</summary>
    public string Input { get; }
}

/// <summary>A protocol version string failed to parse.</summary>
public sealed class InvalidProtocolVersionException : AgentException
{
    /// <summary>Create an exception.</summary>
    public InvalidProtocolVersionException(string input)
        : base($"invalid protocol version \"{input}\": expected MAJOR.MINOR") => Input = input;

    /// <summary>The offending input.</summary>
    public string Input { get; }
}

/// <summary>§5.4: a prompt must be non-empty.</summary>
public sealed class PromptEmptyException : AgentException
{
    /// <summary>Create an exception.</summary>
    public PromptEmptyException() : base("prompt must be a non-empty string") { }
}

/// <summary>§5.4: the agent advertises <c>attachments_ok=false</c> but attachments were supplied.</summary>
public sealed class AttachmentsNotSupportedException : AgentException
{
    /// <summary>Create an exception.</summary>
    public AttachmentsNotSupportedException() : base("agent does not accept attachments (attachments_ok=false)") { }
}

/// <summary>§5.4: the encoded request exceeds the effective <c>max_payload</c>.</summary>
public sealed class PayloadTooLargeException : AgentException
{
    /// <summary>Create an exception.</summary>
    public PayloadTooLargeException(long limit, long size, long headerBytes = 0)
        : base(headerBytes > 0
            ? $"request is {size} bytes + {headerBytes} header bytes, exceeding max_payload {limit}"
            : $"request is {size} bytes, exceeding max_payload {limit}")
    {
        Limit = limit;
        Size = size;
        HeaderBytes = headerBytes;
    }

    /// <summary>The effective limit in bytes.</summary>
    public long Limit { get; }

    /// <summary>The encoded payload size in bytes.</summary>
    public long Size { get; }

    /// <summary>The framed header bytes counted against the limit.</summary>
    public long HeaderBytes { get; }
}

/// <summary>§9.1: the agent replied with a <c>Nats-Service-Error-Code</c> header.</summary>
public sealed class AgentServiceException : AgentException
{
    /// <summary>Create an exception.</summary>
    public AgentServiceException(int code, string description, ReadOnlyMemory<byte> body = default)
        : base($"agent error {code}: {description}")
    {
        Code = code;
        Description = description;
        Body = body;
    }

    /// <summary>The HTTP-like status code (400, 401, 403, 500, 503, …).</summary>
    public int Code { get; }

    /// <summary>The <c>Nats-Service-Error</c> description.</summary>
    public string Description { get; }

    /// <summary>The optional error body (often JSON).</summary>
    public ReadOnlyMemory<byte> Body { get; }
}

/// <summary>§6.6: no chunk arrived within the inactivity timeout.</summary>
public sealed class StreamStalledException : AgentException
{
    /// <summary>Create an exception.</summary>
    public StreamStalledException(TimeSpan timeout)
        : base($"no chunk received for {timeout.TotalMilliseconds:0} ms (inactivity timeout)") => Timeout = timeout;

    /// <summary>The inactivity timeout that elapsed.</summary>
    public TimeSpan Timeout { get; }
}

/// <summary>The overall prompt deadline elapsed before the terminator arrived.</summary>
public sealed class StreamMaxWaitExceededException : AgentException
{
    /// <summary>Create an exception.</summary>
    public StreamMaxWaitExceededException(TimeSpan maxWait)
        : base($"prompt stream did not complete within {maxWait.TotalMilliseconds:0} ms") => MaxWait = maxWait;

    /// <summary>The overall deadline that elapsed.</summary>
    public TimeSpan MaxWait { get; }
}

/// <summary>No agent is subscribed on the requested subject (NATS 503 no-responders).</summary>
public sealed class NoRespondersException : AgentException
{
    /// <summary>Create an exception.</summary>
    public NoRespondersException(string subject) : base($"no responders on {subject}") => Subject = subject;

    /// <summary>The subject that had no responders.</summary>
    public string Subject { get; }
}

/// <summary>§7.2: a query may only be replied to once.</summary>
public sealed class QueryAlreadyRepliedException : AgentException
{
    /// <summary>Create an exception.</summary>
    public QueryAlreadyRepliedException(string id) : base($"query \"{id}\" has already been replied to") => Id = id;

    /// <summary>The query id.</summary>
    public string Id { get; }
}

/// <summary>A status request timed out or returned an invalid payload.</summary>
public sealed class AgentStatusException : AgentException
{
    /// <summary>Create an exception.</summary>
    public AgentStatusException(string message, Exception? inner = null) : base(message, inner) { }
}
