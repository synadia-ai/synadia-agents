using System.Text;
using System.Text.Json;
using NATS.Client.Core;
using Synadia.AI.Agents.Identity;
using Synadia.AI.Agents.Testing;

namespace Synadia.AI.Agents.Service.Tests;

internal static class IdentityKeys
{
    private static readonly JsonElement Users = Load();

    private static JsonElement Load()
    {
        using var doc = JsonDocument.Parse(File.ReadAllBytes(ConfigPath("keys.json")));
        return doc.RootElement.GetProperty("users").Clone();
    }

    public static string ConfigPath(string name) => Path.Combine(AppContext.BaseDirectory, "fixtures", "identity", name);

    public static string Public(string user) => Users.GetProperty(user).GetProperty("public").GetString()!;

    public static string Seed(string user) => Users.GetProperty(user).GetProperty("seed").GetString()!;
}

/// <summary>A nats-server started from one of the <c>test-fixtures/identity</c> configs (random port).</summary>
public abstract class IdentityServerFixture(string config) : IAsyncLifetime
{
    private NatsServerProcess? _server;

    public async Task InitializeAsync()
        => _server = await NatsServerProcess.StartAsync(["-c", IdentityKeys.ConfigPath(config)]);

    public async Task DisposeAsync()
    {
        if (_server is not null) await _server.DisposeAsync();
    }

    public async Task<NatsConnection> ConnectAsync(string user)
    {
        var nc = new NatsConnection(new NatsOpts
        {
            Url = _server!.Url,
            Name = $"dotnet-identity-{user}",
            AuthOpts = NatsAuthOpts.Default with { NKey = IdentityKeys.Public(user), Seed = IdentityKeys.Seed(user) },
        });
        await nc.ConnectAsync();
        return nc;
    }
}

public sealed class NkeyServerFixture() : IdentityServerFixture("nkey-noaccounts.conf");

public sealed class AccountsServerFixture() : IdentityServerFixture("accounts.conf");

public sealed class SenderIdentityEndToEndTests(NkeyServerFixture nats) : IClassFixture<NkeyServerFixture>
{
    private static readonly string Alice = IdentityKeys.Public("alice");

