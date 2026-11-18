using System.Text;
using System.Threading.Channels;
using Microsoft.Extensions.AI;
using NATS.Client.Core;

namespace Synadia.AI.Agents.Service;

/// <summary>
/// The outbound side of one prompt request: writes <c>response</c>/<c>status</c> chunks (§6) and asks mid-stream
/// queries (§7). Writes are serialized, so it is safe to call from several tasks. The service sends the leading
/// <c>ack</c>, keep-alives, error frames and the terminator — handlers never do.
/// </summary>
public sealed class PromptStream
{
    private readonly INatsConnection _nc;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly TimeSpan _defaultQueryTimeout;
    private volatile bool _closed;

    internal PromptStream(INatsConnection nc, string replyTo, TimeSpan defaultQueryTimeout)
    {
        _nc = nc;
        ReplyTo = replyTo;
        _defaultQueryTimeout = defaultQueryTimeout;
    }

    /// <summary>The caller's reply subject.</summary>
    public string ReplyTo { get; }

    /// <summary>Send a <c>response</c> chunk (§6.3).</summary>
    public ValueTask WriteAsync(string text, IReadOnlyList<DataContent>? attachments = null, CancellationToken cancellationToken = default)
        => SendAsync(AgentChunkCodec.EncodeResponse(text ?? throw new ArgumentNullException(nameof(text)), attachments), null, cancellationToken);

    /// <summary>Send a <c>status</c> chunk (§6.4). Use short, human-readable progress strings.</summary>
    public ValueTask WriteStatusAsync(string status, CancellationToken cancellationToken = default)
        => SendAsync(AgentChunkCodec.EncodeStatus(status ?? throw new ArgumentNullException(nameof(status))), null, cancellationToken);

    /// <summary>
    /// Map one MEAI streaming update onto the wire: text and <see cref="DataContent"/> become a <c>response</c>
    /// chunk; <see cref="AgentStatusContent"/>, or an <c>AdditionalProperties["synadia.status"]</c> string on the update,
    /// becomes a <c>status</c>; a <see cref="FunctionCallContent"/> becomes a <c>status</c> (<c>calling {name}</c>);
    /// <see cref="TextReasoningContent"/> becomes a <c>status</c> only when <paramref name="includeReasoning"/>;
    /// an <see cref="ErrorContent"/> throws <see cref="RequestRejectedException"/> (500). Other content is dropped.
    /// </summary>
    public async ValueTask WriteAsync(ChatResponseUpdate update, bool includeReasoning = false, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(update);
        StringBuilder? text = null;
        List<DataContent>? data = null;
        var sawStatusContent = false;
        foreach (var content in update.Contents)
        {
            switch (content)
            {
                case TextContent t when !string.IsNullOrEmpty(t.Text):
                    (text ??= new StringBuilder()).Append(t.Text);
                    break;
                case DataContent d:
                    (data ??= []).Add(d);
                    break;
                case AgentStatusContent s when !s.IsAck && s.Status.Length > 0:
                    sawStatusContent = true;
                    await FlushAsync().ConfigureAwait(false);
                    await WriteStatusAsync(s.Status, cancellationToken).ConfigureAwait(false);
                    break;
                case FunctionCallContent call:
                    await FlushAsync().ConfigureAwait(false);
                    await WriteStatusAsync($"calling {call.Name}", cancellationToken).ConfigureAwait(false);
                    break;
                case TextReasoningContent r when includeReasoning && !string.IsNullOrWhiteSpace(r.Text):
                    await FlushAsync().ConfigureAwait(false);
                    await WriteStatusAsync(r.Text, cancellationToken).ConfigureAwait(false);
                    break;
                case ErrorContent e:
                    await FlushAsync().ConfigureAwait(false);
                    throw new RequestRejectedException(500, string.IsNullOrEmpty(e.Message) ? "model error" : e.Message);
            }
        }
        await FlushAsync().ConfigureAwait(false);

        // Content-less (or status-only) convention: AdditionalProperties["synadia.status"] = "...".
        if (!sawStatusContent && update.AdditionalProperties is { } props
            && props.TryGetValue(AgentStatusContent.AdditionalPropertyKey, out var raw)
            && StatusText(raw) is { Length: > 0 } status && status != "ack")
        {
            await WriteStatusAsync(status, cancellationToken).ConfigureAwait(false);
        }

        static string? StatusText(object? value) => value switch
        {
            string s => s,
            System.Text.Json.JsonElement { ValueKind: System.Text.Json.JsonValueKind.String } je => je.GetString(),
            null => null,
            _ => value.ToString(),
        };

        async ValueTask FlushAsync()
        {
            if (text is null && data is null) return;
            await WriteAsync(text?.ToString() ?? "", data, cancellationToken).ConfigureAwait(false);
            text = null;
            data = null;
        }
    }

