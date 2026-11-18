using System.Runtime.CompilerServices;
using System.Text;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using NATS.Client.Core;
using Synadia.AI.Agents.Identity;

namespace Synadia.AI.Agents;

/// <summary>Collected result of a whole prompt stream.</summary>
/// <param name="Text">Concatenated response text.</param>
/// <param name="Attachments">All response attachments, in order.</param>
/// <param name="Statuses">Non-ack status updates, in order.</param>
public sealed record AgentResponse(string Text, IReadOnlyList<Microsoft.Extensions.AI.DataContent> Attachments, IReadOnlyList<string> Statuses);

/// <summary>A handle to one discovered agent instance. Cheap; create as many as you like.</summary>
public sealed class Agent
{
    internal Agent(AgentsClient client, AgentInfo info)
    {
        Client = client;
        Info = info;
    }

    /// <summary>The owning client.</summary>
    public AgentsClient Client { get; }

    /// <summary>Discovery data for this instance.</summary>
    public AgentInfo Info { get; }

    /// <summary>The prompt subject (<c>agents.prompt.{agent}.{owner}.{name}</c>).</summary>
    public string PromptSubject => Info.PromptEndpoint.Subject;

    /// <summary>The status subject: the registered <c>status</c> endpoint, or the v0.3 default.</summary>
    public string StatusSubject
        => Info.StatusEndpoint?.Subject ?? (Info.Subject?.Status ?? $"agents.status.{Info.Agent}.{Info.Owner}.{Info.Name}");

    /// <summary>Heartbeat-derived liveness, or <c>null</c> when no beat has been observed yet.</summary>
    public AgentLiveness? Liveness => Client.Heartbeats.GetLiveness(Info.InstanceId);

    /// <inheritdoc />
    public override string ToString() => $"{Info.Agent}/{Info.Owner}/{Info.Name} ({Info.InstanceId})";

    /// <summary>
    /// Adapt this agent to <see cref="Microsoft.Extensions.AI.IChatClient"/>. Only the newest user message is sent
    /// (the agent keeps its own conversation); responses map to <see cref="Microsoft.Extensions.AI.TextContent"/> /
    /// <see cref="Microsoft.Extensions.AI.DataContent"/>, statuses to <see cref="AgentStatusContent"/> and queries to
    /// <see cref="AgentQueryContent"/>.
    /// </summary>
    public Microsoft.Extensions.AI.IChatClient AsIChatClient(AgentChatClientOptions? options = null) => new AgentChatClient(this, options);

    /// <summary>Send a plain-text prompt and stream the chunks (§6).</summary>
    public IAsyncEnumerable<AgentChunk> PromptAsync(string prompt, PromptOptions? options = null, CancellationToken cancellationToken = default)
        => PromptAsync(new PromptEnvelope(prompt ?? throw new ArgumentNullException(nameof(prompt))), options, cancellationToken);

    /// <summary>
    /// Send a prompt envelope (text + attachments + extras) and stream the chunks until the empty terminator (§6.5).
    /// Validation (§5.4) happens before any I/O. Error frames (§9.1) raise <see cref="AgentServiceException"/>.
    /// </summary>
    /// <exception cref="PromptEmptyException">The prompt is empty.</exception>
    /// <exception cref="AttachmentsNotSupportedException">The agent rejects attachments.</exception>
    /// <exception cref="PayloadTooLargeException">The request exceeds max_payload.</exception>
    /// <exception cref="AgentServiceException">The agent returned an error frame.</exception>
    /// <exception cref="StreamStalledException">No chunk within the inactivity timeout.</exception>
    /// <exception cref="StreamMaxWaitExceededException">The overall deadline elapsed.</exception>
    /// <exception cref="NoRespondersException">Nobody is listening on the prompt subject.</exception>
    /// <exception cref="SenderSignatureRequiredException">The agent requires signed senders and no signer is configured.</exception>
    /// <exception cref="IdentityException">Identity is configured with a signer and the connection's identity cannot be bound to it.</exception>
    public IAsyncEnumerable<AgentChunk> PromptAsync(PromptEnvelope envelope, PromptOptions? options = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        var sub = options?.Sub ?? PromptSubject;
        var requireSigned = Info.PromptEndpoint.MinSenderTrust == "signed";
        var identity = Client.Identity;
        if (requireSigned && identity?.Signer is null) throw new SenderSignatureRequiredException(PromptSubject);
        var headerBound = identity?.MayAttachHeader() == true ? SenderHeader.MaxHeaderBytes(sub, identity.Name) : 0;
        var payload = Validate(envelope, options, headerBound);
        return StreamAsync(payload, options, sub, requireSigned, cancellationToken);
    }

