using System.Text;
using System.Text.Json;
using NATS.Client.Core;
using Synadia.AI.Agents.Identity;

namespace Synadia.AI.Agents.Tests;

internal static class IdentityFixtures
{
    public static string PathOf(string name) => Path.Combine(AppContext.BaseDirectory, "fixtures", "identity", name);

    public static JsonElement Load(string name)
    {
        using var doc = JsonDocument.Parse(File.ReadAllBytes(PathOf(name)));
        return doc.RootElement.Clone();
    }

    public static readonly JsonElement Sender = Load("sender-vectors.json");
    public static readonly JsonElement IdSig = Load("id-sig-vectors.json");
    public static readonly JsonElement AgentIds = Load("agent-id-fixtures.json");

    public static TheoryData<string> Ids(JsonElement file, string array = "vectors")
    {
        var data = new TheoryData<string>();
        foreach (var v in file.GetProperty(array).EnumerateArray()) data.Add(v.GetProperty("id").GetString()!);
        return data;
    }

    public static TheoryData<int> Indexes(JsonElement file, string array)
    {
        var data = new TheoryData<int>();
        for (var i = 0; i < file.GetProperty(array).GetArrayLength(); i++) data.Add(i);
        return data;
    }

    public static JsonElement Vector(JsonElement file, string id)
        => file.GetProperty("vectors").EnumerateArray().Single(v => v.GetProperty("id").GetString() == id);

    public static string? Str(JsonElement obj, string key)
        => obj.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
}

public class SenderVectorTests
{
    public static TheoryData<string> VectorIds => IdentityFixtures.Ids(IdentityFixtures.Sender);

    [Fact]
    public void FileShapeMatchesTheSdk()
    {
        Assert.Equal(SenderHeader.FramingBytes, IdentityFixtures.Sender.GetProperty("header_framing_bytes").GetInt32());
        Assert.True(IdentityFixtures.Sender.GetProperty("vectors").GetArrayLength() >= 8);
    }

    [Theory]
    [MemberData(nameof(VectorIds))]
    public async Task VectorIsReproducedByteExactly(string id)
    {
        var v = IdentityFixtures.Vector(IdentityFixtures.Sender, id);
        var input = v.GetProperty("input");
        var expected = v.GetProperty("expected");
        var user = input.GetProperty("user").GetString()!;
        var account = input.GetProperty("account").GetString()!;
        var name = IdentityFixtures.Str(input, "name");
        var sub = IdentityFixtures.Str(input, "sub") ?? input.GetProperty("subject").GetString()!;
        var payload = Convert.FromBase64String(input.GetProperty("payload_b64").GetString()!);
        var signed = input.GetProperty("signed").GetBoolean();

        using var signer = SenderSigner.FromSeed(input.GetProperty("seed").GetString()!);
        Assert.Equal(user, signer.PublicKey);
        var agentId = AgentId.Create(account, user);

        var header = signed
            ? await SenderHeader.SignAsync(signer, agentId, sub, payload, name,
                IdentityFixtures.Str(input, "ts"), IdentityFixtures.Str(input, "nonce"))
            : SenderHeader.BuildClaim(agentId, name);

        var value = SenderHeader.Serialize(header);
        Assert.Equal(expected.GetProperty("header").GetString(), value);
        Assert.Equal(expected.GetProperty("header_bytes").GetInt32(), Encoding.UTF8.GetByteCount(value));
        Assert.Equal(expected.GetProperty("header_wire_bytes").GetInt32(), SenderHeader.EncodedHeaderLength(value));
        Assert.True(SenderHeader.EncodedHeaderLength(value) <= SenderHeader.MaxHeaderBytes(sub, name));
        if (!signed) Assert.Equal(SenderHeader.EncodedHeaderLength(value), SenderHeader.ExpectedHeaderBytes(agentId, sub, false, name));

        var parsed = SenderHeader.Parse(expected.GetProperty("header").GetString()!);
        Assert.Equal(header, parsed);

        if (signed)
        {
            var signedInput = SenderHeader.BuildSignedInput(account, user, sub, IdentityFixtures.Str(input, "ts")!,
                IdentityFixtures.Str(input, "nonce")!, payload);
            Assert.Equal(expected.GetProperty("signed_input").GetString(), Encoding.UTF8.GetString(signedInput));
            Assert.Equal(expected.GetProperty("sig").GetString(), header.Sig);
            Assert.True(Base64Url.TryDecode(expected.GetProperty("sig").GetString()!, out var sig));
            Assert.True(SenderHeader.VerifyWithPublicKey(user, signedInput, sig));

            var stored = SenderHeader.Verify(parsed!, sub, payload, new SenderVerificationOptions { Mode = SenderVerificationMode.Stored });
            var verified = Assert.IsType<VerifiedSender>(stored);
            Assert.Equal(SenderTrust.Verified, verified.Trust);
            Assert.Equal(agentId, verified.Id);

            var live = SenderHeader.Verify(parsed!, sub, payload, new SenderVerificationOptions
            {
                Now = SenderHeader.ParseTimestamp(parsed!.Ts!),
            });
            Assert.IsType<VerifiedSender>(live);

            var tampered = payload.Append((byte)'x').ToArray();
            var ex = Assert.Throws<SenderVerificationException>(() => SenderHeader.Verify(parsed!, sub, tampered,
                new SenderVerificationOptions { Mode = SenderVerificationMode.Stored }));
            Assert.Equal(401, ex.Code);
            Assert.Equal("sender rejected", ex.Description);
        }
        else
        {
            Assert.False(expected.TryGetProperty("signed_input", out _));
            Assert.IsType<ClaimedSender>(SenderHeader.Verify(parsed!, sub, payload));
        }
    }
}

