using System.Text.Json;
using Microsoft.Extensions.AI;

namespace Synadia.AI.Agents;

/// <summary>One decoded chunk of a prompt response stream (spec §6.2).</summary>
public abstract record AgentChunk;

/// <summary>A <c>response</c> chunk: a fragment of the agent's answer, optionally with attachments (§6.3).</summary>
/// <param name="Text">The response text fragment (may be empty when only attachments are sent).</param>
/// <param name="Attachments">Attachments, decoded to <see cref="DataContent"/> with <see cref="DataContent.Name"/> = filename.</param>
public sealed record AgentResponseChunk(string Text, IReadOnlyList<DataContent> Attachments) : AgentChunk
{
    /// <summary>Create a text-only response chunk.</summary>
    public AgentResponseChunk(string text) : this(text, []) { }
}

/// <summary>A <c>status</c> chunk: progress text such as <c>"ack"</c> or <c>"thinking"</c> (§6.4).</summary>
public sealed record AgentStatusChunk(string Status) : AgentChunk
{
    /// <summary>True for the protocol-level <c>"ack"</c> status the host emits on receipt and as keep-alive.</summary>
    public bool IsAck => Status == "ack";
}

/// <summary>
/// A <c>query</c> chunk: the agent paused and asks the caller a question (§7). Reply exactly once with
/// <see cref="ReplyAsync(string, CancellationToken)"/> or <see cref="ReplyAsync(PromptEnvelope, CancellationToken)"/>.
/// </summary>
public sealed record AgentQueryChunk : AgentChunk
{
    private readonly Func<string, ReadOnlyMemory<byte>, CancellationToken, ValueTask>? _publish;
    private int _replied;

    /// <summary>Create a query chunk. <paramref name="publish"/> receives (reply subject, reply bytes) and sends them.</summary>
    public AgentQueryChunk(string id, string replySubject, string prompt, IReadOnlyList<DataContent> attachments,
        Func<string, ReadOnlyMemory<byte>, CancellationToken, ValueTask>? publish)
    {
        Id = id;
        ReplySubject = replySubject;
        Prompt = prompt;
        Attachments = attachments;
        _publish = publish;
    }

    /// <summary>Query id, unique within the stream.</summary>
    public string Id { get; }

    /// <summary>Subject the single reply is published to.</summary>
    public string ReplySubject { get; }

    /// <summary>The question text.</summary>
    public string Prompt { get; }

    /// <summary>Attachments accompanying the question.</summary>
    public IReadOnlyList<DataContent> Attachments { get; }

    /// <summary>True once a reply has been sent.</summary>
    public bool Replied => Volatile.Read(ref _replied) != 0;

    /// <summary>Reply with plain text (§5.1 shorthand).</summary>
    /// <exception cref="QueryAlreadyRepliedException">A reply was already sent.</exception>
    public ValueTask ReplyAsync(string answer, CancellationToken cancellationToken = default)
        => SendAsync(System.Text.Encoding.UTF8.GetBytes(answer ?? throw new ArgumentNullException(nameof(answer))), cancellationToken);

    /// <summary>Reply with a JSON envelope (text + attachments).</summary>
    /// <exception cref="QueryAlreadyRepliedException">A reply was already sent.</exception>
    public ValueTask ReplyAsync(PromptEnvelope answer, CancellationToken cancellationToken = default)
        => SendAsync((answer ?? throw new ArgumentNullException(nameof(answer))).Encode(), cancellationToken);

    private ValueTask SendAsync(byte[] payload, CancellationToken cancellationToken)
    {
        if (Interlocked.Exchange(ref _replied, 1) != 0) throw new QueryAlreadyRepliedException(Id);
        if (_publish is null) throw new InvalidOperationException("query chunk is not bound to a connection");
        return _publish(ReplySubject, payload, cancellationToken);
    }
}

/// <summary>
/// Pure encode/decode of the §6 chunk wire format. Shared by the caller and host SDKs; also useful to
/// harness authors that want byte-exact chunks without the full service.
/// </summary>
public static class AgentChunkCodec
{
    /// <summary>The empty-body terminator that ends every prompt stream (§6.5).</summary>
    public static ReadOnlyMemory<byte> Terminator => ReadOnlyMemory<byte>.Empty;

    /// <summary>Encode <c>{"type":"response","data":"text"}</c>, or the object form when attachments are present.</summary>
    public static byte[] EncodeResponse(string text, IReadOnlyList<DataContent>? attachments = null)
        => WireJson.Write(w =>
        {
            w.WriteStartObject();
            w.WriteString("type", "response");
            if (attachments is { Count: > 0 })
            {
                w.WriteStartObject("data");
                w.WriteString("text", text);
                w.WriteStartArray("attachments");
                for (var i = 0; i < attachments.Count; i++)
                {
                    WireJson.WriteAttachment(w, PromptEnvelope.FileNameOf(attachments[i], i), attachments[i].Data.Span);
                }
                w.WriteEndArray();
                w.WriteEndObject();
            }
            else
            {
                w.WriteString("data", text);
            }
            w.WriteEndObject();
        });

