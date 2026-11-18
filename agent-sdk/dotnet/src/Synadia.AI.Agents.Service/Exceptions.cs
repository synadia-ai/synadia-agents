namespace Synadia.AI.Agents.Service;

/// <summary>
/// Throw from a prompt handler to refuse the request with a specific §9 status code and description.
/// Any other exception becomes <c>500 handler error</c> (its message is not sent to the caller).
/// </summary>
public class RequestRejectedException : Exception
{
    /// <summary>Create a rejection.</summary>
    /// <param name="code">§9 status code, 400–599.</param>
    /// <param name="description">Single-line description sent in <c>Nats-Service-Error</c>.</param>
    public RequestRejectedException(int code, string description) : base(description)
    {
        if (code is < 400 or > 599) throw new ArgumentOutOfRangeException(nameof(code), code, "status code must be 400-599");
        Code = code;
        Description = description ?? "";
    }

    /// <summary>§9 status code.</summary>
    public int Code { get; }

    /// <summary>Description.</summary>
    public string Description { get; }
}

/// <summary>A mid-stream query (§7) got no reply within its timeout.</summary>
public sealed class AgentQueryTimeoutException : AgentException
{
    /// <summary>Create.</summary>
    public AgentQueryTimeoutException(string id, TimeSpan timeout)
        : base($"query {id} timed out after {timeout.TotalMilliseconds:0}ms")
    {
        Id = id;
        Timeout = timeout;
    }

    /// <summary>Query id.</summary>
    public string Id { get; }

    /// <summary>Timeout that elapsed.</summary>
    public TimeSpan Timeout { get; }
}
