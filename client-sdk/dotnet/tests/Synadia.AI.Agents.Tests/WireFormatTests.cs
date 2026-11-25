using System.Text;
using System.Text.Json;
using Microsoft.Extensions.AI;

namespace Synadia.AI.Agents.Tests;

public class EnvelopeTests
{
    [Fact]
    public void PlainTextPromptEncodesAsJsonEnvelope()
    {
        var bytes = new PromptEnvelope("hello").Encode();
        Assert.Equal("""{"prompt":"hello"}""", Encoding.UTF8.GetString(bytes));
    }

    [Fact]
    public void EnvelopeWithAttachmentsRoundTrips()
    {
        var env = new PromptEnvelope("look", [PromptEnvelope.CreateAttachment("a.txt", "hi"u8.ToArray())]);
        var bytes = env.Encode();
        using var doc = JsonDocument.Parse(bytes);
        Assert.Equal("look", doc.RootElement.GetProperty("prompt").GetString());
        var att = doc.RootElement.GetProperty("attachments")[0];
        Assert.Equal("a.txt", att.GetProperty("filename").GetString());
        Assert.Equal("aGk=", att.GetProperty("content").GetString());

        var back = PromptEnvelope.Decode(bytes);
        Assert.Equal("look", back.Prompt);
        var a = Assert.Single(back.Attachments);
        Assert.Equal("a.txt", a.Name);
        Assert.Equal("hi"u8.ToArray(), a.Data.ToArray());
        Assert.Equal("text/plain", a.MediaType);
    }

    [Fact]
    public void ExtrasArePreserved()
    {
        var env = PromptEnvelope.Decode("""{"prompt":"p","trace":{"id":1}}"""u8);
        Assert.Equal(1, env.Extras["trace"].GetProperty("id").GetInt32());
        using var doc = JsonDocument.Parse(env.Encode());
        Assert.Equal(1, doc.RootElement.GetProperty("trace").GetProperty("id").GetInt32());
    }

    [Theory]
    [InlineData("")]
    [InlineData("{not json")]
    [InlineData("""{"prompt":""}""")]
    [InlineData("""{"prompt":1}""")]
    [InlineData("""{"prompt":"x","attachments":{}}""")]
    [InlineData("""{"prompt":"x","attachments":[{"filename":"../x","content":""}]}""")]
    [InlineData("""{"prompt":"x","attachments":[{"filename":"a","content":"aGk"}]}""")]
    public void InvalidEnvelopesAreRejected(string payload)
        => Assert.Throws<InvalidEnvelopeException>(() => PromptEnvelope.Decode(Encoding.UTF8.GetBytes(payload)));

    [Fact]
    public void LeadingWhitespaceBeforeBraceIsJson()
        => Assert.Equal("x", PromptEnvelope.Decode("  \n{\"prompt\":\"x\"}"u8).Prompt);

    public static TheoryData<string, bool, string?> Base64Cases()
    {
        var data = new TheoryData<string, bool, string?>();
        using var doc = JsonDocument.Parse(File.ReadAllText(Fixtures.Path("attachments", "base64-content.json")));
        foreach (var c in doc.RootElement.GetProperty("cases").EnumerateArray())
        {
            data.Add(c.GetProperty("content").GetString()!, c.GetProperty("valid").GetBoolean(),
                c.TryGetProperty("hex", out var h) ? h.GetString() : null);
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(Base64Cases))]
    public void StrictBase64MatchesSharedFixture(string content, bool valid, string? hex)
    {
        if (valid)
        {
            Assert.Equal(hex, Convert.ToHexString(PromptEnvelope.DecodeStrictBase64(content)).ToLowerInvariant());
        }
        else
        {
            Assert.Throws<FormatException>(() => PromptEnvelope.DecodeStrictBase64(content));
        }
    }
}

public class ChunkCodecTests
{
    [Fact]
    public void ResponseShorthand()
    {
        Assert.Equal("""{"type":"response","data":"hi"}""", Encoding.UTF8.GetString(AgentChunkCodec.EncodeResponse("hi")));
        var c = Assert.IsType<AgentResponseChunk>(AgentChunkCodec.Decode("""{"type":"response","data":"hi"}"""u8));
        Assert.Equal("hi", c.Text);
        Assert.Empty(c.Attachments);
    }

    [Fact]
    public void ResponseWithAttachments()
    {
        var bytes = AgentChunkCodec.EncodeResponse("t", [PromptEnvelope.CreateAttachment("x.bin", new byte[] { 1, 2 })]);
        Assert.Equal("""{"type":"response","data":{"text":"t","attachments":[{"filename":"x.bin","content":"AQI="}]}}""",
            Encoding.UTF8.GetString(bytes));
        var c = Assert.IsType<AgentResponseChunk>(AgentChunkCodec.Decode(bytes));
        Assert.Equal("x.bin", Assert.Single(c.Attachments).Name);
    }

    [Fact]
    public void StatusAndAck()
    {
        Assert.Equal("""{"type":"status","data":"ack"}""", Encoding.UTF8.GetString(AgentChunkCodec.EncodeStatus("ack")));
        Assert.True(Assert.IsType<AgentStatusChunk>(AgentChunkCodec.Decode("""{"type":"status","data":"ack"}"""u8)).IsAck);
    }