    /// <summary>Encode <c>{"type":"status","data":"..."}</c>.</summary>
    public static byte[] EncodeStatus(string status)
        => WireJson.Write(w =>
        {
            w.WriteStartObject();
            w.WriteString("type", "status");
            w.WriteString("data", status);
            w.WriteEndObject();
        });

    /// <summary>Encode a §7.1 query chunk.</summary>
    public static byte[] EncodeQuery(string id, string replySubject, string prompt, IReadOnlyList<DataContent>? attachments = null)
        => WireJson.Write(w =>
        {
            w.WriteStartObject();
            w.WriteString("type", "query");
            w.WriteStartObject("data");
            w.WriteString("id", id);
            w.WriteString("reply_subject", replySubject);
            w.WriteString("prompt", prompt);
            if (attachments is { Count: > 0 })
            {
                w.WriteStartArray("attachments");
                for (var i = 0; i < attachments.Count; i++)
                {
                    WireJson.WriteAttachment(w, PromptEnvelope.FileNameOf(attachments[i], i), attachments[i].Data.Span);
                }
                w.WriteEndArray();
            }
            w.WriteEndObject();
            w.WriteEndObject();
        });

    /// <summary>
    /// Decode a chunk body. Returns <c>null</c> for unknown <c>type</c> values (§6.6: silently drop).
    /// Query chunks are returned unbound (their <c>ReplyAsync</c> throws) unless <paramref name="publish"/> is given.
    /// </summary>
    /// <exception cref="AgentProtocolException">Malformed JSON or a malformed known shape.</exception>
    public static AgentChunk? Decode(ReadOnlySpan<byte> body, Func<string, ReadOnlyMemory<byte>, CancellationToken, ValueTask>? publish = null)
    {
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(body.ToArray());
        }
        catch (JsonException ex)
        {
            throw new AgentProtocolException($"chunk body is not valid JSON: {ex.Message}");
        }
        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new AgentProtocolException("chunk body must be a JSON object");
            if (!root.TryGetProperty("type", out var typeEl) || typeEl.ValueKind != JsonValueKind.String)
            {
                throw new AgentProtocolException("chunk body missing string `type` field");
            }
            root.TryGetProperty("data", out var data);
            return typeEl.GetString() switch
            {
                "response" => DecodeResponse(data),
                "status" => data.ValueKind == JsonValueKind.String
                    ? new AgentStatusChunk(data.GetString()!)
                    : throw new AgentProtocolException("`status` chunk `data` must be a string"),
                "query" => DecodeQuery(data, publish),
                _ => null,
            };
        }
    }

    private static AgentResponseChunk DecodeResponse(JsonElement data)
    {
        if (data.ValueKind == JsonValueKind.String) return new AgentResponseChunk(data.GetString()!);
        if (data.ValueKind != JsonValueKind.Object) throw new AgentProtocolException("`response` chunk `data` must be a string or object");
        if (!data.TryGetProperty("text", out var t) || t.ValueKind != JsonValueKind.String)
        {
            throw new AgentProtocolException("`response` chunk `data.text` must be a string");
        }
        return new AgentResponseChunk(t.GetString()!, DecodeAttachments(data, "response"));
    }

    private static AgentQueryChunk DecodeQuery(JsonElement data, Func<string, ReadOnlyMemory<byte>, CancellationToken, ValueTask>? publish)
    {
        if (data.ValueKind != JsonValueKind.Object) throw new AgentProtocolException("`query` chunk `data` must be an object");
        string Req(string name)
            => data.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String
                ? el.GetString()!
                : throw new AgentProtocolException($"`query` chunk missing string `{name}`");
        return new AgentQueryChunk(Req("id"), Req("reply_subject"), Req("prompt"), DecodeAttachments(data, "query"), publish);
    }

    private static IReadOnlyList<DataContent> DecodeAttachments(JsonElement data, string ctx)
    {
        if (!data.TryGetProperty("attachments", out var arr)) return [];
        if (arr.ValueKind != JsonValueKind.Array) throw new AgentProtocolException($"`{ctx}` chunk `attachments` must be an array");
        try
        {
            return PromptEnvelope.DecodeAttachments(arr);
        }
        catch (InvalidEnvelopeException ex)
        {
            throw new AgentProtocolException($"`{ctx}` chunk {ex.Message}");
        }
    }
}
