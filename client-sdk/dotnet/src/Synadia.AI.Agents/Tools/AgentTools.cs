using System.Text.Json.Nodes;
using Microsoft.Extensions.AI;

namespace Synadia.AI.Agents.Tools;

/// <summary>What <see cref="AgentToolsOptions.OnSettled"/> is told besides the call's result.</summary>
/// <param name="Awaited">Whether a tool call was waiting for this call when it settled (its result reached the model already).</param>
public sealed record AgentCallSettledInfo(bool Awaited);

/// <summary>Options for <see cref="AgentTools"/>. Defaults follow <c>docs/agent-tools.md</c>.</summary>
public sealed class AgentToolsOptions
{
    /// <summary>The tools offered, by name (see <see cref="AgentToolNames"/>). Null offers all six.</summary>
    public IEnumerable<string>? Tools { get; init; }

    /// <summary>This agent's own prompt subject; it is hidden from discovery and refused as a target (loop guard).</summary>
    public string? SelfAddress { get; init; }

    /// <summary>The longest one call may run (default 10 minutes).</summary>
    public TimeSpan MaxWait { get; init; } = AgentProtocol.DefaultPromptMaxWait;

    /// <summary>The longest one <c>wait_agent</c> waits (default <see cref="MaxWait"/>).</summary>
    public TimeSpan? MaxWaitAgent { get; init; }

    /// <summary>Inactivity timeout per call; null uses the client's default (60 s).</summary>
    public TimeSpan? InactivityTimeout { get; init; }

    /// <summary>The most calls tracked per scope (default 256); the oldest finished one is dropped first.</summary>
    public int MaxCalls { get; init; } = 256;

    /// <summary>Directories the model may send files from (the staging directory always is one).</summary>
    public IReadOnlyList<string> AttachmentRoots { get; init; } = [];

    /// <summary>Where returned files are saved (one subdirectory per call). Null creates a private temp directory, removed on dispose.</summary>
    public string? StagingDirectory { get; init; }

    /// <summary>The most decoded bytes saved per call (default 64 MiB).</summary>
    public long MaxSavedBytesPerCall { get; init; } = AttachmentSaver.DefaultMaxTotalBytes;

    /// <summary>Called when a call outside any served prompt settles, with its result.</summary>
    public Func<JsonObject, AgentCallSettledInfo, ValueTask>? OnSettled { get; init; }

    /// <summary>Extensions that add fields to results and may rewrite or refuse prompts.</summary>
    public IReadOnlyList<AgentToolsExtension> Extensions { get; init; } = [];
}

/// <summary>What <see cref="AgentToolsExtension.BeforePromptAsync"/> sees.</summary>
public sealed record AgentToolsPromptContext(string Address, string Prompt, IReadOnlyList<string> Attachments, Agent Target,
    string CallId, string? Label, string? ToolCallId, string? Caller);

/// <summary>What <see cref="AgentToolsExtension.BeforePromptAsync"/> may return.</summary>
public sealed record AgentToolsPromptRewrite
{
    /// <summary>Refuse the prompt with these words.</summary>
    public string? Error { get; init; }
    /// <summary>Send this text instead.</summary>
    public string? Prompt { get; init; }
    /// <summary>Extra fields for the call's results (contract fields are refused).</summary>
    public IReadOnlyDictionary<string, JsonNode?>? Fields { get; init; }
    /// <summary>Extra prompt-envelope fields sent with the prompt (e.g. a sender's context).</summary>
    public IReadOnlyDictionary<string, System.Text.Json.JsonElement>? EnvelopeExtras { get; init; }
}

/// <summary>What <see cref="AgentToolsExtension.AfterReplyAsync"/> sees.</summary>
public sealed record AgentToolsReplyContext(string CallId, string Address, Agent Target, string Kind, string Text, JsonArray Attachments);

/// <summary>
/// An extension point of <see cref="AgentTools"/> (the TS <c>AgentToolsExtension</c>): it may add fields to
/// discovery entries and call results, and rewrite or refuse a prompt. Fields the contract defines are refused.
/// </summary>
public abstract class AgentToolsExtension
{
    /// <summary>Extra fields for one discovery entry.</summary>
    public virtual ValueTask<IReadOnlyDictionary<string, JsonNode?>?> DiscoveryFieldsAsync(Agent agent, CancellationToken cancellationToken)
        => ValueTask.FromResult<IReadOnlyDictionary<string, JsonNode?>?>(null);

    /// <summary>Rewrite or refuse a prompt before it is sent; null leaves it alone.</summary>
    public virtual ValueTask<AgentToolsPromptRewrite?> BeforePromptAsync(AgentToolsPromptContext context, CancellationToken cancellationToken)
        => ValueTask.FromResult<AgentToolsPromptRewrite?>(null);

    /// <summary>Extra fields for a call's reply (<c>kind</c> = <c>reply</c>) or question (<c>question</c>).</summary>
    public virtual ValueTask<IReadOnlyDictionary<string, JsonNode?>?> AfterReplyAsync(AgentToolsReplyContext context, CancellationToken cancellationToken)
        => ValueTask.FromResult<IReadOnlyDictionary<string, JsonNode?>?>(null);
}

/// <summary>
/// The agent tools (<c>docs/agent-tools.md</c>): six tools a model uses to discover agents on NATS, prompt them —
/// one at a time or several at once — answer their questions, and collect their replies. Port of the TypeScript
/// <c>AgentTools</c>. Use <see cref="Definitions"/> + <see cref="ExecuteAsync(string, string?, string?, CancellationToken)"/>
/// with any tool-calling loop, or <see cref="AsAITools"/> with Microsoft.Extensions.AI.
/// </summary>
/// <remarks>
/// A served prompt is a scope: wrap the handler in <see cref="RunInPromptScopeAsync{T}(Func{Task{T}}, string?)"/> and the
/// calls it starts are cancelled, their open questions refused, when it ends. Outside any served prompt the calls share
/// one root scope that lives until <see cref="DisposeAsync"/>. Never throws for something the model got wrong.
/// </remarks>
public sealed class AgentTools : IAsyncDisposable
{
    /// <summary>The answer an open question gets when nobody can answer it any more.</summary>
    public const string QuestionRefusal = "no: the caller stopped waiting for this prompt and cannot answer";

