using System.Runtime.CompilerServices;
using System.Text;
using Microsoft.Extensions.AI;

namespace Synadia.AI.Agents;

/// <summary>Options for <see cref="Agent.AsIChatClient"/>.</summary>
public sealed class AgentChatClientOptions
{
    /// <summary>Per-prompt transport options (timeouts, headers).</summary>
    public PromptOptions? PromptOptions { get; set; }

    /// <summary>
    /// Answers mid-stream queries automatically. Return the answer text (or <c>null</c> after replying yourself via
    /// <see cref="AgentQueryContent.ReplyAsync(string, CancellationToken)"/>). When unset, streaming surfaces the
    /// <see cref="AgentQueryContent"/> for the consumer to answer, and <see cref="IChatClient.GetResponseAsync"/> throws.
    /// </summary>
    public Func<AgentQueryContent, CancellationToken, ValueTask<string?>>? QueryHandler { get; set; }

    /// <summary>Surface non-ack status chunks as <see cref="AgentStatusContent"/> updates (default true).</summary>
    public bool IncludeStatus { get; set; } = true;
}

/// <summary>
/// <see cref="IChatClient"/> over one remote agent. The agent owns its conversation state (the protocol is
/// stateful per agent address), so only the <b>newest user message</b> is sent: its text becomes the prompt and its
/// <see cref="DataContent"/> items become attachments. <see cref="ChatResponseUpdate.ConversationId"/> is the agent's
/// prompt subject, or <see cref="ChatOptions.ConversationId"/> when the caller set one; a caller-set id is sent as the
/// <see cref="PromptEnvelope.SessionIdExtra"/> extra so the host can keep a separate conversation per id. Additional
/// <see cref="ChatOptions.AdditionalProperties"/> are sent as envelope extras (§5.3).
/// </summary>
internal sealed class AgentChatClient : IChatClient
{
    private readonly Agent _agent;
    private readonly AgentChatClientOptions _options;
    private readonly ChatClientMetadata _metadata;

    public AgentChatClient(Agent agent, AgentChatClientOptions? options)
    {
        _agent = agent;
        _options = options ?? new AgentChatClientOptions();
        _metadata = new ChatClientMetadata("synadia-agents", null, $"{agent.Info.Agent}/{agent.Info.Owner}/{agent.Info.Name}");
    }

    public async Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var updates = new List<ChatResponseUpdate>();
        await foreach (var update in GetStreamingResponseAsync(messages, options, cancellationToken).ConfigureAwait(false))
        {
            if (update.Contents.OfType<AgentQueryContent>().FirstOrDefault() is { } q)
            {
                throw new AgentException($"agent asked a query (\"{q.Prompt}\") but no QueryHandler was configured; use streaming to answer it");
            }
            updates.Add(update);
        }
        return updates.ToChatResponse();
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var envelope = BuildEnvelope(messages, options, _agent.PromptSubject);
        var responseId = Guid.NewGuid().ToString("N");
        var conversationId = options?.ConversationId ?? _agent.PromptSubject;
        var created = DateTimeOffset.UtcNow;

        ChatResponseUpdate New(AIContent? content, object raw)
            => new(ChatRole.Assistant, content is null ? [] : [content])
            {
                ResponseId = responseId,
                MessageId = responseId,
                ConversationId = conversationId,
                ModelId = _metadata.DefaultModelId,
                CreatedAt = created,
                RawRepresentation = raw,
            };

        await foreach (var chunk in _agent.PromptAsync(envelope, _options.PromptOptions, cancellationToken).ConfigureAwait(false))
        {
            switch (chunk)
            {
                case AgentResponseChunk r:
                {
                    var update = New(null, r);
                    if (r.Text.Length > 0) update.Contents.Add(new TextContent(r.Text) { RawRepresentation = r });
                    foreach (var a in r.Attachments) update.Contents.Add(a);
                    if (update.Contents.Count > 0) yield return update;
                    break;
                }
                case AgentStatusChunk s when _options.IncludeStatus && !s.IsAck:
                {
                    var update = New(new AgentStatusContent(s.Status) { RawRepresentation = s }, s);
                    update.AdditionalProperties = new() { [AgentStatusContent.AdditionalPropertyKey] = s.Status };
                    yield return update;
                    break;
                }
                case AgentStatusChunk s when s.IsAck && _options.PromptOptions?.IncludeAcks == true:
                    yield return New(new AgentStatusContent(s.Status) { RawRepresentation = s }, s);
                    break;
                case AgentQueryChunk q:
                {
                    var content = new AgentQueryContent(q);
                    if (_options.QueryHandler is { } handler)
                    {
                        var answer = await handler(content, cancellationToken).ConfigureAwait(false);
                        if (answer is not null && !q.Replied) await q.ReplyAsync(answer, cancellationToken).ConfigureAwait(false);
                    }
                    else
                    {
                        yield return New(content, q);
                    }
                    break;
                }
            }
        }
        var final = New(null, "terminator");
        final.FinishReason = ChatFinishReason.Stop;
        yield return final;
    }

    public object? GetService(Type serviceType, object? serviceKey = null)
    {
        ArgumentNullException.ThrowIfNull(serviceType);
        if (serviceKey is not null) return null;
        if (serviceType == typeof(ChatClientMetadata)) return _metadata;
        if (serviceType.IsInstanceOfType(_agent)) return _agent;
        if (serviceType.IsInstanceOfType(this)) return this;
        return null;
    }

    public void Dispose()
    {
    }

    internal static PromptEnvelope BuildEnvelope(IEnumerable<ChatMessage> messages, ChatOptions? options, string? promptSubject = null)
    {
        ArgumentNullException.ThrowIfNull(messages);
        ChatMessage? last = null;
        foreach (var m in messages)
        {
            if (m.Role == ChatRole.User) last = m;
        }
        if (last is null) throw new ArgumentException("at least one user message is required", nameof(messages));

        var text = new StringBuilder();
        var attachments = new List<DataContent>();
        foreach (var c in last.Contents)
        {
            switch (c)
            {
                case TextContent t:
                    text.Append(t.Text);
                    break;
                case DataContent d:
                    attachments.Add(d);
                    break;
            }
        }

        Dictionary<string, System.Text.Json.JsonElement>? extras = null;
        if (options?.AdditionalProperties is { Count: > 0 } props)
        {
            foreach (var (k, v) in props)
            {
                if (v is null) continue;
                var element = v is System.Text.Json.JsonElement je
                    ? je
                    : System.Text.Json.JsonSerializer.SerializeToElement(v, AIJsonUtilities.DefaultOptions.GetTypeInfo(v.GetType()));
                (extras ??= new())[k] = element;
            }
        }
        // The prompt subject is what we echo back by default, so it names no separate conversation.
        if (options?.ConversationId is { Length: > 0 } conversationId && conversationId != promptSubject)
        {
            (extras ??= new())[PromptEnvelope.SessionIdExtra] = System.Text.Json.JsonSerializer.SerializeToElement(
                conversationId, AIJsonUtilities.DefaultOptions.GetTypeInfo(typeof(string)));
        }
        return new PromptEnvelope(text.ToString(), attachments, extras);
    }
}
