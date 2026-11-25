namespace Synadia.AI.Agents.Identity;

/// <summary>Unpadded base64url (RFC 4648 §5), strict alphabet.</summary>
internal static class Base64Url
{
    public static string Encode(ReadOnlySpan<byte> data)
        => Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static bool TryDecode(string text, out byte[] bytes)
    {
        bytes = [];
        if (text.Length % 4 == 1) return false;
        foreach (var c in text)
        {
            if (!(c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '-' or '_')) return false;
        }
        var b64 = text.Replace('-', '+').Replace('_', '/');
        b64 += (b64.Length % 4) switch { 2 => "==", 3 => "=", _ => "" };
        try
        {
            bytes = Convert.FromBase64String(b64);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
