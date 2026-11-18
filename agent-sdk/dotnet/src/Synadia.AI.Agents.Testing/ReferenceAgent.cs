using System.Globalization;
using NATS.Client.Core;
using Synadia.AI.Agents.Service;

namespace Synadia.AI.Agents.Testing;

/// <summary>Options of the <see cref="ReferenceAgent"/>.</summary>
public sealed class ReferenceAgentOptions
{
    /// <summary>§2 agent token. Default <c>demo-agent</c>.</summary>
    public string Agent { get; init; } = "demo-agent";

    /// <summary>§2 owner token. Default <c>$USER</c>/<c>$USERNAME</c>, else <c>anon</c>.</summary>
    public string Owner { get; init; } = DefaultOwner();

    /// <summary>§2 name token. Default <c>example</c>.</summary>
    public string Name { get; init; } = "example";

    /// <summary>Prefix of the echo. Default <c>"echo: "</c> (matches the Python reference agent).</summary>
    public string Prefix { get; init; } = "echo: ";

    /// <summary>Service description.</summary>
    public string Description { get; init; } = "dotnet reference agent";

    /// <summary>Heartbeat cadence. Default 5 s (matches the TS/Python reference runners).</summary>
    public TimeSpan HeartbeatInterval { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>Whether inbound attachments are echoed back on the response chunk. Default true.</summary>
    public bool EchoAttachments { get; init; } = true;

    /// <summary>Advertised <c>attachments_ok</c>.</summary>
    public bool AttachmentsOk { get; init; } = true;

    /// <summary>Optional <c>max_payload</c> override.</summary>
    public long? MaxPayload { get; init; }

    /// <summary>Timeout of the <c>ask …</c> query.</summary>
    public TimeSpan QueryTimeout { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary>The OS user name, normalized into a valid subject token, or <c>anon</c>.</summary>
    public static string DefaultOwner()
    {
        var user = Environment.GetEnvironmentVariable("USER") ?? Environment.GetEnvironmentVariable("USERNAME");
        return !string.IsNullOrEmpty(user) && AgentSubject.IsValidToken(user) ? user : "anon";
    }
}

/// <summary>
/// A spec-compliant echo agent — the .NET counterpart of <c>agent-sdk/python/examples/_reference_agent.py</c> and the
/// TypeScript <c>ReferenceAgent</c>. Behaviour per prompt:
/// <list type="bullet">
/// <item><c>ask &lt;question&gt;</c> — asks the caller <c>&lt;question&gt;</c> mid-stream (§7) and replies
/// <c>"you answered: &lt;answer&gt;"</c>.</item>
/// <item><c>fail &lt;code&gt; &lt;description&gt;</c> — refuses with that §9 error frame.</item>
/// <item><c>slow &lt;ms&gt;</c> — sends a <c>working</c> status, waits, then echoes.</item>
/// <item>anything else — <c>"{prefix}{prompt}"</c>, plus a recap of prior turns and the attachment names, exactly
/// like the Python reference agent; attachments are echoed back when <see cref="ReferenceAgentOptions.EchoAttachments"/>.</item>
/// </list>
/// </summary>
public sealed class ReferenceAgent : IAsyncDisposable
{
    private const int HistoryCap = 20;
    private readonly ReferenceAgentOptions _options;
    private readonly List<string> _history = [];
    private readonly object _gate = new();

    /// <summary>Create the agent (not started).</summary>
    public ReferenceAgent(INatsConnection connection, ReferenceAgentOptions? options = null)
    {
        _options = options ?? new ReferenceAgentOptions();
        Service = new AgentService(connection, new AgentServiceOptions
        {
            Agent = _options.Agent,
            Owner = _options.Owner,
            Name = _options.Name,
            Description = _options.Description,
            HeartbeatInterval = _options.HeartbeatInterval,
            AttachmentsOk = _options.AttachmentsOk,
            MaxPayload = _options.MaxPayload,
        }).OnPrompt(HandleAsync);
    }

    /// <summary>The underlying service.</summary>
    public AgentService Service { get; }

    /// <summary>Register and start heartbeating.</summary>
    public Task StartAsync(CancellationToken cancellationToken = default) => Service.StartAsync(cancellationToken);

    /// <summary>Deregister.</summary>
    public Task StopAsync(CancellationToken cancellationToken = default) => Service.StopAsync(cancellationToken);

    /// <inheritdoc />
    public ValueTask DisposeAsync() => Service.DisposeAsync();

    private async Task HandleAsync(PromptContext context, PromptStream stream, CancellationToken cancellationToken)
    {
        var prompt = context.Prompt;
        if (prompt.StartsWith("ask ", StringComparison.Ordinal))
        {
            var answer = await stream.AskAsync(prompt[4..], timeout: _options.QueryTimeout, cancellationToken: cancellationToken)
                .ConfigureAwait(false);
            await stream.WriteAsync($"you answered: {answer.Prompt}", cancellationToken: cancellationToken).ConfigureAwait(false);
            return;
        }
        if (prompt.StartsWith("fail ", StringComparison.Ordinal))
        {
            var parts = prompt.Split(' ', 3);
            var code = parts.Length > 1 && int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var c) ? c : 500;
            throw new RequestRejectedException(code is >= 400 and <= 599 ? code : 500, parts.Length > 2 ? parts[2] : "refused");
        }
        if (prompt.StartsWith("slow ", StringComparison.Ordinal)
            && int.TryParse(prompt[5..], NumberStyles.Integer, CultureInfo.InvariantCulture, out var ms))
        {
            await stream.WriteStatusAsync("working", cancellationToken).ConfigureAwait(false);
            await Task.Delay(ms, cancellationToken).ConfigureAwait(false);
        }

        string[] prior;
        int turn;
        lock (_gate)
        {
            prior = [.. _history];
            _history.Add(prompt);
            if (_history.Count > HistoryCap) _history.RemoveAt(0);
            turn = _history.Count;
        }
        var echoed = _options.Prefix + prompt;
        if (prior.Length > 0)
        {
            echoed += $" (turn {turn}; you previously said: {string.Join("; ", prior.Select(t => $"\"{t}\""))})";
        }
        var attachments = context.Attachments;
        if (attachments.Count > 0)
        {
            var names = string.Join(", ", attachments.Select((a, i) => PromptEnvelope.FileNameOf(a, i)));
            echoed += $" [received {attachments.Count} attachment(s): {names}]";
        }
        await stream.WriteAsync(echoed, _options.EchoAttachments ? attachments : null, cancellationToken).ConfigureAwait(false);
    }
}
