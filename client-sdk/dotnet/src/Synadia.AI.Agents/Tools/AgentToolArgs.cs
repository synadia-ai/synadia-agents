using System.Text.Json;
using System.Text.Json.Nodes;

namespace Synadia.AI.Agents.Tools;

// Parsing a tool call's arguments as the model produced them. A model gets its arguments wrong
// now and then, so every problem comes back as words it can act on, never as a throw. Properties
// the definitions do not name are ignored. Mirrors client-sdk/typescript/src/tools/args.ts.

internal sealed record ArgsError(string Error);

internal sealed record DiscoverArgs(string? Agent, string? Owner, string? Name);

internal sealed record PromptArgs(string Address, string Prompt, IReadOnlyList<string> Attachments, string? Label, bool Wait);

internal sealed record WaitArgs(IReadOnlyList<string> CallIds, long? TimeoutMs);

internal sealed record AnswerArgs(string CallId, string Answer, bool? Wait);

internal sealed record CallIdsArgs(IReadOnlyList<string> CallIds);

internal static class AgentToolArgs
{
    /// <summary>The arguments as an object: null, empty text and JSON null count as <c>{}</c>.</summary>
    public static object Object(string tool, JsonNode? args)
    {
        if (args is null) return new JsonObject();
        if (args is JsonValue v && v.TryGetValue<string>(out var text))
        {
            if (text.Length == 0) return new JsonObject();
            try { args = JsonNode.Parse(text); }
            catch (JsonException) { return new ArgsError($"{tool}: the arguments are not valid JSON"); }
            if (args is null) return new JsonObject();
        }
        return args is JsonObject o ? o : new ArgsError($"{tool}: the arguments must be a JSON object");
    }

    public static object Discover(JsonNode? args)
    {
        if (Object(AgentToolNames.DiscoverAgents, args) is not JsonObject f) return Object(AgentToolNames.DiscoverAgents, args);
        var values = new string?[3];
        string[] keys = ["agent", "owner", "name"];
        for (var i = 0; i < keys.Length; i++)
        {
            if (!f.TryGetPropertyValue(keys[i], out var node)) continue;
            if (!IsNonEmptyString(node, out var s))
                return new ArgsError($"discover_agents: \"{keys[i]}\" must be a non-empty string when given");
            values[i] = s;
        }
        return new DiscoverArgs(values[0], values[1], values[2]);
    }

    public static object Prompt(JsonNode? args)
    {
        if (Object(AgentToolNames.PromptAgent, args) is not JsonObject f) return Object(AgentToolNames.PromptAgent, args);
        if (!IsNonEmptyString(f["address"], out var address))
            return new ArgsError("prompt_agent: \"address\" is required, as discover_agents returned it");
        if (!IsNonEmptyString(f["prompt"], out var prompt))
            return new ArgsError("prompt_agent: \"prompt\" is required and must not be empty");
        var attachments = new List<string>();
        if (f.TryGetPropertyValue("attachments", out var att))
        {
            if (att is not JsonArray arr) return new ArgsError("prompt_agent: \"attachments\" must be a list of file paths");
            foreach (var item in arr)
            {
                if (!IsNonEmptyString(item, out var p)) return new ArgsError("prompt_agent: \"attachments\" must be a list of file paths");
                attachments.Add(p);
            }
        }
        string? label = null;
        if (f.TryGetPropertyValue("label", out var l))
        {
            if (!IsNonEmptyString(l, out var ls)) return new ArgsError("prompt_agent: \"label\" must be a non-empty string when given");
            label = ls;
        }
        var wait = true;
        if (f.TryGetPropertyValue("wait", out var w))
        {
            if (!IsBool(w, out wait)) return new ArgsError("prompt_agent: \"wait\" must be true or false");
        }
        return new PromptArgs(address, prompt, attachments, label, wait);
    }

    public static object Wait(JsonNode? args)
    {
        if (Object(AgentToolNames.WaitAgent, args) is not JsonObject f) return Object(AgentToolNames.WaitAgent, args);
        var ids = CallIds(AgentToolNames.WaitAgent, f["call_ids"]);
        if (ids is ArgsError e) return e;
        if (!f.TryGetPropertyValue("timeout_ms", out var t)) return new WaitArgs((IReadOnlyList<string>)ids, null);
        // Re-parse so CLR-backed values (JsonValue.Create(10_000)) read like wire JSON.
        if (t is JsonValue && t.GetValueKind() == JsonValueKind.Number) t = JsonNode.Parse(t.ToJsonString());
        if (t is not JsonValue tv || tv.GetValueKind() != JsonValueKind.Number || !tv.TryGetValue<double>(out var ms)
            || ms < 0 || Math.Floor(ms) != ms || double.IsInfinity(ms))
            return new ArgsError("wait_agent: \"timeout_ms\" must be a whole number of milliseconds, 0 or more");
        return new WaitArgs((IReadOnlyList<string>)ids, (long)Math.Min(ms, long.MaxValue));
    }

    public static object Answer(JsonNode? args)
    {
        if (Object(AgentToolNames.AnswerAgent, args) is not JsonObject f) return Object(AgentToolNames.AnswerAgent, args);
        if (!IsNonEmptyString(f["call_id"], out var callId))
            return new ArgsError("answer_agent: \"call_id\" is required, as it came with the question");
        if (!IsNonEmptyString(f["answer"], out var answer))
            return new ArgsError("answer_agent: \"answer\" is required and must not be empty");
        bool? wait = null;
        if (f.TryGetPropertyValue("wait", out var w))
        {
            if (!IsBool(w, out var wb)) return new ArgsError("answer_agent: \"wait\" must be true or false");
            wait = wb;
        }
        return new AnswerArgs(callId, answer, wait);
    }

    public static object Cancel(JsonNode? args)
    {
        if (Object(AgentToolNames.CancelAgent, args) is not JsonObject f) return Object(AgentToolNames.CancelAgent, args);
        var ids = CallIds(AgentToolNames.CancelAgent, f["call_ids"]);
        return ids is ArgsError e ? e : new CallIdsArgs((IReadOnlyList<string>)ids);
    }

    /// <summary><c>call_ids</c>: a non-empty list of non-empty strings, duplicates removed, order kept.</summary>
    private static object CallIds(string tool, JsonNode? value)
    {
        var error = new ArgsError($"{tool}: \"call_ids\" must be a non-empty list of call_id strings");
        if (value is not JsonArray arr || arr.Count == 0) return error;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var ids = new List<string>();
        foreach (var item in arr)
        {
            if (!IsNonEmptyString(item, out var id)) return error;
            if (seen.Add(id)) ids.Add(id);
        }
        return ids;
    }

    private static bool IsNonEmptyString(JsonNode? node, out string value)
    {
        value = "";
        if (node is JsonValue v && v.GetValueKind() == JsonValueKind.String && v.TryGetValue<string>(out var s) && s.Length > 0)
        {
            value = s;
            return true;
        }
        return false;
    }

    private static bool IsBool(JsonNode? node, out bool value)
    {
        value = false;
        if (node is JsonValue v && v.GetValueKind() is JsonValueKind.True or JsonValueKind.False)
        {
            value = v.GetValueKind() == JsonValueKind.True;
            return true;
        }
        return false;
    }
}
