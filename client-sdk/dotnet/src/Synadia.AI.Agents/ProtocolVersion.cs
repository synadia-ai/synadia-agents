using System.Globalization;
using System.Text.RegularExpressions;

namespace Synadia.AI.Agents;

/// <summary>How an agent's protocol version relates to the SDK's (spec §11.1).</summary>
public enum VersionCompatibility
{
    /// <summary>Same MAJOR.MINOR — full interoperability.</summary>
    Compatible,
    /// <summary>Same MAJOR, different MINOR — proceed with caution.</summary>
    MinorDrift,
    /// <summary>Different MAJOR — no interoperability guarantee.</summary>
    Incompatible,
}

/// <summary>A wire protocol version (spec §11.1). Only MAJOR.MINOR is significant.</summary>
public readonly partial record struct ProtocolVersion(int Major, int Minor)
{
    /// <summary>The protocol version this SDK implements: <c>0.3</c>.</summary>
    public static ProtocolVersion Sdk { get; } = new(0, 3);

    /// <summary>Parse <c>MAJOR.MINOR[.patch][-qualifier]</c>; qualifiers are discarded.</summary>
    /// <exception cref="InvalidProtocolVersionException">The input is not a version.</exception>
    public static ProtocolVersion Parse(string input)
    {
        if (!TryParse(input, out var v))
        {
            throw new InvalidProtocolVersionException(input);
        }
        return v;
    }

    /// <summary>Try to parse a protocol version.</summary>
    public static bool TryParse(string? input, out ProtocolVersion version)
    {
        version = default;
        if (input is null) return false;
        var m = VersionPattern().Match(input);
        if (!m.Success) return false;
        if (!int.TryParse(m.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var major) ||
            !int.TryParse(m.Groups[2].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var minor))
        {
            return false;
        }
        version = new ProtocolVersion(major, minor);
        return true;
    }

    /// <summary>Compare this (agent) version against <paramref name="sdk"/> (default <see cref="Sdk"/>).</summary>
    public VersionCompatibility CompareTo(ProtocolVersion? sdk = null)
    {
        var s = sdk ?? Sdk;
        if (Major != s.Major) return VersionCompatibility.Incompatible;
        if (Minor != s.Minor) return VersionCompatibility.MinorDrift;
        return VersionCompatibility.Compatible;
    }

    /// <inheritdoc />
    public override string ToString() => string.Create(CultureInfo.InvariantCulture, $"{Major}.{Minor}");

    [GeneratedRegex(@"^\s*(\d+)\.(\d+)(?:[.-].*)?\s*$")]
    private static partial Regex VersionPattern();
}
