using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.AI;

namespace Synadia.AI.Agents;

/// <summary>Why an attachment was not saved.</summary>
public enum AttachmentSkipReason
{
    /// <summary>Saving it would push the call's total past <see cref="AttachmentSaver.DefaultMaxTotalBytes"/> (or the given limit).</summary>
    OverLimit,
    /// <summary>The content was not strict RFC 4648 §4 base64.</summary>
    InvalidContent,
}

/// <summary>One entry per input attachment of <see cref="AttachmentSaver.SaveAsync(IEnumerable{DataContent}, string, long?, CancellationToken)"/>, in input order.</summary>
/// <param name="FileName">The name exactly as the sender gave it (the file on disk may differ; see <paramref name="Path"/>).</param>
/// <param name="SizeBytes">Decoded size in bytes; 0 when the content was invalid.</param>
/// <param name="Path">Absolute path of the written file; null when not saved.</param>
/// <param name="Skipped">Why it was not saved; set iff <paramref name="Path"/> is null.</param>
public sealed record SavedAttachment(string FileName, long SizeBytes, string? Path, AttachmentSkipReason? Skipped = null)
{
    /// <summary>The wire spelling of <see cref="Skipped"/>: <c>over_limit</c> or <c>invalid_content</c>.</summary>
    public string? SkippedText => Skipped switch
    {
        AttachmentSkipReason.OverLimit => "over_limit",
        AttachmentSkipReason.InvalidContent => "invalid_content",
        _ => null,
    };
}

/// <summary>
/// Saves received attachments to disk, the receiving counterpart of attachments on a prompt. Same rules as
/// the TypeScript <c>saveAttachments</c> and Python <c>save_attachments</c>; <c>test-fixtures/attachments/</c>
/// holds the shared cases. Sender names are untrusted: only the last path component survives, sanitized,
/// and a file is only ever created — never overwritten, never reached through a link.
/// </summary>
public static partial class AttachmentSaver
{
    /// <summary>Default upper bound on decoded bytes one call writes: 64 MiB.</summary>
    public const long DefaultMaxTotalBytes = 64L * 1024 * 1024;

    private const int MaxNameBytes = 200;
    private const int MaxExtensionChars = 16;
    private const int MaxNameAttempts = 1000;

    private const string EdgeChars =
        " .\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
        "\u2028\u2029\u202f\u205f\u3000\ufeff";
    private const string WindowsForbidden = "<>:\"|?*";