public class IdSigVectorTests
{
    public static TheoryData<string> VectorIds => IdentityFixtures.Ids(IdentityFixtures.IdSig);

    [Theory]
    [MemberData(nameof(VectorIds))]
    public async Task VectorIsReproducedByteExactly(string id)
    {
        var v = IdentityFixtures.Vector(IdentityFixtures.IdSig, id);
        var input = v.GetProperty("input");
        var expected = v.GetProperty("expected");
        string S(string k) => input.GetProperty(k).GetString()!;

        var signedInput = AgentIdSignature.BuildSignedInput(S("user"), S("account"), S("agent"), S("owner"), S("prompt_subject"));
        Assert.Equal(expected.GetProperty("signed_input").GetString(), Encoding.UTF8.GetString(signedInput));

        using var signer = SenderSigner.FromSeed(S("seed"));
        var idSig = await AgentIdSignature.SignAsync(signer, AgentId.Create(S("account"), S("user")), S("agent"), S("owner"), S("prompt_subject"));
        Assert.Equal(expected.GetProperty("id_sig").GetString(), idSig);

        var metadata = expected.GetProperty("metadata").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!);
        Assert.Equal(idSig, metadata[AgentIdSignature.IdSigKey]);
        Assert.True(AgentIdSignature.Verify(metadata, S("prompt_subject")));
        Assert.False(AgentIdSignature.Verify(metadata, S("prompt_subject") + ".x"));
        var forged = new Dictionary<string, string>(metadata) { ["owner"] = "mallory" };
        Assert.False(AgentIdSignature.Verify(forged, S("prompt_subject")));
    }
}

public class AgentIdFixtureTests
{
    public static TheoryData<int> ParseRows => IdentityFixtures.Indexes(IdentityFixtures.AgentIds, "parse");
    public static TheoryData<int> NewRows => IdentityFixtures.Indexes(IdentityFixtures.AgentIds, "new");

    [Fact]
    public void RegexMatchesTheFixture()
        => Assert.Equal(AgentId.Pattern, IdentityFixtures.AgentIds.GetProperty("regex").GetString());

    [Theory]
    [MemberData(nameof(ParseRows))]
    public void ParseRow(int index)
    {
        var row = IdentityFixtures.AgentIds.GetProperty("parse")[index];
        var text = row.GetProperty("input").GetString()!;
        if (row.GetProperty("valid").GetBoolean())
        {
            var id = AgentId.Parse(text);
            Assert.Equal(row.GetProperty("account").GetString(), id.Account);
            Assert.Equal(row.GetProperty("user").GetString(), id.User);
            Assert.Equal(text, id.ToString());
            if (row.TryGetProperty("length", out var len)) Assert.Equal(len.GetInt32(), text.Length);
            Assert.True(AgentId.TryParse(text, out _));
        }
        else
        {
            Assert.Throws<InvalidAgentIdException>(() => AgentId.Parse(text));
            Assert.False(AgentId.TryParse(text, out _));
        }
    }

