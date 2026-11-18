using NATS.Client.Core;
using Synadia.AI.Agents.Identity;

namespace Synadia.AI.Agents.Service.Tests;

public sealed class SenderGateTests
{
    private const string Subject = "agents.prompt.demo-agent.alice.example";
    private static readonly string Alice = IdentityKeys.Public("alice");
    private static readonly byte[] Payload = """{"prompt":"hi"}"""u8.ToArray();

    private sealed class FixedTime(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = now;

        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static async Task<NatsHeaders> SignedAsync(string? nonce = null, string? ts = null, string account = "$G")
    {
        using var signer = SenderSigner.FromSeed(IdentityKeys.Seed("alice"));
        var header = await SenderHeader.SignAsync(signer, AgentId.Create(account, Alice), Subject, Payload, ts: ts, nonce: nonce);
        return new NatsHeaders { [SenderHeader.HeaderName] = SenderHeader.Serialize(header) };
    }

    [Fact]
    public void NonceCacheDetectsReplaysUntilTheWindowPasses()
    {
        var cache = new NonceCache(TimeSpan.FromSeconds(30));
        Assert.True(cache.Record("U", "n", tsMs: 1_000_000, nowMs: 1_000_000));
        Assert.True(cache.Has("U", "n", 1_010_000));
        Assert.False(cache.Record("U", "n", 1_000_000, 1_010_000));
        Assert.True(cache.Record("V", "n", 1_000_000, 1_010_000));
        Assert.False(cache.Has("U", "n", 1_032_000));
        Assert.Equal(0, cache.Count);
        Assert.True(cache.Record("U", "old", tsMs: 0, nowMs: 1_000_000));
        Assert.Equal(0, cache.Count);
    }

    [Fact]
    public void NonceCacheEvictsOldestBeyondTheCap()
    {
        var cache = new NonceCache(TimeSpan.FromSeconds(30), maxEntries: 2);
        Assert.True(cache.Record("U", "a", 1_000_000, 1_000_000));
        Assert.True(cache.Record("U", "b", 1_002_000, 1_002_000));
        Assert.True(cache.Record("U", "c", 1_004_000, 1_004_000));
        Assert.Equal(2, cache.Count);
        Assert.False(cache.Has("U", "a", 1_004_000));
        Assert.True(cache.Has("U", "c", 1_004_000));
    }

    [Fact]
    public async Task AdmitsVerifiedOnceAndRefusesTheReplay()
    {
        var headers = await SignedAsync(nonce: "n-1");
        var gate = new SenderGate();
        var first = await gate.AdmitPromptAsync(Subject, Payload, headers);
        Assert.True(first.Admitted);
        Assert.IsType<VerifiedSender>(first.Sender);
        var replay = await gate.AdmitPromptAsync(Subject, Payload, headers);
        Assert.Equal((false, 401, "sender rejected"), (replay.Admitted, replay.Code, replay.Description));
    }

    [Fact]
    public async Task StatusClassificationNeverRefuses()
    {
        var headers = await SignedAsync();
        var gate = new SenderGate(minSenderTrust: "signed");
        Assert.IsType<VerifiedSender>(gate.ClassifyStatus(Subject, Payload, headers));
        Assert.Null(gate.ClassifyStatus(Subject, Payload, headers));
        Assert.Null(gate.ClassifyStatus(Subject, Payload, new NatsHeaders { [SenderHeader.HeaderName] = "nope" }));
        Assert.Null(gate.ClassifyStatus(Subject, Payload, null));
    }

    [Fact]
    public async Task StaleTimestampIsRejected()
    {
        var headers = await SignedAsync(ts: "2026-08-28T12:00:00Z");
        var time = new FixedTime(DateTimeOffset.Parse("2026-08-28T12:00:31Z", System.Globalization.CultureInfo.InvariantCulture));
        var gate = new SenderGate(timeProvider: time);
        var refused = await gate.AdmitPromptAsync(Subject, Payload, headers);
        Assert.Equal((401, "sender rejected"), (refused.Code, refused.Description));
        time.Now = time.Now.AddSeconds(-2);
        Assert.True((await gate.AdmitPromptAsync(Subject, Payload, headers)).Admitted);
    }

    [Fact]
    public async Task SignedMinimumAndAcceptHookUseTheTsCodes()
    {
        var claim = new NatsHeaders { [SenderHeader.HeaderName] = SenderHeader.Serialize(SenderHeader.BuildClaim(AgentId.Create("$G", Alice))) };
        var signedGate = new SenderGate(minSenderTrust: "signed");
        var r = await signedGate.AdmitPromptAsync(Subject, Payload, claim);
        Assert.Equal((401, "signature required"), (r.Code, r.Description));
        r = await signedGate.AdmitPromptAsync(Subject, Payload, null);
        Assert.Equal((401, "signature required"), (r.Code, r.Description));

        var throwing = new SenderGate(acceptSender: (_, _) => throw new InvalidOperationException("boom"));
        r = await throwing.AdmitPromptAsync(Subject, Payload, claim);
        Assert.Equal(500, r.Code);

        var hook = new SenderGate(acceptSender: (s, _) => ValueTask.FromResult(s is ClaimedSender));
        Assert.True((await hook.AdmitPromptAsync(Subject, Payload, claim)).Admitted);
        r = await hook.AdmitPromptAsync(Subject, Payload, await SignedAsync());
        Assert.Equal((403, "sender rejected"), (r.Code, r.Description));
    }

    [Fact]
    public void OptionsAreValidated()
    {
        Assert.Throws<ArgumentException>(() => new SenderGate(minSenderTrust: "verified"));
        Assert.Throws<ArgumentException>(() => new SenderGate(replayWindow: TimeSpan.Zero));
        Assert.Throws<ArgumentException>(() => new SenderGate(accountTokenPosition: 0));
    }
}
