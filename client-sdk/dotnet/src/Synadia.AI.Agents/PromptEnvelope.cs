using System.Buffers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.AI;

namespace Synadia.AI.Agents;

/// <summary>
/// A prompt request envelope (spec §5.1): <c>{"prompt": "...", "attachments": [...], ...extras}</c>.
/// Attachments are surfaced as MEAI <see cref="DataContent"/> — <see cref="DataContent.Name"/> carries the
/// wire <c>filename</c> and the media type is inferred from the extension on decode.
/// </summary>
public sealed partial class PromptEnvelope
{
    private static readonly IReadOnlyDictionary<string, JsonElement> NoExtras = new Dictionary<string, JsonElement>();

    /// <summary>Create an envelope.</summary>
    /// <param name="prompt">The prompt text; must be non-empty to be sent.</param>
    /// <param name="attachments">Optional attachments. A missing <see cref="DataContent.Name"/> is filled in on encode.</param>
    /// <param name="extras">Optional top-level fields not defined by the protocol (§5.6). <c>prompt</c>/<c>attachments</c> keys are ignored.</param>
    public PromptEnvelope(string prompt, IEnumerable<DataContent>? attachments = null, IReadOnlyDictionary<string, JsonElement>? extras = null)
    {
        Prompt = prompt ?? throw new ArgumentNullException(nameof(prompt));
        Attachments = attachments?.ToArray() ?? [];
        Extras = extras ?? NoExtras;
    }

    /// <summary>The prompt text.</summary>
    public string Prompt { get; }

    /// <summary>Attachments (possibly empty).</summary>
    public IReadOnlyList<DataContent> Attachments { get; }

    /// <summary>Top-level fields the protocol does not define (§5.6), keyed by wire name.</summary>
    public IReadOnlyDictionary<string, JsonElement> Extras { get; }

    /// <summary>
    /// Envelope extra that carries a caller's conversation id (<c>session_id</c>). A .NET convention, not part of the
    /// protocol: <c>AsIChatClient()</c> sends <see cref="ChatOptions.ConversationId"/> here, and the .NET serve helpers key
    /// their conversations on it. Other callers may omit it.
    /// </summary>
    public const string SessionIdExtra = "session_id";

    /// <summary>The <see cref="SessionIdExtra"/> extra when it is a string, otherwise <c>null</c>.</summary>
    public string? SessionId
        => Extras.TryGetValue(SessionIdExtra, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /// <summary>Create a <see cref="DataContent"/> attachment with <paramref name="filename"/> as its name.</summary>
    public static DataContent CreateAttachment(string filename, ReadOnlyMemory<byte> content, string? mediaType = null)
        => new(content, mediaType ?? AttachmentMediaTypes.FromFileName(filename)) { Name = filename };

    /// <summary>Read a file from disk into an attachment named after the file.</summary>
    public static async Task<DataContent> AttachmentFromFileAsync(string path, CancellationToken cancellationToken = default)
    {
        var bytes = await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
        return CreateAttachment(Path.GetFileName(path), bytes);
    }

    /// <summary>The wire filename of <paramref name="attachment"/> at position <paramref name="index"/>.</summary>
    public static string FileNameOf(DataContent attachment, int index)
        => !string.IsNullOrEmpty(attachment.Name)
            ? attachment.Name!
            : $"attachment-{index + 1}{AttachmentMediaTypes.ExtensionFor(attachment.MediaType)}";

    /// <summary>Serialize to UTF-8 JSON (§5.1). Protocol fields come first, extras after.</summary>
    public byte[] Encode()
    {
        var buffer = new ArrayBufferWriter<byte>(256 + Prompt.Length);
        using (var w = new Utf8JsonWriter(buffer, WireJson.WriterOptions))
        {
            w.WriteStartObject();
            w.WriteString("prompt", Prompt);
            if (Attachments.Count > 0)
            {
                w.WriteStartArray("attachments");
                for (var i = 0; i < Attachments.Count; i++)
                {
                    WireJson.WriteAttachment(w, FileNameOf(Attachments[i], i), Attachments[i].Data.Span);
                }
                w.WriteEndArray();
            }
            foreach (var (key, value) in Extras)
            {
                if (key is "prompt" or "attachments") continue;
                w.WritePropertyName(key);
                value.WriteTo(w);
            }
            w.WriteEndObject();
        }
        return buffer.WrittenSpan.ToArray();
    }

    /// <summary>
    /// Decode an inbound request payload per the §5.3 discrimination algorithm: a <c>{</c>-led payload must
    /// be a valid JSON envelope; anything else is the plain-text shorthand.
    /// </summary>
    /// <exception cref="InvalidEnvelopeException">The payload violates §5.</exception>
    public static PromptEnvelope Decode(ReadOnlySpan<byte> data)
    {
        if (data.Length == 0) throw new InvalidEnvelopeException("zero-byte request payload (§5.3)");

        if (!StartsWithJsonObject(data))
        {
            return new PromptEnvelope(Encoding.UTF8.GetString(data));
        }

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(data.ToArray());
        }
        catch (JsonException ex)
        {
            throw new InvalidEnvelopeException($"malformed JSON envelope: {ex.Message}");
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new InvalidEnvelopeException("envelope must be a JSON object");
            if (!root.TryGetProperty("prompt", out var promptEl) || promptEl.ValueKind != JsonValueKind.String)
            {
                throw new InvalidEnvelopeException("envelope missing required string `prompt` field");
            }
            var prompt = promptEl.GetString()!;
            if (prompt.Length == 0) throw new InvalidEnvelopeException("envelope `prompt` must be a non-empty string");

            Dictionary<string, JsonElement>? extras = null;
            List<DataContent>? attachments = null;
            foreach (var prop in root.EnumerateObject())
            {
                if (prop.Name == "prompt") continue;
                if (prop.Name == "attachments")
                {
                    if (prop.Value.ValueKind != JsonValueKind.Array) throw new InvalidEnvelopeException("envelope `attachments` must be an array");
                    attachments = DecodeAttachments(prop.Value);
                    continue;
                }
                (extras ??= new Dictionary<string, JsonElement>(StringComparer.Ordinal))[prop.Name] = prop.Value.Clone();
            }
            return new PromptEnvelope(prompt, attachments, extras);
        }
    }

