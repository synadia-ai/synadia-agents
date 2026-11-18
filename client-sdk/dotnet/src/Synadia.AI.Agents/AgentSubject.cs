using System.Text.RegularExpressions;

namespace Synadia.AI.Agents;

/// <summary>
/// The v0.3 subject address of one agent instance: <c>agents.{verb}.{agent}.{owner}.{name}</c> (spec §2).
/// </summary>
public sealed partial record AgentSubject
{
    private AgentSubject(string agent, string owner, string name)
    {
        Agent = agent;
        Owner = owner;
        Name = name;
    }

    /// <summary>The harness identifier (3rd token), e.g. <c>claude-code</c>.</summary>
    public string Agent { get; }

    /// <summary>Operator / account (4th token).</summary>
    public string Owner { get; }

    /// <summary>Instance / session name (5th token).</summary>
    public string Name { get; }

    /// <summary><c>agents.prompt.{agent}.{owner}.{name}</c>.</summary>
    public string Prompt => $"agents.prompt.{Agent}.{Owner}.{Name}";

    /// <summary><c>agents.hb.{agent}.{owner}.{name}</c>.</summary>
    public string Heartbeat => $"agents.hb.{Agent}.{Owner}.{Name}";

    /// <summary><c>agents.status.{agent}.{owner}.{name}</c>.</summary>
    public string Status => $"agents.status.{Agent}.{Owner}.{Name}";

    /// <summary>Compact <c>agent/owner/name</c> rendering.</summary>
    public override string ToString() => $"{Agent}/{Owner}/{Name}";

    /// <summary>Create a subject, validating each token against the MUST rules of spec §2.</summary>
    /// <exception cref="InvalidSubjectTokenException">A token is invalid.</exception>
    public static AgentSubject Create(string agent, string owner, string name)
    {
        ValidateToken(agent, nameof(agent));
        ValidateToken(owner, nameof(owner));
        ValidateToken(name, nameof(name));
        return new AgentSubject(agent, owner, name);
    }

    /// <summary>
    /// Parse a full subject (<c>agents.&lt;verb&gt;.&lt;agent&gt;.&lt;owner&gt;.&lt;name&gt;</c>).
    /// </summary>
    public static bool TryParse(string? subject, out AgentSubject? result, out string? verb)
    {
        result = null;
        verb = null;
        if (subject is null) return false;
        var parts = subject.Split('.');
        if (parts.Length != 5 || parts[0] != "agents") return false;
        for (var i = 2; i < 5; i++)
        {
            if (!IsValidToken(parts[i])) return false;
        }
        verb = parts[1];
        result = new AgentSubject(parts[2], parts[3], parts[4]);
        return true;
    }

    /// <summary>True when <paramref name="token"/> satisfies the spec §2 MUST rules.</summary>
    public static bool IsValidToken(string? token)
    {
        if (string.IsNullOrEmpty(token)) return false;
        if (token[0] == '$') return false;
        foreach (var c in token)
        {
            if (c is '.' or '*' or '>' or '\0' || char.IsWhiteSpace(c)) return false;
        }
        return true;
    }

    /// <summary>True when <paramref name="token"/> matches the RECOMMENDED form <c>^[a-z0-9_-]{1,63}$</c>.</summary>
    public static bool IsRecommendedToken(string? token) => token is not null && RecommendedToken().IsMatch(token);

    /// <summary>Throw <see cref="InvalidSubjectTokenException"/> unless <paramref name="token"/> is valid.</summary>
    public static void ValidateToken(string? token, string field)
    {
        if (string.IsNullOrEmpty(token)) throw new InvalidSubjectTokenException(field, token, "must be non-empty");
        if (token[0] == '$') throw new InvalidSubjectTokenException(field, token, "must not start with '$'");
        foreach (var c in token)
        {
            if (c is '.' or '*' or '>' or '\0' || char.IsWhiteSpace(c))
            {
                throw new InvalidSubjectTokenException(field, token, "must not contain whitespace, '.', '*', '>' or NUL");
            }
        }
    }

    [GeneratedRegex(@"^[a-z0-9_-]{1,63}\z")]
    private static partial Regex RecommendedToken();
}