    /// <summary>Prompt and collect the whole response. Queries are answered by <paramref name="onQuery"/> or fail the call.</summary>
    public async Task<AgentResponse> GetResponseAsync(PromptEnvelope envelope, Func<AgentQueryChunk, CancellationToken, ValueTask>? onQuery = null,
        PromptOptions? options = null, CancellationToken cancellationToken = default)
    {
        var text = new StringBuilder();
        var attachments = new List<Microsoft.Extensions.AI.DataContent>();
        var statuses = new List<string>();
        await foreach (var chunk in PromptAsync(envelope, options, cancellationToken).ConfigureAwait(false))
        {
            switch (chunk)
            {
                case AgentResponseChunk r:
                    text.Append(r.Text);
                    attachments.AddRange(r.Attachments);
                    break;
                case AgentStatusChunk s when !s.IsAck:
                    statuses.Add(s.Status);
                    break;
                case AgentQueryChunk q:
                    if (onQuery is null) throw new AgentException($"agent asked a query (\"{q.Prompt}\") but no query handler was supplied");
                    await onQuery(q, cancellationToken).ConfigureAwait(false);
                    break;
            }
        }
        return new AgentResponse(text.ToString(), attachments, statuses);
    }

    /// <summary>Prompt with plain text and collect the response text.</summary>
    public async Task<string> GetResponseTextAsync(string prompt, PromptOptions? options = null, CancellationToken cancellationToken = default)
        => (await GetResponseAsync(new PromptEnvelope(prompt), null, options, cancellationToken).ConfigureAwait(false)).Text;

