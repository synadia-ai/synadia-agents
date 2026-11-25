using System.Text.Json;
using Microsoft.Extensions.AI;

namespace Synadia.AI.Agents.Service;

/// <summary>Options for <see cref="ChatClientServeExtensions.ServeChatClient"/>.</summary>
public sealed class ChatClientServeOptions
{
    /// <summary>Optional system instructions prepended to every model call (not stored in history).</summary>
    public string? Instructions { get; init; }

    /// <summary>Base <see cref="ChatOptions"/> (tools, model id, temperature, ...). Cloned per model call.</summary>
    public ChatOptions? ChatOptions { get; init; }

    /// <summary>
    /// Selects the conversation a prompt belongs to. Default: the caller's <see cref="PromptContext.SessionId"/> (sent by
    /// <c>AsIChatClient()</c> when <see cref="ChatOptions.ConversationId"/> is set), otherwise <c>""</c>, so the whole agent
    /// address is one conversation (the protocol's model of a stateful agent). Return e.g. a sender identity to split it
    /// further. Session ids are not access control: anyone who knows an id can continue that conversation. To bind
    /// conversations to a verified caller, combine the id with the sender identity here, e.g.
    /// <c>ctx =&gt; ctx.Sender is VerifiedSender v ? $"{v.Id}/{ctx.SessionId}" : ctx.SessionId ?? ""</c>.
    /// </summary>
    public Func<PromptContext, string>? ConversationKey { get; init; }

    /// <summary>
    /// Keep conversation state across prompts (default true). If the chat client returns a
    /// <see cref="ChatResponseUpdate.ConversationId"/> (a stateful service), only that id is kept per conversation: later
    /// prompts send just the new messages with <see cref="ChatOptions.ConversationId"/> set, and the service keeps the
    /// history. Otherwise the SDK keeps the messages in memory, bounded by <see cref="MaxHistoryMessages"/>. Either way
    /// the state is lost when the process restarts. False makes every prompt stateless.
    /// </summary>
    public bool KeepHistory { get; init; } = true;

    /// <summary>
    /// Upper bound on in-memory history messages per conversation (default 100) when the chat client is stateless. Oldest
    /// turns are dropped first. Not used once the client returns a <see cref="ChatResponseUpdate.ConversationId"/>.
    /// </summary>
    public int MaxHistoryMessages { get; init; } = 100;

    /// <summary>
    /// Upper bound on conversations kept in memory (default 1000). Callers choose the conversation key (the
    /// <c>session_id</c> extra), so without a bound any caller could grow memory without limit. When a new conversation
    /// would exceed it, the least recently used idle conversation is forgotten; a conversation with a prompt in flight
    /// is never evicted.
    /// </summary>
    public int MaxConversations { get; init; } = 1000;

    /// <summary>Forward <see cref="TextReasoningContent"/> as <c>status</c> chunks (default false).</summary>
    public bool IncludeReasoning { get; init; }

    /// <summary>
    /// How long to wait for the caller to answer a query this host asks: a relayed <see cref="AgentQueryContent"/>, and
    /// tool approvals unless <see cref="ToolApprovalOptions.Timeout"/> is set. Default: the service's query timeout.
    /// </summary>
    public TimeSpan? QueryTimeout { get; init; }

    /// <summary>Maximum tool-approval round trips within one prompt (default 8). Exceeding it fails the prompt.</summary>
    public int MaxInputRounds { get; init; } = 8;

    /// <summary>How tool approvals are asked and parsed (see <see cref="PromptStream.AskApprovalAsync"/>).</summary>
    public ToolApprovalOptions? Approval { get; init; }

    /// <summary>
    /// Let the model delegate to other agents on the network: the tools of <see cref="Tools.AgentTools"/> are added to
    /// every model call, and each prompt runs in its own call scope (<see cref="Tools.AgentTools.RunInPromptScopeAsync{T}"/>),
    /// so calls the model starts end with the prompt and the agent that sent the prompt cannot be prompted back. The
    /// chat client must invoke functions itself (e.g. <c>.UseFunctionInvocation()</c>); the helper is not disposed here.
    /// </summary>
    public Tools.AgentTools? AgentTools { get; init; }
}