    /// <summary>Ask the caller a question mid-stream (§7) and wait for its single reply.</summary>
    /// <exception cref="AgentQueryTimeoutException">No reply within <paramref name="timeout"/>.</exception>
    public async Task<PromptEnvelope> AskAsync(string prompt, IEnumerable<DataContent>? attachments = null, TimeSpan? timeout = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(prompt);
        var wait = timeout ?? _defaultQueryTimeout;
        var replySubject = _nc.NewInbox();
        var id = Guid.NewGuid().ToString("N");
        var opts = new NatsSubOpts
        {
            MaxMsgs = 1,
            ChannelOpts = new NatsSubChannelOpts { FullMode = BoundedChannelFullMode.Wait, Capacity = 4 },
        };
        await using var sub = await _nc.SubscribeCoreAsync<ReadOnlyMemory<byte>>(replySubject, opts: opts, cancellationToken: cancellationToken)
            .ConfigureAwait(false);
        await _nc.PingAsync(cancellationToken).ConfigureAwait(false);
        await SendAsync(AgentChunkCodec.EncodeQuery(id, replySubject, prompt, attachments?.ToArray()), null, cancellationToken)
            .ConfigureAwait(false);

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(wait);
        try
        {
            while (await sub.Msgs.WaitToReadAsync(cts.Token).ConfigureAwait(false))
            {
                if (!sub.Msgs.TryRead(out var msg)) continue;
                return DecodeReply(msg.Data);
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new AgentQueryTimeoutException(id, wait);
        }
        cancellationToken.ThrowIfCancellationRequested();
        throw new AgentException($"query {id} reply subscription closed before any reply arrived");
    }

    /// <summary>
    /// Ask the caller to approve a tool call (§7 yes/no query) and return the MEAI answer. A timeout denies the call
    /// (reason <c>"approval timed out"</c>); a denial carries the caller's reply text as its reason.
    /// </summary>
    public async Task<ToolApprovalResponseContent> AskApprovalAsync(ToolApprovalRequestContent request, ToolApprovalOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        var question = options?.Prompt?.Invoke(request) ?? ToolApprovalOptions.DefaultPrompt(request);
        PromptEnvelope reply;
        try
        {
            reply = await AskAsync(question, null, options?.Timeout, cancellationToken).ConfigureAwait(false);
        }
        catch (AgentQueryTimeoutException)
        {
            return request.CreateResponse(false, "approval timed out");
        }
        var approved = (options?.Parser ?? ToolApprovalOptions.DefaultParser)(reply);
        return request.CreateResponse(approved, approved ? null : (reply.Prompt.Length > 0 ? reply.Prompt : "denied"));
    }

    /// <summary>
    /// Best-effort probe: is the caller still listening? Publishes an <c>ack</c> keep-alive with a probe reply
    /// subject; a no-responders status means the caller is gone (§6.7 — the protocol has no cancel message).
    /// </summary>
    public async Task<bool> IsCallerListeningAsync(TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        try
        {
            var probe = _nc.NewInbox();
            await using var sub = await _nc.SubscribeCoreAsync<ReadOnlyMemory<byte>>(probe, opts: new NatsSubOpts { MaxMsgs = 1 },
                cancellationToken: cancellationToken).ConfigureAwait(false);
            await _nc.PingAsync(cancellationToken).ConfigureAwait(false);
            await SendAsync(AgentChunkCodec.EncodeStatus("ack"), probe, cancellationToken).ConfigureAwait(false);
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(timeout ?? TimeSpan.FromMilliseconds(500));
            try
            {
                while (await sub.Msgs.WaitToReadAsync(cts.Token).ConfigureAwait(false))
                {
                    if (sub.Msgs.TryRead(out var msg) && msg.HasNoResponders) return false;
                }
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
            }
            return true;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return false;
        }
    }

    internal static PromptEnvelope DecodeReply(ReadOnlyMemory<byte> data)
    {
        try
        {
            return PromptEnvelope.Decode(data.Span);
        }
        catch (InvalidEnvelopeException)
        {
            // Lenient: a bare-text reply is treated as the answer text.
            var text = Encoding.UTF8.GetString(data.Span);
            if (text.Length > 0 && !text.TrimStart().StartsWith('{')) return new PromptEnvelope(text);
            throw;
        }
    }

    internal void Close() => _closed = true;

    internal async ValueTask SendAsync(ReadOnlyMemory<byte> body, string? replyTo, CancellationToken cancellationToken)
    {
        if (_closed) throw new InvalidOperationException("the prompt stream is closed (the handler already returned)");
        await _lock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await _nc.PublishAsync(ReplyTo, body, replyTo: replyTo, cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _lock.Release();
        }
    }

    internal async ValueTask SendRawAsync(ReadOnlyMemory<byte> body, NatsHeaders? headers)
    {
        await _lock.WaitAsync().ConfigureAwait(false);
        try
        {
            await _nc.PublishAsync(ReplyTo, body, headers).ConfigureAwait(false);
        }
        finally
        {
            _lock.Release();
        }
    }
}
