using Microsoft.Extensions.AI;

namespace Synadia.AI.Agents;

/// <summary>
/// A protocol <c>status</c> chunk (§6.4) surfaced as MEAI content: progress text such as <c>"searching"</c>.
/// Produced by <see cref="Agent.AsIChatClient"/>; accepted by the host's <c>PromptStream.WriteAsync(ChatResponseUpdate)</c>.
/// </summary>
public sealed class AgentStatusContent : AIContent
{
    /// <summary>
    /// The <see cref="ChatResponseUpdate.AdditionalProperties"/> key that also carries status text, so an
    /// <see cref="IChatClient"/> that cannot reference this assembly can still emit progress
    /// (a content-less update with <c>AdditionalProperties["synadia.status"] = "..."</c>).
    /// </summary>
    public const string AdditionalPropertyKey = "synadia.status";

    /// <summary>Create a status content.</summary>
    public AgentStatusContent(string status)
    {
        Status = status ?? throw new ArgumentNullException(nameof(status));
    }

    /// <summary>The status text.</summary>
    public string Status { get; }

    /// <summary>True for the protocol-level liveness <c>"ack"</c>.</summary>
    public bool IsAck => Status == "ack";

    /// <inheritdoc />
    public override string ToString() => Status;
}

/// <summary>
/// A mid-stream <c>query</c> (§7) surfaced as an MEAI <see cref="InputRequestContent"/>. The agent is blocked until
/// <see cref="ReplyAsync(string, CancellationToken)"/> is called (exactly once) while the stream is still being consumed.
/// <see cref="InputRequestContent.RequestId"/> is the query id.
/// </summary>
public sealed class AgentQueryContent : InputRequestContent
{
    /// <summary>Wrap a decoded query chunk.</summary>
    public AgentQueryContent(AgentQueryChunk query)
        : base((query ?? throw new ArgumentNullException(nameof(query))).Id)
    {
        Query = query;
        RawRepresentation = query;
    }

    /// <summary>The underlying protocol chunk.</summary>
    public AgentQueryChunk Query { get; }

    /// <summary>The question text.</summary>
    public string Prompt => Query.Prompt;

    /// <summary>Attachments sent with the question.</summary>
    public IReadOnlyList<DataContent> Attachments => Query.Attachments;

    /// <summary>True once a reply was published.</summary>
    public bool Replied => Query.Replied;

    /// <summary>Answer with plain text.</summary>
    public ValueTask ReplyAsync(string answer, CancellationToken cancellationToken = default) => Query.ReplyAsync(answer, cancellationToken);

    /// <summary>Answer with a full envelope (text + attachments).</summary>
    public ValueTask ReplyAsync(PromptEnvelope answer, CancellationToken cancellationToken = default) => Query.ReplyAsync(answer, cancellationToken);

    /// <summary>Answer with an MEAI message: its text and <see cref="DataContent"/> items become the reply envelope.</summary>
    public ValueTask ReplyAsync(ChatMessage answer, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(answer);
        return Query.ReplyAsync(new PromptEnvelope(answer.Text, answer.Contents.OfType<DataContent>()), cancellationToken);
    }

    /// <summary>
    /// Build the <see cref="AgentQueryResponseContent"/> that answers this query. Use it where the answer is passed back
    /// as content (for example on the next Agent Framework run) rather than sent directly with <c>ReplyAsync</c>.
    /// </summary>
    public AgentQueryResponseContent CreateResponse(string text, IEnumerable<DataContent>? attachments = null)
        => new(RequestId, text, attachments);

    /// <inheritdoc />
    public override string ToString() => Prompt;
}

/// <summary>
/// The answer to an <see cref="AgentQueryContent"/>, as an MEAI <see cref="InputResponseContent"/>. Create one with
/// <see cref="AgentQueryContent.CreateResponse"/>.
/// </summary>
public sealed class AgentQueryResponseContent : InputResponseContent
{
    /// <summary>Create an answer for the query whose id is <paramref name="requestId"/>.</summary>
    public AgentQueryResponseContent(string requestId, string text, IEnumerable<DataContent>? attachments = null)
        : base(requestId)
    {
        Text = text ?? throw new ArgumentNullException(nameof(text));
        Attachments = attachments?.ToList() ?? [];
    }

    /// <summary>The answer text.</summary>
    public string Text { get; }

    /// <summary>Attachments sent with the answer.</summary>
    public IReadOnlyList<DataContent> Attachments { get; }

    /// <inheritdoc />
    public override string ToString() => Text;
}