/// <summary>Host any <see cref="IChatClient"/> as a protocol agent.</summary>
public static class ChatClientServeExtensions
{
    /// <summary>
    /// Serve <paramref name="chatClient"/> on this service. Each prompt becomes a user <see cref="ChatMessage"/>
    /// (<see cref="PromptContext.ToChatMessage"/>), the model's streaming updates are written with
    /// <see cref="PromptStream.WriteAsync(ChatResponseUpdate, bool, CancellationToken)"/> (text/data → <c>response</c>,
    /// <see cref="AgentStatusContent"/> or <c>AdditionalProperties["synadia.status"]</c> → <c>status</c>), and every
    /// <see cref="ToolApprovalRequestContent"/> (e.g. from a <see cref="ApprovalRequiredAIFunction"/> behind a
    /// <c>FunctionInvokingChatClient</c>) is turned into a yes/no <c>query</c> (§7) with
    /// <see cref="PromptStream.AskApprovalAsync"/>; the answer is fed back as a <see cref="ToolApprovalResponseContent"/>
    /// and the model is re-invoked. An <see cref="AgentQueryContent"/> streamed by the client (for example a remote agent
    /// behind <c>Agent.AsIChatClient()</c>) is relayed to this prompt's caller and answered in-stream, so
    /// <c>ServeChatClient(remote.AsIChatClient())</c> works as a proxy. Prompts on the same conversation are serialized.
    /// </summary>
    /// <remarks>
    /// A .NET-only convenience over <see cref="AgentService.OnPrompt"/>: it adds no wire feature, and callers see an
    /// ordinary protocol agent.
    /// </remarks>
    /// <returns>The same service, for chaining. Call <see cref="AgentService.StartAsync"/> afterwards.</returns>
    public static AgentService ServeChatClient(this AgentService service, IChatClient chatClient, ChatClientServeOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(service);
        ArgumentNullException.ThrowIfNull(chatClient);
        var host = new ChatClientHost(chatClient, options ?? new ChatClientServeOptions());
        return service.OnPrompt(host.HandleAsync);
    }

    private sealed class Conversation
    {
        public readonly SemaphoreSlim Gate = new(1, 1);
        public readonly List<ChatMessage> History = [];

        // Set once the chat client returns a ConversationId; History is then empty.
        public string? ServiceId;

        // Guarded by ChatClientHost._lock: prompts holding or waiting for Gate, and the LRU stamp.
        public int Users;
        public long LastUsed;
    }

    private sealed class ChatClientHost(IChatClient client, ChatClientServeOptions options)
    {
        private readonly Dictionary<string, Conversation> _conversations = new(StringComparer.Ordinal);
        private readonly object _lock = new();
        private long _clock;

        private readonly IList<AITool>? _agentTools = options.AgentTools?.AsAITools();

        private readonly ToolApprovalOptions _approval = options.Approval is { Timeout: not null } a
            ? a
            : new ToolApprovalOptions { Prompt = options.Approval?.Prompt, Parser = options.Approval?.Parser, Timeout = options.QueryTimeout };

        public Task HandleAsync(PromptContext context, PromptStream stream, CancellationToken cancellationToken)
            => options.AgentTools is { } tools
                ? tools.RunInPromptScopeAsync(() => HandleCoreAsync(context, stream, cancellationToken), CallerOf(context))
                : HandleCoreAsync(context, stream, cancellationToken);

        private static string? CallerOf(PromptContext context)
            => context.Sender is Synadia.AI.Agents.Identity.VerifiedSender verified ? verified.Id.ToString() : null;

        private ChatOptions? ChatOptionsForCall()
        {
            var chatOptions = options.ChatOptions?.Clone();
            if (_agentTools is null) return chatOptions;
            chatOptions ??= new ChatOptions();
            chatOptions.Tools = [.. chatOptions.Tools ?? [], .. _agentTools];
            return chatOptions;
        }