    /// <summary>Request a fresh heartbeat payload from the <c>status</c> endpoint (§8.7).</summary>
    /// <exception cref="AgentStatusException">Timeout, no responders or invalid payload.</exception>
    public async Task<HeartbeatPayload> GetStatusAsync(TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        NatsMsg<ReadOnlyMemory<byte>> reply;
        NatsHeaders? headers = null;
        if (Client.Identity is { } identity)
        {
            var plan = await identity.PlanAsync(StatusSubject, false, cancellationToken).ConfigureAwait(false);
            if (plan is not null)
            {
                var header = await plan.BuildAsync(ReadOnlyMemory<byte>.Empty, null, cancellationToken).ConfigureAwait(false);
                headers = new NatsHeaders { [SenderHeader.HeaderName] = SenderHeader.Serialize(header) };
            }
        }
        try
        {
            reply = await Client.Connection.RequestAsync<byte[], ReadOnlyMemory<byte>>(
                StatusSubject, [], headers, replyOpts: new NatsSubOpts { Timeout = timeout ?? Client.Options.StatusTimeout },
                cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        catch (NatsNoRespondersException ex)
        {
            throw new AgentStatusException($"no responders on {StatusSubject}", ex);
        }
        catch (NatsNoReplyException ex)
        {
            throw new AgentStatusException($"status request to {StatusSubject} timed out", ex);
        }
        if (reply.HasNoResponders) throw new AgentStatusException($"no responders on {StatusSubject}");
        if (TryGetServiceError(reply.Headers, reply.Data, out var err)) throw new AgentStatusException(err.Message, err);
        return HeartbeatPayload.TryDecode(reply.Data.Span) ?? throw new AgentStatusException("status reply is not a valid heartbeat payload");
    }

    /// <summary><c>$SRV.PING</c> this instance; <c>null</c> when it did not answer.</summary>
    public Task<TimeSpan?> PingAsync(TimeSpan? timeout = null, CancellationToken cancellationToken = default)
        => Client.PingAsync(Info.InstanceId, timeout, cancellationToken);

    private byte[] Validate(PromptEnvelope envelope, PromptOptions? options, int senderHeaderBytes)
    {
        if (envelope.Prompt.Length == 0) throw new PromptEmptyException();
        if (envelope.Attachments.Count > 0 && Info.PromptEndpoint.AttachmentsOk == false) throw new AttachmentsNotSupportedException();
        var payload = envelope.Encode();
        CheckSize(payload.Length, options, senderHeaderBytes);
        return payload;
    }

    private void CheckSize(int payloadBytes, PromptOptions? options, int senderHeaderBytes)
    {
        const int framing = 12; // "NATS/1.0\r\n\r\n"
        long headerBytes = senderHeaderBytes;
        if (options?.Headers is { Count: > 0 } h)
        {
            var extra = h.Where(kv => kv.Key != SenderHeader.HeaderName || senderHeaderBytes == 0)
                .Sum(kv => Encoding.UTF8.GetByteCount(kv.Key) + Encoding.UTF8.GetByteCount(kv.Value) + 4);
            // The sender-header size already includes the framing.
            if (extra > 0) headerBytes += extra + (senderHeaderBytes > 0 ? 0 : framing);
        }
        long? endpointLimit = Info.PromptEndpoint.MaxPayloadBytes;
        long? connLimit = Client.Connection.ServerInfo?.MaxPayload is > 0 and var mp ? mp : null;
        long? effective = endpointLimit is not null && connLimit is not null
            ? Math.Min(endpointLimit.Value, connLimit.Value)
            : endpointLimit ?? connLimit;
        if (effective is not null && payloadBytes + headerBytes > effective)
        {
            throw new PayloadTooLargeException(effective.Value, payloadBytes, headerBytes);
        }
    }

    private async IAsyncEnumerable<AgentChunk> StreamAsync(byte[] payload, PromptOptions? options, string signedSub, bool requireSigned,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var nc = Client.Connection;
        var inactivity = options?.InactivityTimeout ?? Client.Options.InactivityTimeout;
        var maxWait = options?.MaxWait ?? Client.Options.PromptMaxWait;
        var includeAcks = options?.IncludeAcks ?? false;
        var subject = PromptSubject;

        string? senderHeader = null;
        if (Client.Identity is { } identity)
        {
            var plan = await identity.PlanAsync(signedSub, requireSigned, cancellationToken).ConfigureAwait(false);
            if (plan is not null)
            {
                CheckSize(payload.Length, options, plan.WireBytes); // exact re-check with the real header size
                senderHeader = SenderHeader.Serialize(await plan.BuildAsync(payload, null, cancellationToken).ConfigureAwait(false));
            }
        }

        var inbox = nc.NewInbox();

        // NATS.Net v3 defaults subscription channels to DropNewest; a prompt stream must never lose chunks.
        var subOpts = new NatsSubOpts
        {
            ChannelOpts = new NatsSubChannelOpts { FullMode = BoundedChannelFullMode.Wait, Capacity = 1024 },
        };
        await using var sub = await nc.SubscribeCoreAsync<ReadOnlyMemory<byte>>(inbox, opts: subOpts, cancellationToken: cancellationToken)
            .ConfigureAwait(false);

        NatsHeaders? headers = null;
        if (options?.Headers is { Count: > 0 } extra)
        {
            headers = new NatsHeaders();
            foreach (var (k, v) in extra) headers[k] = v;
        }
        if (senderHeader is not null)
        {
            headers ??= new NatsHeaders();
            headers[SenderHeader.HeaderName] = senderHeader;
        }
        await nc.PublishAsync(subject, payload, headers, replyTo: inbox, cancellationToken: cancellationToken).ConfigureAwait(false);

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(maxWait);

        while (true)
        {
            var msg = await ReadNextAsync(sub, inactivity, maxWait, deadline, cancellationToken).ConfigureAwait(false);
            if (msg.HasNoResponders) throw new NoRespondersException(subject);
            if (TryGetServiceError(msg.Headers, msg.Data, out var error)) throw error;
            if (msg.Data.IsEmpty) yield break; // §6.5 terminator

            AgentChunk? chunk;
            try
            {
                chunk = AgentChunkCodec.Decode(msg.Data.Span, (replySubject, bytes, ct) => PublishReplyAsync(nc, replySubject, bytes, ct));
            }
            catch (AgentProtocolException ex)
            {
                Client.Logger.LogDebug("dropping malformed chunk: {Reason}", ex.Message);
                continue;
            }
            if (chunk is null) continue; // §6.6 unknown type
            if (chunk is AgentStatusChunk { IsAck: true } && !includeAcks) continue;
            yield return chunk;
        }
    }

    internal static async ValueTask PublishReplyAsync(INatsConnection nc, string replySubject, ReadOnlyMemory<byte> bytes, CancellationToken ct)
    {
        await nc.PublishAsync(replySubject, bytes, cancellationToken: ct).ConfigureAwait(false);
        await nc.PingAsync(ct).ConfigureAwait(false);
    }

    private static async ValueTask<NatsMsg<ReadOnlyMemory<byte>>> ReadNextAsync(INatsSub<ReadOnlyMemory<byte>> sub, TimeSpan inactivity,
        TimeSpan maxWait, CancellationTokenSource deadline, CancellationToken userToken)
    {
        using var idle = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token);
        idle.CancelAfter(inactivity);
        try
        {
            while (await sub.Msgs.WaitToReadAsync(idle.Token).ConfigureAwait(false))
            {
                if (sub.Msgs.TryRead(out var msg)) return msg;
            }
        }
        catch (OperationCanceledException) when (!userToken.IsCancellationRequested)
        {
            if (deadline.IsCancellationRequested) throw new StreamMaxWaitExceededException(maxWait);
            throw new StreamStalledException(inactivity);
        }
        userToken.ThrowIfCancellationRequested();
        throw new AgentException("prompt subscription closed before the terminator arrived");
    }

    internal static bool TryGetServiceError(NatsHeaders? headers, ReadOnlyMemory<byte> body, out AgentServiceException error)
    {
        error = null!;
        if (headers is null || !headers.TryGetValue(AgentProtocol.ErrorCodeHeader, out var codeValues)) return false;
        var code = int.TryParse(codeValues.ToString(), out var c) ? c : 500;
        var description = headers.TryGetValue(AgentProtocol.ErrorHeader, out var d) ? d.ToString() : "";
        error = new AgentServiceException(code, description, body.ToArray());
        return true;
    }
}