    [GeneratedRegex("^(?:CON|PRN|AUX|NUL|CONIN\\$|CONOUT\\$|(?:COM|LPT)[1-9\u00b9\u00b2\u00b3]) *(?:\\.|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex WindowsDeviceName();

    /// <summary>Save decoded attachments (as the SDK hands them out) into <paramref name="directory"/>.</summary>
    public static Task<IReadOnlyList<SavedAttachment>> SaveAsync(IEnumerable<DataContent> attachments, string directory,
        long? maxTotalBytes = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(attachments);
        var items = attachments.Select(a => (Name: a.Name ?? "", Bytes: (ReadOnlyMemory<byte>?)a.Data));
        return SaveCoreAsync(items, directory, maxTotalBytes, cancellationToken);
    }

    /// <summary>Save wire-form attachments (<c>{filename, content: base64}</c>) into <paramref name="directory"/>.</summary>
    public static Task<IReadOnlyList<SavedAttachment>> SaveAsync(IEnumerable<(string FileName, string Base64Content)> attachments, string directory,
        long? maxTotalBytes = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(attachments);
        var items = attachments.Select(a =>
        {
            ReadOnlyMemory<byte>? bytes = null;
            if (a.Base64Content is not null)
            {
                try { bytes = PromptEnvelope.DecodeStrictBase64(a.Base64Content); }
                catch (FormatException) { }
            }
            return (Name: a.FileName ?? "", Bytes: bytes);
        });
        return SaveCoreAsync(items, directory, maxTotalBytes, cancellationToken);
    }

    private static async Task<IReadOnlyList<SavedAttachment>> SaveCoreAsync(IEnumerable<(string Name, ReadOnlyMemory<byte>? Bytes)> items,
        string directory, long? maxTotalBytes, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(directory);
        var limit = maxTotalBytes ?? DefaultMaxTotalBytes;
        if (limit < 0) throw new ArgumentOutOfRangeException(nameof(maxTotalBytes), limit, "must be 0 or more");
        var root = System.IO.Path.GetFullPath(directory);
        CreatePrivateDirectory(root);

        var saved = new List<SavedAttachment>();
        long total = 0;
        var position = 0;
        foreach (var (name, bytes) in items)
        {
            position++;
            if (bytes is not { } data)
            {
                saved.Add(new SavedAttachment(name, 0, null, AttachmentSkipReason.InvalidContent));
                continue;
            }
            if (total + data.Length > limit)
            {
                saved.Add(new SavedAttachment(name, data.Length, null, AttachmentSkipReason.OverLimit));
                continue;
            }
            var path = await CreateExclusiveAsync(root, SafeName(name, position), data, cancellationToken).ConfigureAwait(false);
            total += data.Length;
            saved.Add(new SavedAttachment(name, data.Length, path));
        }
        return saved;
    }

    /// <summary>The name an attachment is saved under, before any <c>(n)</c> suffix. <paramref name="position"/> is 1-based.</summary>
    public static string SafeName(string name, int position)
    {
        name ??= "";
        var lastSeparator = Math.Max(name.LastIndexOf('/'), name.LastIndexOf('\\'));
        var sb = new StringBuilder();
        var tail = name[(lastSeparator + 1)..];
        for (var i = 0; i < tail.Length; i++)
        {
            var ch = tail[i];
            if (char.IsHighSurrogate(ch) && i + 1 < tail.Length && char.IsLowSurrogate(tail[i + 1]))
            {
                sb.Append(ch).Append(tail[i + 1]);
                i++;
                continue;
            }
            int cp = ch;
            if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) continue;
            if (cp is 0x200e or 0x200f) continue;
            if (cp is >= 0x202a and <= 0x202e || cp is >= 0x2066 and <= 0x2069) continue;
            if (char.IsSurrogate(ch)) sb.Append('\ufffd');
            else sb.Append(WindowsForbidden.Contains(ch) ? '_' : ch);
        }
        var output = TrimEdges(sb.ToString());
        if (output.Length == 0) return $"attachment-{position}";
        output = Shorten(output);
        return WindowsDeviceName().IsMatch(output) ? Shorten("_" + output) : output;
    }

    private static string Shorten(string name)
    {
        if (Encoding.UTF8.GetByteCount(name) <= MaxNameBytes) return name;
        var (stem, ext) = SplitExtension(name);
        if (CodePoints(ext) > MaxExtensionChars)
        {
            stem = name;
            ext = "";
        }
        var budget = MaxNameBytes - Encoding.UTF8.GetByteCount(ext);
        var kept = new StringBuilder();
        var used = 0;
        foreach (var rune in stem.EnumerateRunes())
        {
            var n = rune.Utf8SequenceLength;
            if (used + n > budget) break;
            kept.Append(rune.ToString());
            used += n;
        }
        return TrimEdges(kept.ToString()) + ext;
    }

    private static int CodePoints(string s)
    {
        var n = 0;
        foreach (var _ in s.EnumerateRunes()) n++;
        return n;
    }

    private static (string Stem, string Ext) SplitExtension(string name)
    {
        var dot = name.LastIndexOf('.');
        return dot > 0 ? (name[..dot], name[dot..]) : (name, "");
    }

    private static string TrimEdges(string s)
    {
        int start = 0, end = s.Length;
        while (start < end && EdgeChars.Contains(s[start])) start++;
        while (end > start && EdgeChars.Contains(s[end - 1])) end--;
        return s[start..end];
    }

    internal static void CreatePrivateDirectory(string path)
    {
        if (OperatingSystem.IsWindows()) Directory.CreateDirectory(path);
        else Directory.CreateDirectory(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    private static async Task<string> CreateExclusiveAsync(string root, string name, ReadOnlyMemory<byte> bytes, CancellationToken ct)
    {
        var (stem, ext) = SplitExtension(name);
        for (var attempt = 1; attempt <= MaxNameAttempts; attempt++)
        {
            var path = System.IO.Path.Combine(root, attempt == 1 ? name : $"{stem} ({attempt}){ext}");
            FileStream stream;
            try
            {
                var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
                if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                stream = new FileStream(path, options);
            }
            catch (IOException) when (File.Exists(path) || Directory.Exists(path) || IsLink(path))
            {
                continue;
            }
            try
            {
                await using (stream.ConfigureAwait(false))
                {
                    await stream.WriteAsync(bytes, ct).ConfigureAwait(false);
                }
            }
            catch
            {
                try { File.Delete(path); } catch { /* best effort */ }
                throw;
            }
            return path;
        }
        throw new IOException($"AttachmentSaver: no free name for \"{name}\" in {root} after {MaxNameAttempts} attempts");
    }

    private static bool IsLink(string path)
    {
        try { return new FileInfo(path).LinkTarget is not null; }
        catch { return false; }
    }
}