    internal static List<DataContent> DecodeAttachments(JsonElement array)
    {
        var list = new List<DataContent>();
        var idx = 0;
        foreach (var item in array.EnumerateArray())
        {
            list.Add(DecodeAttachment(item, idx++));
        }
        return list;
    }

    private static DataContent DecodeAttachment(JsonElement item, int idx)
    {
        if (item.ValueKind != JsonValueKind.Object) throw new InvalidEnvelopeException($"attachment[{idx}] must be an object");
        if (!item.TryGetProperty("filename", out var fnEl) || fnEl.ValueKind != JsonValueKind.String)
        {
            throw new InvalidEnvelopeException($"attachment[{idx}] missing string `filename`");
        }
        if (!item.TryGetProperty("content", out var cEl) || cEl.ValueKind != JsonValueKind.String)
        {
            throw new InvalidEnvelopeException($"attachment[{idx}] missing string `content`");
        }
        var filename = fnEl.GetString()!;
        AssertSafeFilename(filename, idx);
        byte[] bytes;
        try
        {
            bytes = DecodeStrictBase64(cEl.GetString()!);
        }
        catch (FormatException ex)
        {
            throw new InvalidEnvelopeException($"attachment[{idx}] has invalid base64 content: {ex.Message}");
        }
        return CreateAttachment(filename, bytes);
    }

    /// <summary>RFC 4648 §4 strict base64: standard alphabet, padded, no whitespace (§5.2).</summary>
    /// <exception cref="FormatException">The input is not strict base64.</exception>
    public static byte[] DecodeStrictBase64(string s)
    {
        if (s.Length == 0) return [];
        if (s.Length % 4 != 0) throw new FormatException("base64 length must be a multiple of 4 (padded)");
        if (!StrictBase64().IsMatch(s)) throw new FormatException("base64 must use standard alphabet, padded, no whitespace");
        return Convert.FromBase64String(s);
    }

    private static void AssertSafeFilename(string name, int idx)
    {
        if (name.Length == 0) throw new InvalidEnvelopeException($"attachment[{idx}] has empty filename");
        if (name.AsSpan().IndexOfAny('/', '\\', '\0') >= 0)
        {
            throw new InvalidEnvelopeException($"attachment[{idx}] has unsafe filename (path separator or NUL)");
        }
        if (name is "." or "..")
        {
            throw new InvalidEnvelopeException($"attachment[{idx}] has unsafe filename ('.' or '..' component)");
        }
    }

    private static bool StartsWithJsonObject(ReadOnlySpan<byte> data)
    {
        foreach (var b in data)
        {
            if (b is 0x09 or 0x0a or 0x0d or 0x20) continue;
            return b == (byte)'{';
        }
        return false;
    }

    [GeneratedRegex(@"^[A-Za-z0-9+/]*={0,2}\z")]
    private static partial Regex StrictBase64();
}

/// <summary>Shared JSON writer settings that keep wire output close to JavaScript's <c>JSON.stringify</c>.</summary>
internal static class WireJson
{
    public static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        Indented = false,
        SkipValidation = false,
    };

    public static void WriteAttachment(Utf8JsonWriter w, string filename, ReadOnlySpan<byte> content)
    {
        w.WriteStartObject();
        w.WriteString("filename", filename);
        w.WriteBase64String("content", content);
        w.WriteEndObject();
    }

    public static byte[] Write(Action<Utf8JsonWriter> body)
    {
        var buffer = new ArrayBufferWriter<byte>(256);
        using (var w = new Utf8JsonWriter(buffer, WriterOptions))
        {
            body(w);
        }
        return buffer.WrittenSpan.ToArray();
    }
}
