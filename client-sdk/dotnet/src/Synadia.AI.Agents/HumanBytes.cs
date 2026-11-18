using System.Globalization;
using System.Text.RegularExpressions;

namespace Synadia.AI.Agents;

/// <summary>
/// Human-readable byte sizes per spec §2.1 (<c>\d+(B|KB|MB|GB)</c>). Base-1024, case-insensitive —
/// matching the TypeScript and Python SDKs.
/// </summary>
public static partial class HumanBytes
{
    private static readonly (string Unit, long Multiplier)[] FormatUnits =
    [
        ("GB", 1024L * 1024 * 1024),
        ("MB", 1024L * 1024),
        ("KB", 1024L),
    ];

    /// <summary>Parse e.g. <c>"1MB"</c>, <c>"512KB"</c>, <c>"4gb"</c> into a byte count.</summary>
    /// <exception cref="InvalidSizeException">The input does not match the grammar.</exception>
    public static long Parse(string input)
    {
        if (!TryParse(input, out var bytes))
        {
            throw new InvalidSizeException(input, "expected e.g. '1MB', '512KB', '4GB'");
        }
        return bytes;
    }

    /// <summary>Try to parse a human-readable byte size.</summary>
    public static bool TryParse(string? input, out long bytes)
    {
        bytes = 0;
        if (input is null) return false;
        var m = SizePattern().Match(input);
        if (!m.Success) return false;
        if (!long.TryParse(m.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var value)) return false;
        var multiplier = m.Groups[2].Value.ToUpperInvariant() switch
        {
            "B" => 1L,
            "KB" => 1024L,
            "MB" => 1024L * 1024,
            "GB" => 1024L * 1024 * 1024,
            _ => 0L,
        };
        if (multiplier == 0) return false;
        try
        {
            bytes = checked(value * multiplier);
        }
        catch (OverflowException)
        {
            return false;
        }
        return true;
    }

    /// <summary>
    /// Format a byte count using the largest unit that divides it evenly, so <c>8388608</c> → <c>"8MB"</c>.
    /// </summary>
    public static string Format(long bytes)
    {
        if (bytes < 0) throw new InvalidSizeException(bytes.ToString(CultureInfo.InvariantCulture), "byte count must be non-negative");
        foreach (var (unit, multiplier) in FormatUnits)
        {
            if (bytes >= multiplier && bytes % multiplier == 0)
            {
                return string.Create(CultureInfo.InvariantCulture, $"{bytes / multiplier}{unit}");
            }
        }
        return string.Create(CultureInfo.InvariantCulture, $"{bytes}B");
    }

    [GeneratedRegex(@"^\s*(\d+)\s*(B|KB|MB|GB)\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex SizePattern();
}