    [Theory]
    [MemberData(nameof(NewRows))]
    public void NewRow(int index)
    {
        var row = IdentityFixtures.AgentIds.GetProperty("new")[index];
        var account = row.GetProperty("account").GetString()!;
        var user = row.GetProperty("user").GetString()!;
        if (row.GetProperty("valid").GetBoolean())
        {
            var id = AgentId.Create(account, user);
            Assert.Equal(row.GetProperty("string").GetString(), id.ToString());
            Assert.Equal(id, AgentId.Parse(id.ToString()));
        }
        else
        {
            Assert.Throws<InvalidAgentIdException>(() => AgentId.Create(account, user));
        }
    }
}

public class IdentityKeyTests
{
    [Fact]
    public void EveryKeysJsonSeedDerivesItsPublicKey()
    {
        var users = IdentityFixtures.Load("keys.json").GetProperty("users");
        var count = 0;
        foreach (var u in users.EnumerateObject())
        {
            using var signer = SenderSigner.FromSeed(u.Value.GetProperty("seed").GetString()!);
            Assert.Equal(u.Value.GetProperty("public").GetString(), signer.PublicKey);
            count++;
        }
        Assert.Equal(5, count);
    }

    [Theory]
    [InlineData("alice", "ACME")]
    [InlineData("carol", "ACME")]
    [InlineData("bob", "APP")]
    public void OperatorCredsYieldTheJwtIdentity(string user, string account)
    {
        var keys = IdentityFixtures.Load(Path.Combine("operator", "keys.json"));
        using var signer = SenderSigner.FromCredsFile(IdentityFixtures.PathOf(Path.Combine("operator", user + ".creds")));
        Assert.NotNull(signer.Jwt);
        var id = SenderSigner.IdentityFromJwt(signer.Jwt!);
        Assert.Equal(signer.PublicKey, id.User);
        Assert.Equal(keys.GetProperty("accounts").GetProperty(account).GetProperty("public").GetString(), id.Account);
        Assert.Equal(113, id.ToString().Length);
    }

    [Fact]
    public void SignerPublicKeyMustBeAUserKey()
    {
        var keys = IdentityFixtures.Load(Path.Combine("operator", "keys.json"));
        var accountSeed = keys.GetProperty("accounts").GetProperty("ACME").GetProperty("seed").GetString()!;
        Assert.ThrowsAny<Exception>(() => SenderSigner.FromSeed(accountSeed));
    }
}

public class SenderHeaderBehaviourTests
{
    private const string AliceSeed = "SUAEJ6GDK6FSSB54LD45Q7W25AW7NUT7MVLBABIR5MIPFUTBW7ZNPK2KYE";
    private const string AliceUser = "UCDUW5V44EBDBIK2FL4CTNDBQFNGBEZVJHSZGQVKRHASN4AV4IWPB5NT";
    private const string Subject = "agents.prompt.demo-agent.alice.example";
    private static readonly AgentId Alice = AgentId.Create("$G", AliceUser);

    private static async Task<AgentSenderHeader> SignAsync(string sub = Subject, string? ts = null, string? nonce = null)
    {
        using var signer = SenderSigner.FromSeed(AliceSeed);
        return await SenderHeader.SignAsync(signer, Alice, sub, "{}"u8.ToArray(), ts: ts, nonce: nonce);
    }

    [Fact]
    public async Task ExpectedHeaderBytesIsExactForDefaultSigning()
    {
        var header = await SignAsync();
        Assert.Equal(SenderHeader.EncodedHeaderLength(SenderHeader.Serialize(header)), SenderHeader.ExpectedHeaderBytes(Alice, Subject, true));
    }