    private sealed record Harness(NatsConnection Host, NatsConnection Caller, AgentService Service, AgentsClient Client, Agent Bound,
        List<SenderInfo?> Senders) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Client.DisposeAsync();
            await Service.DisposeAsync();
            await Host.DisposeAsync();
            await Caller.DisposeAsync();
        }
    }

    private async Task<Harness> StartAsync(SenderIdentityOptions? callerIdentity, string minSenderTrust = "any",
        AgentServiceIdentityOptions? hostIdentity = null, AcceptSenderHook? accept = null)
    {
        var owner = Unique.Owner();
        var host = await nats.ConnectAsync("alice");
        var caller = await nats.ConnectAsync("alice");
        var senders = new List<SenderInfo?>();
        var service = new AgentService(host, new AgentServiceOptions
        {
            Agent = "id-agent",
            Owner = owner,
            Name = "x",
            MinSenderTrust = minSenderTrust,
            Identity = hostIdentity,
            AcceptSender = accept,
        }).OnPrompt(async (ctx, stream, ct) =>
        {
            lock (senders) senders.Add(ctx.Sender);
            await stream.WriteAsync(SenderHeader.Format(ctx.Sender), cancellationToken: ct);
        });
        await service.StartAsync();
        var client = new AgentsClient(caller, new AgentsClientOptions { Identity = callerIdentity });
        var bound = Assert.Single(await client.DiscoverAsync(new AgentFilter { Owner = owner }));
        return new Harness(host, caller, service, client, bound, senders);
    }

    [Fact]
    public async Task SignedCallerIsVerifiedOnPromptContext()
    {
        using var signer = SenderSigner.FromSeed(IdentityKeys.Seed("alice"));
        await using var h = await StartAsync(new SenderIdentityOptions { Signer = signer, Name = "dotnet caller" });

        Assert.Equal($"$G.{Alice} (verified user, claimed account)", await h.Bound.GetResponseTextAsync("hi"));
        var sender = Assert.IsType<VerifiedSender>(Assert.Single(h.Senders));
        Assert.Equal(SenderTrust.Verified, sender.Trust);
        Assert.Equal(AgentId.Create("$G", Alice), sender.Id);
        Assert.Equal("dotnet caller", sender.Name);
        Assert.Equal(h.Bound.PromptSubject, sender.Header.Sub);
        Assert.False(sender.AccountAttested);
        Assert.Equal(AgentId.Create("$G", Alice), await h.Client.GetSelfIdAsync());
    }

    [Fact]
    public async Task UnsignedClaimIsClaimedAndNoIdentityMeansNoSender()
    {
        await using (var h = await StartAsync(new SenderIdentityOptions { Name = "claimer" }))
        {
            await h.Bound.GetResponseTextAsync("hi");
            var claimed = Assert.IsType<ClaimedSender>(Assert.Single(h.Senders));
            Assert.Equal(SenderTrust.Claimed, claimed.Trust);
            Assert.Equal(Alice, claimed.User);
            Assert.Equal("claimer", claimed.Name);
        }

        await using (var h = await StartAsync(callerIdentity: null))
        {
            Assert.Equal("(no sender)", await h.Bound.GetResponseTextAsync("hi"));
            Assert.Null(Assert.Single(h.Senders));
        }
    }

    [Fact]
    public async Task MinSenderTrustSignedRefusesUnsignedCallers()
    {
        await using var h = await StartAsync(new SenderIdentityOptions(), minSenderTrust: "signed");
        Assert.Equal("signed", h.Bound.Info.PromptEndpoint.MinSenderTrust);

        // The SDK refuses locally, before publishing.
        var local = await Assert.ThrowsAsync<SenderSignatureRequiredException>(() => h.Bound.GetResponseTextAsync("hi"));
        Assert.Equal(401, local.Code);

        // A raw unsigned request is refused by the host with the TS host's code / description.
        var payload = new PromptEnvelope("hi").Encode();
        var (code, description) = await RawRequestAsync(h.Caller, h.Bound.PromptSubject, payload, null);
        Assert.Equal(401, code);
        Assert.Equal("signature required", description);

        // A signed caller is served.
        using var signer = SenderSigner.FromSeed(IdentityKeys.Seed("alice"));
        await using var signedClient = new AgentsClient(h.Caller, new AgentsClientOptions { Identity = new SenderIdentityOptions { Signer = signer } });
        var bound = Assert.Single(await signedClient.DiscoverAsync(new AgentFilter { Owner = h.Bound.Info.Owner }));
        Assert.Contains("(verified", await bound.GetResponseTextAsync("hi"), StringComparison.Ordinal);
        Assert.All(h.Senders, s => Assert.IsType<VerifiedSender>(s));
    }

    [Fact]
    public async Task ReplayedHeaderIsRejectedAndBadSignatureIs401()
    {
        await using var h = await StartAsync(callerIdentity: null);
        using var signer = SenderSigner.FromSeed(IdentityKeys.Seed("alice"));
        var payload = new PromptEnvelope("hi").Encode();
        var header = await SenderHeader.SignAsync(signer, AgentId.Create("$G", Alice), h.Bound.PromptSubject, payload);
        var headers = new NatsHeaders { [SenderHeader.HeaderName] = SenderHeader.Serialize(header) };

        Assert.Equal((null, null), await RawRequestAsync(h.Caller, h.Bound.PromptSubject, payload, headers));
        Assert.Equal((401, "sender rejected"), await RawRequestAsync(h.Caller, h.Bound.PromptSubject, payload,
            new NatsHeaders { [SenderHeader.HeaderName] = SenderHeader.Serialize(header) }));

        var other = Encoding.UTF8.GetBytes("""{"prompt":"tampered"}""");
        var fresh = await SenderHeader.SignAsync(signer, AgentId.Create("$G", Alice), h.Bound.PromptSubject, payload);
        Assert.Equal((401, "sender rejected"), await RawRequestAsync(h.Caller, h.Bound.PromptSubject, other,
            new NatsHeaders { [SenderHeader.HeaderName] = SenderHeader.Serialize(fresh) }));

        Assert.Equal((400, "malformed Agent-Sender header"), await RawRequestAsync(h.Caller, h.Bound.PromptSubject, payload,
            new NatsHeaders { [SenderHeader.HeaderName] = "{not json" }));
        Assert.IsType<VerifiedSender>(Assert.Single(h.Senders));
    }

    [Fact]
    public async Task AcceptSenderHookRefusesWith403ForVerifiedAnd401ForClaimed()
    {
        await using var h = await StartAsync(new SenderIdentityOptions(), accept: (_, _) => ValueTask.FromResult(false));
        var claimed = await Assert.ThrowsAsync<AgentServiceException>(() => h.Bound.GetResponseTextAsync("hi"));
        Assert.Equal((401, "signature required"), (claimed.Code, claimed.Description));

        using var signer = SenderSigner.FromSeed(IdentityKeys.Seed("alice"));
        await using var signedClient = new AgentsClient(h.Caller, new AgentsClientOptions { Identity = new SenderIdentityOptions { Signer = signer } });
        var bound = Assert.Single(await signedClient.DiscoverAsync(new AgentFilter { Owner = h.Bound.Info.Owner }));
        var verified = await Assert.ThrowsAsync<AgentServiceException>(() => bound.GetResponseTextAsync("hi"));
        Assert.Equal((403, "sender rejected"), (verified.Code, verified.Description));
        Assert.Empty(h.Senders);
    }

    [Fact]
    public async Task HostIdentityAdvertisesVerifiableIdSigAndSignsHeartbeats()
    {
        using var signer = SenderSigner.FromSeed(IdentityKeys.Seed("alice"));
        var owner = Unique.Owner();
        await using var host = await nats.ConnectAsync("alice");
        await using var caller = await nats.ConnectAsync("alice");
        var hbSubject = AgentSubject.Create("id-agent", owner, "x").Heartbeat;
        await using var hbSub = await caller.SubscribeCoreAsync<byte[]>(hbSubject);
        await caller.PingAsync();

        await using var service = new AgentService(host, new AgentServiceOptions
        {
            Agent = "id-agent",
            Owner = owner,
            Name = "x",
            Identity = new AgentServiceIdentityOptions { Signer = signer },
        }).OnPrompt((_, _, _) => Task.CompletedTask);
        await service.StartAsync();
        Assert.Equal(AgentId.Create("$G", Alice), service.Identity);

        await using var client = new AgentsClient(caller);
        var info = Assert.Single(await client.DiscoverAsync(new AgentFilter { Owner = owner })).Info;
        Assert.Equal(Alice, info.Metadata[AgentIdSignature.UserNkeyKey]);
        Assert.Equal("$G", info.Metadata[AgentIdSignature.AccountKey]);
        Assert.True(AgentIdSignature.Verify(info.Metadata, info.PromptEndpoint.Subject));

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var beat = await hbSub.Msgs.ReadAsync(cts.Token);
        var sender = SenderHeader.Verify(beat.Subject, beat.Data ?? [], beat.Headers,
            new SenderVerificationOptions { Mode = SenderVerificationMode.Stored });
        Assert.Equal(AgentId.Create("$G", Alice), Assert.IsType<VerifiedSender>(sender).Id);
        using var doc = JsonDocument.Parse(beat.Data!);
        Assert.Equal(doc.RootElement.GetProperty("ts").GetString(), sender.Header.Ts);
    }

    [Fact]
    public async Task HostWithoutSignerAdvertisesUnsignedIdentity()
    {
        var owner = Unique.Owner();
        await using var host = await nats.ConnectAsync("alice");
        await using var service = new AgentService(host, new AgentServiceOptions
        {
            Agent = "id-agent",
            Owner = owner,
            Name = "x",
            Identity = new AgentServiceIdentityOptions(),
            ExtraMetadata = new Dictionary<string, string> { [AgentIdSignature.IdSigKey] = "forged" },
        }).OnPrompt((_, _, _) => Task.CompletedTask);
        await service.StartAsync();
        await using var client = new AgentsClient(host);
        var info = Assert.Single(await client.DiscoverAsync(new AgentFilter { Owner = owner })).Info;
        Assert.Equal(Alice, info.Metadata[AgentIdSignature.UserNkeyKey]);
        Assert.False(info.Metadata.ContainsKey(AgentIdSignature.IdSigKey));
    }

    [Fact]
    public async Task HostSignerMismatchFailsStartup()
    {
        using var bob = SenderSigner.FromSeed(IdentityKeys.Seed("bob"));
        await using var host = await nats.ConnectAsync("alice");
        await using var service = new AgentService(host, new AgentServiceOptions
        {
            Agent = "id-agent",
            Owner = Unique.Owner(),
            Name = "x",
            Identity = new AgentServiceIdentityOptions { Signer = bob },
        }).OnPrompt((_, _, _) => Task.CompletedTask);
        await Assert.ThrowsAsync<IdentityMismatchException>(() => service.StartAsync());
        Assert.False(service.IsRunning);
    }

    internal static async Task<(int? Code, string? Description)> RawRequestAsync(NatsConnection nc, string subject, byte[] payload, NatsHeaders? headers)
    {
        var inbox = nc.NewInbox();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var sub = await nc.SubscribeCoreAsync<byte[]>(inbox, cancellationToken: cts.Token);
        await nc.PublishAsync(subject, payload, headers, replyTo: inbox, cancellationToken: cts.Token);
        await foreach (var m in sub.Msgs.ReadAllAsync(cts.Token))
        {
            if (m.Headers is { } h && h.TryGetValue("Nats-Service-Error-Code", out var c))
            {
                return (int.Parse(c.ToString(), System.Globalization.CultureInfo.InvariantCulture), h["Nats-Service-Error"].ToString());
            }
            if (m.Data is null || m.Data.Length == 0) return (null, null);
        }
        throw new TimeoutException("no terminator");
    }
}