    internal static readonly string[] CallResultFields =
        ["call_id", "state", "label", "reply", "question", "error", "partial_reply", "attachments", "remaining", "call_ids", "open_calls", "open_calls_note"];
    internal static readonly string[] DiscoveryEntryFields =
        ["address", "agent", "owner", "name", "description", "identity", "identity_verified", "requires_signed_prompts", "accepts_attachments", "instances"];

    private readonly AgentsClient _client;
    private readonly HashSet<string> _offered;
    private readonly AgentToolsOptions _options;
    private readonly TimeSpan _maxWaitAgent;
    private readonly IReadOnlyList<string> _attachmentRoots;
    private readonly AsyncLocal<Scope?> _scope = new();
    private readonly Scope _root = new(false, null);
    private readonly HashSet<Scope> _served = [];
    private readonly Dictionary<string, Agent> _known = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private Task<string>? _staging;
    private bool _ownsStaging;
    private long _seq;
    private bool _closed;

    /// <summary>Create the tools over <paramref name="client"/>.</summary>
    /// <exception cref="ArgumentException">The tool set makes no sense (see the contract, section 5).</exception>
    public AgentTools(AgentsClient client, AgentToolsOptions? options = null)
    {
        _client = client ?? throw new ArgumentNullException(nameof(client));
        _options = options ?? new AgentToolsOptions();
        _offered = OfferedTools(_options.Tools);
        if (_options.MaxWait <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(options), "AgentTools: MaxWait must be greater than 0");
        if (_options.MaxCalls <= 0) throw new ArgumentOutOfRangeException(nameof(options), "AgentTools: MaxCalls must be greater than 0");
        if (_options.MaxSavedBytesPerCall < 0) throw new ArgumentOutOfRangeException(nameof(options), "AgentTools: MaxSavedBytesPerCall must be 0 or more");
        _maxWaitAgent = _options.MaxWaitAgent ?? _options.MaxWait;
        if (_maxWaitAgent < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(options), "AgentTools: MaxWaitAgent must be 0 or more");
        _attachmentRoots = _options.AttachmentRoots.Select(Path.GetFullPath).ToArray();
        Definitions = AgentToolDefinitions.Offered(_offered);
    }

    /// <summary>The definitions of the tools offered, in the contract's order.</summary>
    public IReadOnlyList<AgentToolDefinition> Definitions { get; }

    /// <summary>The underlying client.</summary>
    public AgentsClient Client => _client;

    /// <summary>The tools offered as Microsoft.Extensions.AI functions, whose JSON schemas are the contract's text verbatim.</summary>
    public IList<AITool> AsAITools() => Definitions.Select(d => (AITool)new AgentToolFunction(this, d)).ToList();

    /// <summary>Execute one tool call from the model. <paramref name="argumentsJson"/> is the JSON text the model produced (null counts as <c>{}</c>).</summary>
    public Task<JsonObject> ExecuteAsync(string name, string? argumentsJson, string? toolCallId = null, CancellationToken cancellationToken = default)
        => ExecuteAsync(name, argumentsJson is null ? null : JsonValue.Create(argumentsJson), toolCallId, cancellationToken);

    /// <summary>Execute one tool call from the model, with its arguments as a JSON node (an object, or the JSON text).</summary>
    public async Task<JsonObject> ExecuteAsync(string name, JsonNode? arguments, string? toolCallId = null, CancellationToken cancellationToken = default)
    {
        EnsureOpen();
        var scope = _scope.Value ?? _root;
        if (AgentToolNames.IsAgentTool(name) && !_offered.Contains(name))
            return WithOpenCalls(scope, Error($"the tool \"{name}\" is not offered; your tools are {string.Join(", ", OfferedInOrder())}"));
        var result = name switch
        {
            AgentToolNames.DiscoverAgents => await DiscoverAgentsAsync(arguments, cancellationToken).ConfigureAwait(false),
            AgentToolNames.PromptAgent => await PromptAgentAsync(scope, arguments, toolCallId, cancellationToken).ConfigureAwait(false),
            AgentToolNames.WaitAgent => await WaitAgentAsync(scope, arguments, cancellationToken).ConfigureAwait(false),
            AgentToolNames.AnswerAgent => await AnswerAgentAsync(scope, arguments, cancellationToken).ConfigureAwait(false),
            AgentToolNames.CancelAgent => await CancelAgentAsync(scope, arguments).ConfigureAwait(false),
            AgentToolNames.ListAgentCalls => ListAgentCalls(scope),
            _ => Error($"unknown tool \"{name}\""),
        };
        return WithOpenCalls(scope, result);
    }

    /// <summary>
    /// Run <paramref name="handler"/> as the handler of a served prompt: the tool calls it makes share a scope of their
    /// own, and when it ends the calls still open are cancelled and their questions refused. <paramref name="caller"/>
    /// is the verified identity of the agent that sent the prompt; prompting it back is refused (loop guard).
    /// </summary>
    public async Task<T> RunInPromptScopeAsync<T>(Func<Task<T>> handler, string? caller = null)
    {
        ArgumentNullException.ThrowIfNull(handler);
        EnsureOpen();
        var scope = new Scope(true, caller);
        lock (_gate) _served.Add(scope);
        var previous = _scope.Value;
        _scope.Value = scope;
        try
        {
            return await handler().ConfigureAwait(false);
        }
        finally
        {
            _scope.Value = previous;
            lock (_gate) _served.Remove(scope);
            await CloseScopeAsync(scope).ConfigureAwait(false);
        }
    }

