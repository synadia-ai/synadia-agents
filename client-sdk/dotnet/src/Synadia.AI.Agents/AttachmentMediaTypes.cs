namespace Synadia.AI.Agents;

/// <summary>
/// Best-effort filename → media-type map used when decoding wire attachments into
/// <see cref="Microsoft.Extensions.AI.DataContent"/>. The wire format carries only
/// <c>filename</c> + <c>content</c>, so the media type is inferred from the extension.
/// </summary>
public static class AttachmentMediaTypes
{
    /// <summary>Fallback when the extension is unknown.</summary>
    public const string Default = "application/octet-stream";

    private static readonly Dictionary<string, string> Map = new(StringComparer.OrdinalIgnoreCase)
    {
        [".txt"] = "text/plain",
        [".md"] = "text/markdown",
        [".csv"] = "text/csv",
        [".html"] = "text/html",
        [".htm"] = "text/html",
        [".xml"] = "application/xml",
        [".json"] = "application/json",
        [".yaml"] = "application/yaml",
        [".yml"] = "application/yaml",
        [".pdf"] = "application/pdf",
        [".zip"] = "application/zip",
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif",
        [".webp"] = "image/webp",
        [".svg"] = "image/svg+xml",
        [".mp3"] = "audio/mpeg",
        [".wav"] = "audio/wav",
        [".mp4"] = "video/mp4",
        [".docx"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        [".xlsx"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        [".pptx"] = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };

    /// <summary>Best-effort file extension (with leading dot) for <paramref name="mediaType"/>, or <c>""</c>.</summary>
    public static string ExtensionFor(string? mediaType)
    {
        if (string.IsNullOrEmpty(mediaType)) return "";
        foreach (var kv in Map)
        {
            if (string.Equals(kv.Value, mediaType, StringComparison.OrdinalIgnoreCase)) return kv.Key;
        }
        return "";
    }

    /// <summary>Infer a media type from <paramref name="filename"/>'s extension.</summary>
    public static string FromFileName(string? filename)
    {
        if (string.IsNullOrEmpty(filename)) return Default;
        var ext = Path.GetExtension(filename);
        return !string.IsNullOrEmpty(ext) && Map.TryGetValue(ext, out var mt) ? mt : Default;
    }
}