public sealed class CrossAccountIdentityTests(AccountsServerFixture nats) : IClassFixture<AccountsServerFixture>
{
    [Fact]
    public async Task ImportedCallerIsVerifiedAndOperatorAttested()
    {
        var owner = Unique.Owner();
        await using var host = await nats.ConnectAsync("alice");
        await using var caller = await nats.ConnectAsync("bob");
        SenderInfo? seen = null;
        await using var service = new AgentService(host, new AgentServiceOptions
        {
            Agent = "id-agent",
            Owner = owner,
            Name = "x",
            OperatorAttested = true,
            MinSenderTrust = "signed",
        }).OnPrompt((ctx, _, _) =>
        {
            seen = ctx.Sender;
            return Task.CompletedTask;
        });
        await service.StartAsync();

        using var signer = SenderSigner.FromSeed(IdentityKeys.Seed("bob"));
        await using var client = new AgentsClient(caller, new AgentsClientOptions { Identity = new SenderIdentityOptions { Signer = signer } });
        Assert.Equal(AgentId.Create("APP", IdentityKeys.Public("bob")), await client.GetSelfIdAsync());
        var bound = Assert.Single(await client.DiscoverAsync(new AgentFilter { Owner = owner }));
        await bound.GetResponseTextAsync("hi");

        var verified = Assert.IsType<VerifiedSender>(seen);
        Assert.Equal(AgentId.Create("APP", IdentityKeys.Public("bob")), verified.Id);
        Assert.True(verified.AccountAttested);

        // A signature claiming another account disagrees with the server's Nats-Request-Info stamp.
        var payload = new PromptEnvelope("hi").Encode();
        var forged = await SenderHeader.SignAsync(signer, AgentId.Create("ACME", IdentityKeys.Public("bob")), bound.PromptSubject, payload);
        var result = await SenderIdentityEndToEndTests.RawRequestAsync(caller, bound.PromptSubject, payload,
            new NatsHeaders { [SenderHeader.HeaderName] = SenderHeader.Serialize(forged) });
        Assert.Equal((401, "sender rejected"), result);
    }
}