    /// <inheritdoc cref="RunInPromptScopeAsync{T}(Func{Task{T}}, string?)"/>
    public Task RunInPromptScopeAsync(Func<Task> handler, string? caller = null)
    {
        ArgumentNullException.ThrowIfNull(handler);
        return RunInPromptScopeAsync(async () => { await handler().ConfigureAwait(false); return true; }, caller);
    }

    /// <summary>Cancel every open call in every scope, and remove the staging directory when this helper created it. Idempotent.</summary>
    public async ValueTask DisposeAsync()
    {
        Scope[] scopes;
        lock (_gate)
        {
            if (_closed) return;
            _closed = true;
            scopes = [_root, .. _served];
        }
        await Task.WhenAll(scopes.Select(CloseScopeAsync)).ConfigureAwait(false);
        if (_ownsStaging && _staging is not null)
        {
            try
            {
                var dir = await _staging.ConfigureAwait(false);
                Directory.Delete(dir, recursive: true);
            }
            catch { /* best effort */ }
        }
    }

    // --- discover_agents ----------------------------------------------------

    private async Task<JsonObject> DiscoverAgentsAsync(JsonNode? args, CancellationToken ct)
    {
        var parsedArgs = AgentToolArgs.Discover(args);
        if (parsedArgs is not DiscoverArgs parsed) return Error(((ArgsError)parsedArgs).Error);
        IReadOnlyList<Agent> found;
        try
        {
            found = await DiscoverAsync(new AgentFilter { Agent = parsed.Agent, Owner = parsed.Owner, Name = parsed.Name }, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return Error($"discovery failed: {ex.Message}");
        }
        var byAddress = new Dictionary<string, (Agent Handle, int Instances)>(StringComparer.Ordinal);
        var order = new List<string>();
        foreach (var handle in found)
        {
            var address = handle.PromptSubject;
            if (address == _options.SelfAddress) continue;
            if (!byAddress.TryGetValue(address, out var seen))
            {
                byAddress[address] = (handle, 1);
                order.Add(address);
            }
            else
            {
                byAddress[address] = (!AgentIdentityView.Verified(seen.Handle) && AgentIdentityView.Verified(handle) ? handle : seen.Handle, seen.Instances + 1);
            }
        }
        var agents = new JsonArray();
        foreach (var address in order)
        {
            var (handle, instances) = byAddress[address];
            var extra = new JsonObject();
            foreach (var extension in _options.Extensions)
                AddFields(extra, await extension.DiscoveryFieldsAsync(handle, ct).ConfigureAwait(false), DiscoveryEntryFields, "a discovery entry");
            var entry = new JsonObject
            {
                ["address"] = address,
                ["agent"] = handle.Info.Agent,
                ["owner"] = handle.Info.Owner,
                ["name"] = handle.Info.Name,
                ["description"] = handle.Info.Description,
                ["identity"] = AgentIdentityView.Identity(handle),
                ["identity_verified"] = AgentIdentityView.Verified(handle),
                ["requires_signed_prompts"] = handle.Info.PromptEndpoint.MinSenderTrust == "signed",
                ["accepts_attachments"] = handle.Info.PromptEndpoint.AttachmentsOk != false,
                ["instances"] = instances,
            };
            foreach (var kv in extra.ToList())
            {
                extra.Remove(kv.Key);
                entry[kv.Key] = kv.Value;
            }
            agents.Add((JsonNode)entry);
        }
        return new JsonObject { ["agents"] = agents };
    }

    private async Task<IReadOnlyList<Agent>> DiscoverAsync(AgentFilter filter, CancellationToken ct)
    {
        var found = await _client.DiscoverAsync(filter, ct).ConfigureAwait(false);
        lock (_gate)
        {
            foreach (var handle in found)
            {
                if (!_known.TryGetValue(handle.PromptSubject, out var known) || AgentIdentityView.Verified(handle) || !AgentIdentityView.Verified(known))
                    _known[handle.PromptSubject] = handle;
            }
        }
        return found;
    }

    private async Task<Agent?> LookupAsync(string address, CancellationToken ct)
    {
        lock (_gate)
            if (_known.TryGetValue(address, out var known)) return known;
        await DiscoverAsync(new AgentFilter(), ct).ConfigureAwait(false);
        lock (_gate) return _known.GetValueOrDefault(address);
    }

    // --- prompt_agent -------------------------------------------------------

    private async Task<JsonObject> PromptAgentAsync(Scope scope, JsonNode? args, string? toolCallId, CancellationToken ct)
    {
        var parsedObj = AgentToolArgs.Prompt(args);
        if (parsedObj is ArgsError argsError) return Error(argsError.Error);
        var parsed = (PromptArgs)parsedObj;
        if (!parsed.Wait && !_offered.Contains(AgentToolNames.WaitAgent))
            return Error("prompt_agent: \"wait\" cannot be false here; the call waits for the reply or a question");
        var address = parsed.Address;
        if (scope.Closed) return Error("the prompt you were answering has ended; no call can start in it");
        if (address == _options.SelfAddress) return Error($"\"{address}\" is your own address; answer the prompt yourself");
        Agent? target;
        try
        {
            target = await LookupAsync(address, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return Error($"could not look up \"{address}\": {ex.Message}");
        }
        if (target is null) return Error(NoAgentAt(address));
        if (scope.Caller is not null && AgentIdentityView.Identity(target) == scope.Caller)
            return Error($"the agent at \"{address}\" sent the prompt you are answering; answer it rather than prompting it back");
        var resolved = await ResolveAttachmentsAsync(parsed.Attachments).ConfigureAwait(false);
        if (resolved is ArgsError attachmentError) return Error(attachmentError.Error);
        var attachments = (IReadOnlyList<string>)resolved;
        if (!Reserve(scope))
        {
            var (collect, stop) = OpenCallActions("some", "their");
            return Error($"all {_options.MaxCalls} tracked calls are still open; {(stop is not null ? $"{collect} or {stop}" : collect)} before you start another");
        }

        var reserved = true;
        try
        {
            var callId = NewCallId();
            var text = parsed.Prompt;
            var fields = new JsonObject();
            var extras = new Dictionary<string, System.Text.Json.JsonElement>(StringComparer.Ordinal);
            foreach (var extension in _options.Extensions)
            {
                var rewrite = await extension.BeforePromptAsync(
                    new AgentToolsPromptContext(address, text, attachments, target, callId, parsed.Label, toolCallId, scope.Caller), ct).ConfigureAwait(false);
                if (rewrite is null) continue;
                if (rewrite.Error is not null) return Error(rewrite.Error);
                if (rewrite.Prompt is not null) text = rewrite.Prompt;
                if (rewrite.EnvelopeExtras is not null)
                    foreach (var kv in rewrite.EnvelopeExtras) extras[kv.Key] = kv.Value;
                AddFields(fields, rewrite.Fields, CallResultFields, "a call's result");
            }
            if (attachments.Count > 0 && target.Info.PromptEndpoint.AttachmentsOk == false)
                return Error($"the prompt was not sent: {new AttachmentsNotSupportedException().Message}");
            PromptEnvelope envelope;
            try
            {
                var files = new List<DataContent>();
                foreach (var path in attachments)
                    files.Add(await PromptEnvelope.AttachmentFromFileAsync(path, ct).ConfigureAwait(false));
                envelope = new PromptEnvelope(text, files, extras.Count > 0 ? extras : null);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                return Error($"the prompt was not sent: {ex.Message}");
            }
            if (scope.Closed) return Error("the prompt you were answering has ended; no call can start in it");

            var call = new Call(callId, scope, address, target, parsed.Label, !parsed.Wait, fields);
            lock (_gate)
            {
                scope.Reserved--;
                reserved = false;
                scope.Calls[callId] = call;
            }
            var promptOptions = new PromptOptions { MaxWait = _options.MaxWait, InactivityTimeout = _options.InactivityTimeout };
            _ = Task.Run(() => ReadAsync(call, envelope, promptOptions));
            if (!parsed.Wait) return CallResult(call);
            return await UntilReadyAsync(call, ct).ConfigureAwait(false);
        }
        finally
        {
            if (reserved) lock (_gate) scope.Reserved--;
        }
    }

    private bool Reserve(Scope scope)
    {
        lock (_gate)
        {
            while (scope.Calls.Count + scope.Reserved >= _options.MaxCalls)
            {
                Call? oldest = null;
                foreach (var call in scope.Calls.Values)
                    if (!call.Open && (oldest is null || call.Seq < oldest.Seq)) oldest = call;
                if (oldest is null) return false;
                scope.Calls.Remove(oldest.Id);
            }
            scope.Reserved++;
            return true;
        }
    }

    private async Task<object> ResolveAttachmentsAsync(IReadOnlyList<string> paths)
    {
        if (paths.Count == 0) return Array.Empty<string>();
        string staging;
        try { staging = await StagingDirAsync().ConfigureAwait(false); }
        catch (Exception ex) { return new ArgsError($"prompt_agent: the staging directory could not be created: {ex.Message}"); }
        var roots = new[] { staging }.Concat(_attachmentRoots).Select(RealPath).ToArray();
        var comparison = OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var output = new List<string>();
        foreach (var path in paths)
        {
            var full = Path.GetFullPath(path);
            if (!File.Exists(full) && !Directory.Exists(full)) return new ArgsError($"prompt_agent: the attachment \"{path}\" does not exist");
            var real = RealPath(full);
            if (!File.Exists(real)) return new ArgsError($"prompt_agent: the attachment \"{path}\" is not a file");
            if (!roots.Any(root => string.Equals(real, root, comparison) || real.StartsWith(WithSeparator(root), comparison)))
                return new ArgsError($"prompt_agent: \"{path}\" is outside the directories you may send files from ({string.Join(", ", roots)})");
            output.Add(real);
        }
        return output;
    }

    /// <summary>The path with every link along it followed.</summary>
    private static string RealPath(string path)
    {
        try
        {
            var full = Path.GetFullPath(path);
            var root = Path.GetPathRoot(full) ?? "";
            var current = root;
            foreach (var part in full[root.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
            {
                current = Path.Combine(current, part);
                FileSystemInfo info = Directory.Exists(current) ? new DirectoryInfo(current) : new FileInfo(current);
                if (info.Exists && info.LinkTarget is not null)
                {
                    var target = info.ResolveLinkTarget(returnFinalTarget: true);
                    if (target is not null) current = target.FullName;
                }
            }
            return current.Length > root.Length ? current.TrimEnd(Path.DirectorySeparatorChar) : current;
        }
        catch
        {
            return Path.GetFullPath(path);
        }
    }

    // --- the call's own task -------------------------------------------------

    private async Task ReadAsync(Call call, PromptEnvelope envelope, PromptOptions options)
    {
        try
        {
            await foreach (var chunk in call.Target.PromptAsync(envelope, options, call.Cancellation.Token).ConfigureAwait(false))
            {
                switch (chunk)
                {
                    case AgentStatusChunk:
                        continue;
                    case AgentResponseChunk response:
                        if (!call.Open) continue;
                        lock (_gate) call.Text.Append(response.Text);
                        if (response.Attachments.Count > 0)
                        {
                            var saved = await SaveAsync(call, response.Attachments).ConfigureAwait(false);
                            lock (_gate) call.ReplyFiles.AddRange(saved);
                        }
                        continue;
                    case AgentQueryChunk query:
                        bool accepted;
                        lock (_gate)
                        {
                            accepted = call.Open;
                            if (accepted) call.Arriving = query;
                        }
                        if (!accepted)
                        {
                            await RefuseAsync(query).ConfigureAwait(false);
                            continue;
                        }
                        var files = query.Attachments.Count > 0 ? await SaveAsync(call, query.Attachments).ConfigureAwait(false) : [];
                        var fields = await AfterReplyAsync(call, "question", query.Prompt, files).ConfigureAwait(false);
                        lock (_gate)
                        {
                            if (!call.Open) continue;
                            call.Arriving = null;
                            call.Questions.Add(new OpenQuestion(query, files, fields));
                            if (call.State == AgentCallState.Running) SetState(call, AgentCallState.InputRequired);
                        }
                        continue;
                }
            }
            if (call.Open)
            {
                string text;
                List<JsonObject> replyFiles;
                lock (_gate)
                {
                    text = call.Text.ToString();
                    replyFiles = [.. call.ReplyFiles];
                }
                var replyFields = await AfterReplyAsync(call, "reply", text, replyFiles).ConfigureAwait(false);
                lock (_gate) call.ReplyFields = replyFields;
                Finish(call, AgentCallState.Completed);
            }
        }
        catch (OperationCanceledException) when (call.Cancellation.IsCancellationRequested)
        {
            // Cancelled: cancel() refused every question already.
        }
        catch (Exception ex)
        {
            if (!call.Open) return;
            var open = ex is StreamMaxWaitExceededException maxWait
                ? Finish(call, AgentCallState.Expired,
                    $"the call ran past its runtime limit of {Duration(maxWait.MaxWait)} and was stopped; the agent may still be working on it")
                : Finish(call, AgentCallState.Failed, Failure(call, ex));
            await Task.WhenAll(open.Select(RefuseAsync)).ConfigureAwait(false);
        }
    }

    private async Task<List<JsonObject>> SaveAsync(Call call, IReadOnlyList<DataContent> attachments)
    {
        IReadOnlyList<SavedAttachment> saved;
        try
        {
            var dir = Path.Combine(await StagingDirAsync().ConfigureAwait(false), call.Id);
            long remaining;
            lock (_gate) remaining = Math.Max(0, _options.MaxSavedBytesPerCall - call.SavedBytes);
            saved = await AttachmentSaver.SaveAsync(attachments, dir, remaining).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            throw new CallFailureException($"a file the agent sent could not be saved: {ex.Message}");
        }
        var files = new List<JsonObject>();
        foreach (var file in saved)
        {
            if (file.Path is not null) lock (_gate) call.SavedBytes += file.SizeBytes;
            var entry = new JsonObject { ["filename"] = file.FileName, ["size_bytes"] = file.SizeBytes, ["path"] = file.Path };
            if (file.SkippedText is { } skipped) entry["skipped"] = skipped;
            files.Add(entry);
        }
        return files;
    }

    private async Task<JsonObject> AfterReplyAsync(Call call, string kind, string text, IReadOnlyList<JsonObject> attachments)
    {
        var fields = new JsonObject();
        try
        {
            foreach (var extension in _options.Extensions)
            {
                var added = await extension.AfterReplyAsync(new AgentToolsReplyContext(call.Id, call.Address, call.Target, kind, text,
                    new JsonArray(attachments.Select(a => (JsonNode)a.DeepClone()).ToArray())), CancellationToken.None).ConfigureAwait(false);
                AddFields(fields, added, CallResultFields, "a call's result");
            }
        }
        catch (ReservedFieldException ex)
        {
            throw new CallFailureException(
                $"an extension of these tools has a bug (it set \"{ex.Field}\" on the {kind}, a field the tools define); the agent at \"{call.Address}\" is not at fault");
        }
        catch (Exception ex)
        {
            throw new CallFailureException($"an extension failed on the {kind}: {ex.Message}");
        }
        return fields;
    }

    private string Failure(Call call, Exception ex) => ex switch
    {
        CallFailureException f => f.Message,
        AgentServiceException s => $"the agent at \"{call.Address}\" answered with an error: {s.Code}{(s.Description.Length > 0 ? " " + s.Description : "")}",
        StreamStalledException st => $"the agent at \"{call.Address}\" sent nothing for {Duration(st.Timeout)}, so the call was given up; the agent may have stopped",
        NoRespondersException => NoAgentAt(call.Address, " any more"),
        ObjectDisposedException => "the client the call ran on was closed",
        _ => ex.Message,
    };

    // --- state ---------------------------------------------------------------

    private void SetState(Call call, AgentCallState state)
    {
        lock (_gate)
        {
            call.State = state;
            if (state == AgentCallState.InputRequired) call.Seq = ++_seq;
            call.Notify();
        }
    }

    /// <summary>The call's final state; the first one wins. Returns the open questions, taken off the call, for the caller to refuse.</summary>
    private List<AgentQueryChunk> Finish(Call call, AgentCallState state, string? error = null)
    {
        List<AgentQueryChunk> open;
        bool awaited;
        lock (_gate)
        {
            if (!call.Open) return [];
            awaited = call.Awaited;
            call.State = state;
            call.Error = error;
            call.EndedAt = DateTimeOffset.UtcNow;
            call.Seq = ++_seq;
            open = call.Questions.Select(q => q.Event).ToList();
            call.Questions.Clear();
            if (call.Arriving is not null) open.Add(call.Arriving);
            call.Arriving = null;
            call.Notify();
        }
        if (call.Scope == _root && _options.OnSettled is { } report)
        {
            var result = CallResult(call);
            _ = Task.Run(async () =>
            {
                try { await report(result, new AgentCallSettledInfo(awaited)).ConfigureAwait(false); }
                catch { /* the host's callback failing must not fail the call */ }
            });
        }
        return open;
    }

    private async Task CancelAsync(Call call)
    {
        if (!call.Open) return;
        var questions = Finish(call, AgentCallState.Cancelled);
        try { call.Cancellation.Cancel(); } catch (ObjectDisposedException) { }
        await Task.WhenAll(questions.Select(RefuseAsync)).ConfigureAwait(false);
    }

    private async Task CloseScopeAsync(Scope scope)
    {
        Call[] calls;
        lock (_gate)
        {
            scope.Closed = true;
            calls = [.. scope.Calls.Values];
        }
        await Task.WhenAll(calls.Select(CancelAsync)).ConfigureAwait(false);
    }

    private async Task<JsonObject> UntilReadyAsync(Call call, CancellationToken ct)
    {
        while (call.State == AgentCallState.Running)
        {
            if (ct.IsCancellationRequested)
            {
                await CancelAsync(call).ConfigureAwait(false);
                break;
            }
            await NextChangeAsync([call], null, ct).ConfigureAwait(false);
        }
        return CallResult(call);
    }

    private async Task NextChangeAsync(IReadOnlyList<Call> calls, DateTimeOffset? deadline, CancellationToken ct)
    {
        Task[] changes;
        lock (_gate)
        {
            // Re-check under the lock: a change between the caller's check and Watch() would otherwise be lost.
            if (calls.Any(c => c.State != AgentCallState.Running)) return;
            changes = calls.Select(c => c.Watch()).ToArray();
        }
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        try
        {
            var waits = new List<Task>(changes);
            var delay = deadline is { } d ? d - DateTimeOffset.UtcNow : Timeout.InfiniteTimeSpan;
            if (delay != Timeout.InfiniteTimeSpan && delay < TimeSpan.Zero) delay = TimeSpan.Zero;
            waits.Add(Task.Delay(delay, stop.Token));
            await Task.WhenAny(waits).ConfigureAwait(false);
        }
        finally
        {
            stop.Cancel();
            lock (_gate) foreach (var call in calls) call.Unwatch();
        }
    }

    // --- wait_agent, answer_agent, cancel_agent, list_agent_calls -----------

    private async Task<JsonObject> WaitAgentAsync(Scope scope, JsonNode? args, CancellationToken ct)
    {
        var parsedObj = AgentToolArgs.Wait(args);
        if (parsedObj is ArgsError argsError) return Error(argsError.Error);
        var parsed = (WaitArgs)parsedObj;
        var callsObj = Calls(scope, parsed.CallIds);
        if (callsObj is ArgsError callsError) return Error(callsError.Error);
        var calls = (List<Call>)callsObj;
        var wait = parsed.TimeoutMs is { } ms ? TimeSpan.FromMilliseconds(Math.Min(ms, _maxWaitAgent.TotalMilliseconds)) : _maxWaitAgent;
        var deadline = DateTimeOffset.UtcNow + wait;
        while (true)
        {
            Call? first = null;
            lock (_gate)
            {
                foreach (var call in calls)
                    if (call.State != AgentCallState.Running && (first is null || call.Seq < first.Seq)) first = call;
            }
            if (first is not null)
            {
                var result = CallResult(first);
                result["remaining"] = new JsonArray(calls.Where(c => c != first && c.Open).Select(c => (JsonNode)c.Id).ToArray());
                return result;
            }
            if (DateTimeOffset.UtcNow >= deadline || ct.IsCancellationRequested)
                return new JsonObject { ["state"] = "running", ["call_ids"] = new JsonArray(calls.Select(c => (JsonNode)c.Id).ToArray()) };
            await NextChangeAsync(calls, deadline, ct).ConfigureAwait(false);
        }
    }

    private async Task<JsonObject> AnswerAgentAsync(Scope scope, JsonNode? args, CancellationToken ct)
    {
        var parsedObj = AgentToolArgs.Answer(args);
        if (parsedObj is ArgsError argsError) return Error(argsError.Error);
        var parsed = (AnswerArgs)parsedObj;
        if (parsed.Wait == false && !_offered.Contains(AgentToolNames.WaitAgent))
            return Error("answer_agent: \"wait\" cannot be false here; the call waits for the reply or the next question");
        Call? call;
        OpenQuestion? question;
        lock (_gate)
        {
            call = scope.Calls.GetValueOrDefault(parsed.CallId);
            if (call is null) return Error(UnknownCalls([parsed.CallId]));
            question = call.Questions.FirstOrDefault();
            if (call.State != AgentCallState.InputRequired || question is null)
                return Error($"call \"{call.Id}\" has no open question: it is {StateText(call.State)}"
                    + (call.Open ? "" : IfOffered(AgentToolNames.WaitAgent, "; wait_agent returns its result")));
            // Taken off before the answer goes out, so a concurrent tool call never sees a question being answered.
            call.Questions.RemoveAt(0);
            SetState(call, call.Questions.Count > 0 ? AgentCallState.InputRequired : AgentCallState.Running);
        }
        try
        {
            await question.Event.ReplyAsync(parsed.Answer, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            lock (_gate)
            {
                if (call.Open)
                {
                    call.Questions.Insert(0, question);
                    SetState(call, AgentCallState.InputRequired);
                }
            }
            return Error($"the answer could not be sent: {ex.Message}");
        }
        if (!(parsed.Wait ?? !call.Detached)) return CallResult(call);
        return await UntilReadyAsync(call, ct).ConfigureAwait(false);
    }

    private async Task<JsonObject> CancelAgentAsync(Scope scope, JsonNode? args)
    {
        var parsedObj = AgentToolArgs.Cancel(args);
        if (parsedObj is ArgsError argsError) return Error(argsError.Error);
        var parsed = (CallIdsArgs)parsedObj;
        var results = new JsonArray();
        foreach (var id in parsed.CallIds)
        {
            Call? call;
            lock (_gate) call = scope.Calls.GetValueOrDefault(id);
            if (call is null)
            {
                results.Add((JsonNode)new JsonObject { ["call_id"] = id, ["error"] = UnknownCalls([id]) });
                continue;
            }
            await CancelAsync(call).ConfigureAwait(false);
            results.Add((JsonNode)CallResult(call));
        }
        return new JsonObject { ["calls"] = results };
    }

    private JsonObject ListAgentCalls(Scope scope)
    {
        var calls = new JsonArray();
        lock (_gate)
        {
            foreach (var call in scope.Calls.Values.OrderBy(c => c.Order))
            {
                var entry = new JsonObject { ["call_id"] = call.Id };
                if (call.Label is not null) entry["label"] = call.Label;
                entry["address"] = call.Address;
                entry["state"] = StateText(call.State);
                entry["started_at"] = Iso(call.StartedAt);
                if (call.EndedAt is { } ended) entry["ended_at"] = Iso(ended);
                calls.Add((JsonNode)entry);
            }
        }
        return new JsonObject { ["calls"] = calls };
    }

    private object Calls(Scope scope, IReadOnlyList<string> ids)
    {
        lock (_gate)
        {
            var unknown = ids.Where(id => !scope.Calls.ContainsKey(id)).ToList();
            if (unknown.Count > 0) return new ArgsError(UnknownCalls(unknown));
            return ids.Select(id => scope.Calls[id]).ToList();
        }
    }

    // --- words -----------------------------------------------------------------

    private string IfOffered(string tool, string words) => _offered.Contains(tool) ? words : "";

    private string UnknownCalls(IReadOnlyList<string> ids)
        => string.Join(", ", ids.Select(id => $"\"{id}\"")) + ": no such call in your calls"
            + IfOffered(AgentToolNames.ListAgentCalls, "; list_agent_calls shows them");

    private string NoAgentAt(string address, string still = "")
        => $"no agent answers at \"{address}\"{still}" + IfOffered(AgentToolNames.DiscoverAgents, "; call discover_agents for the current list");

    private (string Collect, string? Stop) OpenCallActions(string them, string their)
        => (_offered.Contains(AgentToolNames.WaitAgent) ? $"collect {them} with wait_agent" : $"answer {their} questions with answer_agent",
            _offered.Contains(AgentToolNames.CancelAgent) ? $"stop {them} with cancel_agent" : null);

    // --- results ---------------------------------------------------------------

    private JsonObject CallResult(Call call)
    {
        lock (_gate)
        {
            var result = (JsonObject)call.Fields.DeepClone();
            result["call_id"] = call.Id;
            result["state"] = StateText(call.State);
            if (call.Label is not null) result["label"] = call.Label;
            var text = call.Text.ToString();
            void Partial() { if (text.Length > 0) result["partial_reply"] = text; }
            void Files() { if (call.ReplyFiles.Count > 0) result["attachments"] = new JsonArray(call.ReplyFiles.Select(f => (JsonNode)f.DeepClone()).ToArray()); }
            switch (call.State)
            {
                case AgentCallState.InputRequired:
                    var question = call.Questions[0];
                    Merge(result, question.Fields);
                    result["question"] = question.Event.Prompt;
                    if (question.Files.Count > 0) result["attachments"] = new JsonArray(question.Files.Select(f => (JsonNode)f.DeepClone()).ToArray());
                    break;
                case AgentCallState.Completed:
                    Merge(result, call.ReplyFields);
                    result["reply"] = text;
                    Files();
                    break;
                case AgentCallState.Cancelled:
                    Partial();
                    Files();
                    break;
                case AgentCallState.Failed:
                case AgentCallState.Expired:
                    result["error"] = call.Error ?? "the call failed";
                    Partial();
                    Files();
                    break;
            }
            return result;
        }
    }

    private JsonObject WithOpenCalls(Scope scope, JsonObject result)
    {
        int open;
        lock (_gate) open = scope.Calls.Values.Count(c => c.Open);
        if (open == 0) return result;
        var counted = open == 1 ? "1 call you started is" : $"{open} calls you started are";
        var (collect, stop) = OpenCallActions(open == 1 ? "it" : "them", open == 1 ? "its" : "their");
        result["open_calls"] = open;
        result["open_calls_note"] = scope.Served
            ? $"{counted} still open. Calls end with the prompt you are answering: {collect} before you answer."
            : $"{counted} still open: {(stop is not null ? $"{collect}, or {stop}" : collect)}.";
        return result;
    }

    // --- files -------------------------------------------------------------------

    private Task<string> StagingDirAsync()
    {
        lock (_gate)
        {
            if (_staging is { IsFaulted: false }) return _staging;
            _staging = Task.Run(() =>
            {
                if (_options.StagingDirectory is { } configured)
                {
                    var dir = Path.GetFullPath(configured);
                    AttachmentSaver.CreatePrivateDirectory(dir);
                    return dir;
                }
                var temp = Path.Combine(Path.GetTempPath(), "agent-tools-" + Guid.NewGuid().ToString("N")[..12]);
                AttachmentSaver.CreatePrivateDirectory(temp);
                _ownsStaging = true;
                return temp;
            });
            return _staging;
        }
    }

    private void EnsureOpen()
    {
        if (_closed) throw new ObjectDisposedException(nameof(AgentTools), "AgentTools: the helper is closed");
    }

    // --- helpers -------------------------------------------------------------------

    private IEnumerable<string> OfferedInOrder() => AgentToolNames.All.Where(_offered.Contains);

    private static JsonObject Error(string message) => new() { ["error"] = message };

    private static void Merge(JsonObject into, JsonObject from)
    {
        foreach (var kv in from) into[kv.Key] = kv.Value?.DeepClone();
    }

    private static void AddFields(JsonObject into, IReadOnlyDictionary<string, JsonNode?>? added, string[] reserved, string where)
    {
        if (added is null) return;
        foreach (var kv in added)
        {
            if (reserved.Contains(kv.Key)) throw new ReservedFieldException(kv.Key, where);
            into[kv.Key] = kv.Value?.DeepClone();
        }
    }

    private static async Task RefuseAsync(AgentQueryChunk question)
    {
        try { await question.ReplyAsync(QuestionRefusal).ConfigureAwait(false); }
        catch { /* already answered, or the connection is gone */ }
    }

    private static string NewCallId() => "call_" + Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(6)).ToLowerInvariant();

    internal static string StateText(AgentCallState state) => state switch
    {
        AgentCallState.Running => "running",
        AgentCallState.InputRequired => "input_required",
        AgentCallState.Completed => "completed",
        AgentCallState.Failed => "failed",
        AgentCallState.Cancelled => "cancelled",
        AgentCallState.Expired => "expired",
        _ => state.ToString(),
    };

    private static string Iso(DateTimeOffset time) => time.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);

    internal static string Duration(TimeSpan span)
    {
        var ms = (long)span.TotalMilliseconds;
        if (ms >= 60_000 && ms % 60_000 == 0) return ms / 60_000 == 1 ? "1 minute" : $"{ms / 60_000} minutes";
        if (ms >= 1_000 && ms % 1_000 == 0) return ms / 1_000 == 1 ? "1 second" : $"{ms / 1_000} seconds";
        return $"{ms} ms";
    }

    private static string WithSeparator(string dir) => dir.EndsWith(Path.DirectorySeparatorChar) ? dir : dir + Path.DirectorySeparatorChar;

    private static HashSet<string> OfferedTools(IEnumerable<string>? tools)
    {
        if (tools is null) return new HashSet<string>(AgentToolNames.All, StringComparer.Ordinal);
        var list = tools.ToList();
        foreach (var name in list)
            if (!AgentToolNames.IsAgentTool(name))
                throw new ArgumentException($"AgentTools: tools names \"{name}\", which is not one of {string.Join(", ", AgentToolNames.All)}", nameof(tools));
        var offered = new HashSet<string>(AgentToolNames.All.Where(list.Contains), StringComparer.Ordinal);
        if (offered.Count == 0)
            throw new ArgumentException("AgentTools: tools names no tool; a role that must not delegate needs no AgentTools", nameof(tools));
        var orphans = AgentToolNames.All.Where(n => offered.Contains(n) && n != AgentToolNames.DiscoverAgents).ToList();
        if (!offered.Contains(AgentToolNames.PromptAgent) && orphans.Count > 0)
            throw new ArgumentException(
                $"AgentTools: tools offers {string.Join(", ", orphans)} without prompt_agent, which starts the calls {(orphans.Count == 1 ? "it works on" : "they work on")}", nameof(tools));
        if (offered.Contains(AgentToolNames.PromptAgent) && !offered.Contains(AgentToolNames.AnswerAgent))
            throw new ArgumentException(
                "AgentTools: tools offers prompt_agent without answer_agent, so a question the prompted agent asks would reach a model with no way to answer it, and the asking agent would wait out its timeout", nameof(tools));
        return offered;
    }

    // --- types -------------------------------------------------------------------

    private sealed record OpenQuestion(AgentQueryChunk Event, IReadOnlyList<JsonObject> Files, JsonObject Fields);

    private sealed class Scope(bool served, string? caller)
    {
        public Dictionary<string, Call> Calls { get; } = new(StringComparer.Ordinal);
        public int Reserved { get; set; }
        public bool Closed { get; set; }
        public bool Served { get; } = served;
        public string? Caller { get; } = caller;
    }

    private sealed class Call(string id, Scope scope, string address, Agent target, string? label, bool detached, JsonObject fields)
    {
        private static long s_order;
        private TaskCompletionSource _changed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _waiters;

        public string Id { get; } = id;
        public Scope Scope { get; } = scope;
        public string Address { get; } = address;
        public Agent Target { get; } = target;
        public string? Label { get; } = label;
        public bool Detached { get; } = detached;
        public JsonObject Fields { get; } = fields;
        public long Order { get; } = Interlocked.Increment(ref s_order);
        public CancellationTokenSource Cancellation { get; } = new();
        public AgentCallState State { get; set; } = AgentCallState.Running;
        public long Seq { get; set; }
        public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;
        public DateTimeOffset? EndedAt { get; set; }
        public System.Text.StringBuilder Text { get; } = new();
        public List<JsonObject> ReplyFiles { get; } = [];
        public List<OpenQuestion> Questions { get; } = [];
        public AgentQueryChunk? Arriving { get; set; }
        public string? Error { get; set; }
        public JsonObject ReplyFields { get; set; } = new();
        public long SavedBytes { get; set; }

        public bool Open => State is AgentCallState.Running or AgentCallState.InputRequired;
        public bool Awaited => _waiters > 0;

        public Task Watch()
        {
            _waiters++;
            return _changed.Task;
        }

        public void Unwatch() => _waiters = Math.Max(0, _waiters - 1);

        public void Notify()
        {
            var old = _changed;
            _changed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            old.TrySetResult();
        }
    }

    private sealed class CallFailureException(string message) : Exception(message);

    private sealed class ReservedFieldException(string field, string where)
        : Exception($"AgentTools: an extension may not set \"{field}\" on {where}")
    {
        public string Field { get; } = field;
    }
}

/// <summary>The state of one call (contract section 3).</summary>
public enum AgentCallState
{
    /// <summary>The agent is working on it.</summary>
    Running,
    /// <summary>A question waits for <c>answer_agent</c>.</summary>
    InputRequired,
    /// <summary>The reply came.</summary>
    Completed,
    /// <summary>It failed; see <c>error</c>.</summary>
    Failed,
    /// <summary>Stopped by <c>cancel_agent</c>, or its scope ended.</summary>
    Cancelled,
    /// <summary>It ran past its runtime limit.</summary>
    Expired,
}