    [Fact]
    public async Task LiveModeRejectsStaleTimestampsAndSeenNonces()
    {
        var header = await SignAsync(ts: "2026-08-28T12:00:00Z", nonce: "n1");
        var at = SenderHeader.ParseTimestamp(header.Ts!);
        Assert.IsType<VerifiedSender>(SenderHeader.Verify(header, Subject, "{}"u8, new SenderVerificationOptions { Now = at.AddSeconds(30) }));
        var stale = Assert.Throws<SenderVerificationException>(() =>
            SenderHeader.Verify(header, Subject, "{}"u8, new SenderVerificationOptions { Now = at.AddSeconds(31) }));
        Assert.Equal(401, stale.Code);
        var seen = Assert.Throws<SenderVerificationException>(() =>
            SenderHeader.Verify(header, Subject, "{}"u8, new SenderVerificationOptions { Now = at, NonceSeen = (u, n) => u == AliceUser && n == "n1" }));
        Assert.Contains("nonce", seen.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SignedSubjectMustMatchTheArrivalSubject()
    {
        var header = await SignAsync();
        Assert.Throws<SenderVerificationException>(() => SenderHeader.Verify(header, Subject + ".other", "{}"u8));
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("""{"v":1,"account":"$G"}""")]
    [InlineData("""{"v":1,"account":"$G","user":"UCDUW5V44EBDBIK2FL4CTNDBQFNGBEZVJHSZGQVKRHASN4AV4IWPB5NT","sig":"x"}""")]
    public void MalformedHeadersThrow(string value)
        => Assert.Throws<MalformedSenderHeaderException>(() => SenderHeader.Parse(value));

    [Fact]
    public void UnknownVersionIsIgnored()
        => Assert.Null(SenderHeader.Parse("""{"v":2,"anything":true}"""));

    [Fact]
    public void VerifyFromHeadersReturnsNullWithoutAHeader()
    {
        Assert.Null(SenderHeader.Verify(Subject, "{}"u8, null));
        Assert.Null(SenderHeader.Verify(Subject, "{}"u8, new NatsHeaders { ["Other"] = "x" }));
    }

    [Fact]
    public void FormatDescribesTrust()
    {
        Assert.Equal("(no sender)", SenderHeader.Format(null));
        Assert.Equal($"$G.{AliceUser} (claimed)", SenderHeader.Format(new ClaimedSender(SenderHeader.BuildClaim(Alice))));
    }

    [Fact]
    public void NewNonceIsValid()
    {
        var n = SenderHeader.NewNonce();
        Assert.True(SenderHeader.IsValidNonce(n));
        Assert.NotEqual(n, SenderHeader.NewNonce());
    }
}

public class SelfIdTests
{
    private const string AliceUser = "UCDUW5V44EBDBIK2FL4CTNDBQFNGBEZVJHSZGQVKRHASN4AV4IWPB5NT";

    private static JsonElement J(string json) => JsonDocument.Parse(json).RootElement;

    [Fact]
    public void UserInfoReplyYieldsTheAgentId()
    {
        var id = SelfId.FromUserInfo(J("""{"data":{"user":""" + "\"" + AliceUser + "\"" + ""","account":"$G","permissions":{}}}"""));
        Assert.Equal(AgentId.Create("$G", AliceUser), id);
    }

    [Theory]
    [InlineData("""{"data":{"user":"","account":"$G"}}""")]
    [InlineData("""{"data":{"user":"[REDACTED]","account":"$G"}}""")]
    [InlineData("""{"data":{"user":"bob","account":"$G"}}""")]
    [InlineData("""{"data":{"user":"UCDUW5V44EBDBIK2FL4CTNDBQFNGBEZVJHSZGQVKRHASN4AV4IWPB5NT","account":"acme corp"}}""")]
    public void NonNkeyUsersHaveNoIdentity(string reply)
        => Assert.Throws<NoIdentityException>(() => SelfId.FromUserInfo(J(reply)));

    [Theory]
    [InlineData("""{"error":{"code":500}}""")]
    [InlineData("""{"data":{}}""")]
    [InlineData("[]")]
    public void UnexpectedRepliesAreUnavailable(string reply)
        => Assert.Throws<IdentityUnavailableException>(() => SelfId.FromUserInfo(J(reply)));
}
