using System.Text.Json;
using Microsoft.Extensions.AI;

namespace Synadia.AI.Agents.Service;

/// <summary>How <see cref="PromptStream.AskApprovalAsync"/> turns a tool approval into a yes/no query (§7).</summary>
public sealed class ToolApprovalOptions
{
    private static readonly HashSet<string> Yes = new(StringComparer.OrdinalIgnoreCase) { "y", "yes", "approve", "approved", "allow", "ok", "true" };
    private static readonly JsonSerializerOptions Compact = new(AIJsonUtilities.DefaultOptions) { WriteIndented = false };

    /// <summary>Builds the query text. Default: <see cref="DefaultPrompt"/>.</summary>
    public Func<ToolApprovalRequestContent, string>? Prompt { get; init; }

    /// <summary>Interprets the caller's reply; <c>true</c> approves. Default: <see cref="DefaultParser"/>.</summary>
    public Func<PromptEnvelope, bool>? Parser { get; init; }

    /// <summary>How long to wait for the reply. A timeout denies the call. Default: the service's query timeout.</summary>
    public TimeSpan? Timeout { get; init; }

    /// <summary><c>Allow tool 'name' with arguments {...}? (yes/no)</c>.</summary>
    public static string DefaultPrompt(ToolApprovalRequestContent request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.ToolCall is FunctionCallContent call)
        {
            var args = call.Arguments is { Count: > 0 }
                ? JsonSerializer.Serialize(call.Arguments, Compact.GetTypeInfo(typeof(IDictionary<string, object?>)))
                : "{}";
            return $"Allow tool '{call.Name}' with arguments {args}? (yes/no)";
        }
        return $"Allow tool call {request.ToolCall}? (yes/no)";
    }

    /// <summary>
    /// Approves on <c>y</c>, <c>yes</c>, <c>approve</c>, <c>approved</c>, <c>allow</c>, <c>ok</c> or <c>true</c>
    /// (case-insensitive, trailing <c>.</c>/<c>!</c> ignored). Anything else denies.
    /// </summary>
    public static bool DefaultParser(PromptEnvelope reply)
    {
        ArgumentNullException.ThrowIfNull(reply);
        return Yes.Contains(reply.Prompt.Trim().TrimEnd('.', '!'));
    }
}