        private async Task HandleCoreAsync(PromptContext context, PromptStream stream, CancellationToken cancellationToken)
        {
            var key = options.ConversationKey?.Invoke(context) ?? context.SessionId ?? "";
            var conversation = Acquire(key);
            try
            {
                await conversation.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                Release(conversation);
                throw;
            }
            try
            {
                var turn = new List<ChatMessage> { context.ToChatMessage() };
                // With a service-side conversation id, only messages the service has not seen yet are sent.
                var id = options.KeepHistory ? conversation.ServiceId : null;
                var seen = 0;
                for (var round = 0; ; round++)
                {
                    var chatOptions = ChatOptionsForCall();
                    var messages = new List<ChatMessage>();
                    if (id is not null)
                    {
                        chatOptions ??= new ChatOptions();
                        chatOptions.ConversationId = id;
                        if (string.IsNullOrEmpty(chatOptions.Instructions)) chatOptions.Instructions = options.Instructions;
                        messages.AddRange(turn.Skip(seen));
                    }
                    else
                    {
                        if (!string.IsNullOrEmpty(options.Instructions)) messages.Add(new ChatMessage(ChatRole.System, options.Instructions));
                        if (options.KeepHistory) messages.AddRange(conversation.History);
                        messages.AddRange(turn);
                    }

                    var updates = new List<ChatResponseUpdate>();
                    var approvals = new List<ToolApprovalRequestContent>();
                    string? returnedId = null;
                    await foreach (var update in client.GetStreamingResponseAsync(messages, chatOptions, cancellationToken)
                        .ConfigureAwait(false))
                    {
                        returnedId = update.ConversationId ?? returnedId;
                        approvals.AddRange(update.Contents.OfType<ToolApprovalRequestContent>());
                        await stream.WriteAsync(update, options.IncludeReasoning, cancellationToken).ConfigureAwait(false);
                        var queries = update.Contents.OfType<AgentQueryContent>().ToList();
                        foreach (var query in queries)
                        {
                            await RelayAsync(query, stream, cancellationToken).ConfigureAwait(false);
                        }
                        updates.Add(queries.Count == 0 ? update : WithoutQueries(update));
                    }
                    turn.AddRange(updates.ToChatResponse().Messages);
                    seen = turn.Count;
                    if (returnedId is not null && options.KeepHistory) id = returnedId;

                    if (approvals.Count == 0) break;
                    if (round >= options.MaxInputRounds)
                    {
                        throw new RequestRejectedException(500, $"exceeded {options.MaxInputRounds} tool-approval rounds");
                    }
                    var answers = new List<AIContent>(approvals.Count);
                    foreach (var request in approvals)
                    {
                        answers.Add(await stream.AskApprovalAsync(request, _approval, cancellationToken).ConfigureAwait(false));
                    }
                    turn.Add(new ChatMessage(ChatRole.User, answers));
                }

                if (!options.KeepHistory) return;
                if (id is not null)
                {
                    // The service holds the history; keep only its newest id.
                    conversation.ServiceId = id;
                    conversation.History.Clear();
                }
                else
                {
                    conversation.History.AddRange(turn);
                    Trim(conversation.History, options.MaxHistoryMessages);
                }
            }
            finally
            {
                conversation.Gate.Release();
                Release(conversation);
            }
        }

        // Marks the conversation in use (so it is never evicted while a prompt holds or awaits its Gate) and evicts the
        // least recently used idle conversations beyond MaxConversations.
        private Conversation Acquire(string key)
        {
            lock (_lock)
            {
                if (!_conversations.TryGetValue(key, out var conversation))
                {
                    conversation = new Conversation();
                    _conversations[key] = conversation;
                    EvictIdle(Math.Max(1, options.MaxConversations));
                }
                conversation.Users++;
                conversation.LastUsed = ++_clock;
                return conversation;
            }
        }

        private void Release(Conversation conversation)
        {
            lock (_lock)
            {
                conversation.Users--;
                conversation.LastUsed = ++_clock;
            }
        }

        private void EvictIdle(int max)
        {
            while (_conversations.Count > max)
            {
                string? oldest = null;
                var stamp = long.MaxValue;
                foreach (var (key, candidate) in _conversations)
                {
                    // The just-added conversation has Users == 0 and LastUsed == 0, but it is about to be used.
                    if (candidate.Users == 0 && candidate.LastUsed != 0 && candidate.LastUsed < stamp)
                    {
                        oldest = key;
                        stamp = candidate.LastUsed;
                    }
                }
                if (oldest is null) return; // all busy: go over the bound briefly rather than drop live state
                _conversations.Remove(oldest);
            }
        }

        // The inner stream is blocked until the query is answered, so relay it to our caller now and reply in-stream.
        private async Task RelayAsync(AgentQueryContent query, PromptStream stream, CancellationToken cancellationToken)
        {
            if (query.Replied) return;
            PromptEnvelope reply;
            try
            {
                reply = await stream.AskAsync(query.Prompt, query.Attachments, options.QueryTimeout, cancellationToken).ConfigureAwait(false);
            }
            catch (AgentQueryTimeoutException)
            {
                throw new RequestRejectedException(504, $"no answer to relayed query \"{query.Prompt}\"");
            }
            await query.ReplyAsync(reply, cancellationToken).ConfigureAwait(false);
        }

        // Live query objects hold the remote reply subject; keep them out of history.
        private static ChatResponseUpdate WithoutQueries(ChatResponseUpdate update)
        {
            var clone = update.Clone();
            clone.Contents = [.. update.Contents.Where(c => c is not AgentQueryContent)];
            return clone;
        }

        private static void Trim(List<ChatMessage> history, int max)
        {
            if (max <= 0)
            {
                history.Clear();
                return;
            }
            if (history.Count <= max) return;
            var drop = history.Count - max;
            // Never start history mid-turn (e.g. with an orphaned tool result): advance to the next user prompt.
            while (drop < history.Count && !(history[drop].Role == ChatRole.User && history[drop].Contents.OfType<TextContent>().Any()))
            {
                drop++;
            }
            history.RemoveRange(0, drop);
        }
    }
}