    [Fact]
    public void UnknownTypeIsDropped() => Assert.Null(AgentChunkCodec.Decode("""{"type":"future","data":1}"""u8));

    [Fact]
    public void MalformedChunkThrows()
    {
        Assert.Throws<AgentProtocolException>(() => AgentChunkCodec.Decode("nope"u8));
        Assert.Throws<AgentProtocolException>(() => AgentChunkCodec.Decode("""{"data":"x"}"""u8));
        Assert.Throws<AgentProtocolException>(() => AgentChunkCodec.Decode("""{"type":"status","data":1}"""u8));
    }

    [Fact]
    public async Task QueryRepliesExactlyOnce()
    {
        string? subject = null;
        byte[]? sent = null;
        var bytes = AgentChunkCodec.EncodeQuery("q1", "_INBOX.x", "sure?");
        var q = Assert.IsType<AgentQueryChunk>(AgentChunkCodec.Decode(bytes, (s, b, _) =>
        {
            subject = s;
            sent = b.ToArray();
            return ValueTask.CompletedTask;
        }));
        Assert.Equal("q1", q.Id);
        Assert.Equal("sure?", q.Prompt);
        await q.ReplyAsync("yes");
        Assert.Equal("_INBOX.x", subject);
        Assert.Equal("yes", Encoding.UTF8.GetString(sent!));
        Assert.True(q.Replied);
        await Assert.ThrowsAsync<QueryAlreadyRepliedException>(async () => await q.ReplyAsync("again"));
    }
}

public class PrimitivesTests
{
    [Theory]
    [InlineData("1MB", 1048576)]
    [InlineData(" 512kb ", 524288)]
    [InlineData("4GB", 4294967296)]
    [InlineData("10B", 10)]
    public void ParsesHumanBytes(string input, long expected) => Assert.Equal(expected, HumanBytes.Parse(input));

    [Theory]
    [InlineData("1 TB")]
    [InlineData("-1MB")]
    [InlineData("1.5MB")]
    [InlineData("MB")]
    public void RejectsBadHumanBytes(string input) => Assert.False(HumanBytes.TryParse(input, out _));

    [Theory]
    [InlineData(8388608, "8MB")]
    [InlineData(1536, "1536B")]
    [InlineData(2048, "2KB")]
    [InlineData(0, "0B")]
    public void FormatsHumanBytes(long bytes, string expected) => Assert.Equal(expected, HumanBytes.Format(bytes));

    [Fact]
    public void SubjectsFollowNamespace()
    {
        var s = AgentSubject.Create("demo-agent", "alice", "example");
        Assert.Equal("agents.prompt.demo-agent.alice.example", s.Prompt);
        Assert.Equal("agents.hb.demo-agent.alice.example", s.Heartbeat);
        Assert.Equal("agents.status.demo-agent.alice.example", s.Status);
        Assert.True(AgentSubject.TryParse("agents.hb.a.b.c", out var parsed, out var verb));
        Assert.Equal("hb", verb);
        Assert.Equal(("a", "b", "c"), (parsed!.Agent, parsed.Owner, parsed.Name));
    }

    [Theory]
    [InlineData("has.dot")]
    [InlineData("star*")]
    [InlineData("")]
    [InlineData("sp ace")]
    [InlineData("gt>")]
    public void InvalidTokensRejected(string token)
        => Assert.Throws<InvalidSubjectTokenException>(() => AgentSubject.Create(token, "o", "n"));

    [Fact]
    public void ProtocolVersionCompatibility()
    {
        Assert.Equal("0.3", ProtocolVersion.Sdk.ToString());
        Assert.Equal(new ProtocolVersion(0, 3), ProtocolVersion.Parse("0.3"));
        Assert.Equal(VersionCompatibility.Compatible, ProtocolVersion.Parse("0.3").CompareTo());
        Assert.NotEqual(VersionCompatibility.Compatible, ProtocolVersion.Parse("1.0").CompareTo());
        Assert.False(ProtocolVersion.TryParse("abc", out _));
    }

    [Fact]
    public void HeartbeatRoundTrips()
    {
        var hb = new HeartbeatPayload
        {
            Agent = "a", Owner = "o", Session = "s", InstanceId = "i1",
            Timestamp = HeartbeatPayload.FormatTimestamp(new DateTimeOffset(2025, 1, 2, 3, 4, 5, 678, TimeSpan.Zero)),
            IntervalSeconds = 30, ProtocolVersion = "0.3",
        };
        var back = HeartbeatPayload.TryDecode(hb.Encode())!;
        Assert.Equal("2025-01-02T03:04:05.678Z", back.Timestamp);
        Assert.Equal(hb.Agent, back.Agent);
        Assert.Equal(hb.InstanceId, back.InstanceId);
        Assert.Equal(30, back.IntervalSeconds);
        Assert.Null(HeartbeatPayload.TryDecode("{}"u8));
    }

    [Fact]
    public void AttachmentMediaTypeGuessedFromName()
    {
        Assert.Equal("image/png", PromptEnvelope.CreateAttachment("x.png", new byte[1]).MediaType);
        Assert.Equal("application/octet-stream", PromptEnvelope.CreateAttachment("x.unknownext", new byte[1]).MediaType);
    }
}

internal static class Fixtures
{
    public static string Path(params string[] parts)
        => System.IO.Path.Combine([AppContext.BaseDirectory, "fixtures", .. parts]);
}
