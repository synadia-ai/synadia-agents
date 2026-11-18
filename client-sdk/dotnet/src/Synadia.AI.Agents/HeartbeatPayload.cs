using System.Globalization;
using System.Text.Json;

namespace Synadia.AI.Agents;

/// <summary>A declared endpoint on a heartbeat: its subject and §2.1 metadata.</summary>
public sealed record HeartbeatEndpoint(string Subject, IReadOnlyDictionary<string, string> Metadata);

/// <summary>
/// The §8.3 heartbeat payload, published on <c>agents.hb.{agent}.{owner}.{name}</c> and returned by the
/// §8.7 <c>status</c> endpoint. Unknown fields are preserved in <see cref="Extras"/>.
/// </summary>
public sealed record HeartbeatPayload
{
    private static readonly HashSet<string> KnownFields = ["agent", "owner", "session", "instance_id", "ts", "interval_s"];

    /// <summary>Keys a heartbeat-extras provider may not supply.</summary>
    public static IReadOnlySet<string> ReservedKeys { get; } =
        new HashSet<string>(["agent", "owner", "session", "instance_id", "ts", "interval_s", "protocol_version", "endpoints"]);

    /// <summary><c>agent</c>.</summary>
    public required string Agent { get; init; }

    /// <summary><c>owner</c>.</summary>
    public required string Owner { get; init; }

    /// <summary><c>session</c>, when present.</summary>
    public string? Session { get; init; }

    /// <summary><c>instance_id</c> — equals the service id from <c>$SRV.INFO</c>.</summary>
    public required string InstanceId { get; init; }

    /// <summary><c>ts</c> — ISO-8601 UTC timestamp as sent.</summary>
    public required string Timestamp { get; init; }

    /// <summary><c>interval_s</c> — the agent's heartbeat cadence in seconds.</summary>
    public required double IntervalSeconds { get; init; }

    /// <summary><c>protocol_version</c>, when declared.</summary>
    public string? ProtocolVersion { get; init; }

    /// <summary>Declared endpoints (the host declares <c>prompt</c>), when present.</summary>
    public IReadOnlyDictionary<string, HeartbeatEndpoint>? Endpoints { get; init; }

    /// <summary>Additional fields, preserved verbatim.</summary>
    public IReadOnlyDictionary<string, JsonElement> Extras { get; init; } = new Dictionary<string, JsonElement>();

    /// <summary>Format a timestamp the way JavaScript's <c>Date.toISOString()</c> does.</summary>
    public static string FormatTimestamp(DateTimeOffset ts)
        => ts.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    /// <summary>Encode to the wire shape (snake_case, field order matching the TypeScript host).</summary>
    public byte[] Encode() => WireJson.Write(w =>
    {
        w.WriteStartObject();
        w.WriteString("agent", Agent);
        w.WriteString("owner", Owner);
        w.WriteString("instance_id", InstanceId);
        w.WriteString("ts", Timestamp);
        w.WritePropertyName("interval_s");
        if (IntervalSeconds == Math.Floor(IntervalSeconds) && Math.Abs(IntervalSeconds) < long.MaxValue)
        {
            w.WriteNumberValue((long)IntervalSeconds);
        }
        else
        {
            w.WriteNumberValue(IntervalSeconds);
        }
        foreach (var (k, v) in Extras)
        {
            if (ReservedKeys.Contains(k)) continue;
            w.WritePropertyName(k);
            v.WriteTo(w);
        }
        if (Session is not null) w.WriteString("session", Session);
        if (ProtocolVersion is not null) w.WriteString("protocol_version", ProtocolVersion);
        if (Endpoints is not null)
        {
            w.WriteStartObject("endpoints");
            foreach (var (name, ep) in Endpoints)
            {
                w.WriteStartObject(name);
                w.WriteString("subject", ep.Subject);
                w.WriteStartObject("metadata");
                foreach (var (mk, mv) in ep.Metadata) w.WriteString(mk, mv);
                w.WriteEndObject();
                w.WriteEndObject();
            }
            w.WriteEndObject();
        }
        w.WriteEndObject();
    });

    /// <summary>Decode a heartbeat body; <c>null</c> for malformed input (callers ignore it, §6.6).</summary>
    public static HeartbeatPayload? TryDecode(ReadOnlySpan<byte> body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body.ToArray());
            return TryDecode(doc.RootElement);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Decode a parsed heartbeat; <c>null</c> for malformed input.</summary>
    public static HeartbeatPayload? TryDecode(JsonElement o)
    {
        if (o.ValueKind != JsonValueKind.Object) return null;
        if (!Str(o, "agent", out var agent) || !Str(o, "owner", out var owner) ||
            !Str(o, "instance_id", out var instanceId) || !Str(o, "ts", out var ts))
        {
            return null;
        }
        if (!o.TryGetProperty("interval_s", out var iv) || iv.ValueKind != JsonValueKind.Number ||
            !iv.TryGetDouble(out var interval) || !double.IsFinite(interval) || interval <= 0)
        {
            return null;
        }
        string? pv = Str(o, "protocol_version", out var pvs) && pvs.Length > 0 ? pvs : null;
        var endpoints = o.TryGetProperty("endpoints", out var eps) ? DecodeEndpoints(eps) : null;
        string? session = Str(o, "session", out var ss) && ss.Length > 0 ? ss : null;

        var extras = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var p in o.EnumerateObject())
        {
            if (KnownFields.Contains(p.Name)) continue;
            if (p.Name == "protocol_version" && pv is not null) continue;
            if (p.Name == "endpoints" && endpoints is not null) continue;
            extras[p.Name] = p.Value.Clone();
        }

        return new HeartbeatPayload
        {
            Agent = agent,
            Owner = owner,
            InstanceId = instanceId,
            Timestamp = ts,
            IntervalSeconds = interval,
            Session = session,
            ProtocolVersion = pv,
            Endpoints = endpoints,
            Extras = extras,
        };
    }

    private static Dictionary<string, HeartbeatEndpoint>? DecodeEndpoints(JsonElement v)
    {
        if (v.ValueKind != JsonValueKind.Object) return null;
        var result = new Dictionary<string, HeartbeatEndpoint>(StringComparer.Ordinal);
        foreach (var ep in v.EnumerateObject())
        {
            if (ep.Value.ValueKind != JsonValueKind.Object) return null;
            if (!Str(ep.Value, "subject", out var subject) || subject.Length == 0) return null;
            var md = new Dictionary<string, string>(StringComparer.Ordinal);
            if (ep.Value.TryGetProperty("metadata", out var mdEl))
            {
                if (mdEl.ValueKind != JsonValueKind.Object) return null;
                foreach (var m in mdEl.EnumerateObject())
                {
                    if (m.Value.ValueKind != JsonValueKind.String) return null;
                    md[m.Name] = m.Value.GetString()!;
                }
            }
            result[ep.Name] = new HeartbeatEndpoint(subject, md);
        }
        return result;
    }

    private static bool Str(JsonElement o, string name, out string value)
    {
        if (o.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String)
        {
            value = el.GetString()!;
            return true;
        }
        value = "";
        return false;
    }
}
