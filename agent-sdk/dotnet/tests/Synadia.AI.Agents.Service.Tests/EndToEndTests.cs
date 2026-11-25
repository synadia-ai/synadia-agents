using System.Text;
using Microsoft.Extensions.AI;
using NATS.Client.Core;
using Synadia.AI.Agents.Testing;

namespace Synadia.AI.Agents.Service.Tests;

[Collection(NatsCollection.Name)]
public sealed class EndToEndTests(NatsServerFixture nats)
{
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(10);

    private async Task<(NatsConnection host, NatsConnection caller, ReferenceAgent agent, AgentsClient client, Agent bound)> StartReferenceAsync(
        ReferenceAgentOptions? options = null)
    {
        var host = await nats.ConnectAsync();
        var caller = await nats.ConnectAsync();
        var opts = options ?? new ReferenceAgentOptions { Owner = Unique.Owner() };
        var agent = new ReferenceAgent(host, opts);
        await agent.StartAsync();
        var client = new AgentsClient(caller);
        var found = await client.DiscoverAsync(new AgentFilter { Owner = opts.Owner });
        return (host, caller, agent, client, Assert.Single(found));
    }

    private static async Task CleanupAsync(params IAsyncDisposable[] items)
    {
        foreach (var d in items) await d.DisposeAsync();
    }

    [Fact]
    public async Task DiscoveryExposesSpecMetadata()
    {
        var (host, caller, agent, client, bound) = await StartReferenceAsync();
        try
        {
            var info = bound.Info;
            Assert.Equal("demo-agent", info.Agent);
            Assert.Equal("example", info.Name);
            Assert.Equal("0.3", info.ProtocolVersion);
            Assert.Equal(VersionCompatibility.Compatible, info.Compatibility);
            Assert.Equal(agent.Service.InstanceId, info.InstanceId);
            Assert.Equal($"agents.prompt.demo-agent.{info.Owner}.example", info.PromptEndpoint.Subject);
            Assert.Equal("agents", info.PromptEndpoint.QueueGroup);
            Assert.True(info.PromptEndpoint.AttachmentsOk);
            Assert.NotNull(info.PromptEndpoint.MaxPayloadBytes);
            Assert.Equal("any", info.PromptEndpoint.MinSenderTrust);
            Assert.Equal($"agents.status.demo-agent.{info.Owner}.example", info.StatusEndpoint?.Subject);
            Assert.Equal(info.Owner, info.Metadata["owner"]);

            Assert.NotNull(await bound.PingAsync(Wait));
            Assert.NotNull(await client.LookupAsync(info.InstanceId, Wait));
        }
        finally
        {
            await CleanupAsync(client, agent, host, caller);
        }
    }

    [Fact]
    public async Task PromptEchoesWithHistory()
    {
        var (host, caller, agent, client, bound) = await StartReferenceAsync();
        try
        {
            Assert.Equal("echo: hello", await bound.GetResponseTextAsync("hello"));
            Assert.Equal("echo: again (turn 2; you previously said: \"hello\")", await bound.GetResponseTextAsync("again"));
        }
        finally
        {
            await CleanupAsync(client, agent, host, caller);
        }
    }

    [Fact]
    public async Task AcksAreFilteredUnlessRequested()
    {
        var (host, caller, agent, client, bound) = await StartReferenceAsync();
        try
        {
            var chunks = new List<AgentChunk>();
            await foreach (var c in bound.PromptAsync("x", new PromptOptions { IncludeAcks = true })) chunks.Add(c);
            Assert.IsType<AgentStatusChunk>(chunks[0]);
            Assert.True(((AgentStatusChunk)chunks[0]).IsAck);
            Assert.Equal("echo: x", Assert.IsType<AgentResponseChunk>(chunks[^1]).Text);

            chunks.Clear();
            await foreach (var c in bound.PromptAsync("y")) chunks.Add(c);
            Assert.DoesNotContain(chunks, c => c is AgentStatusChunk { IsAck: true });
        }
        finally
        {
            await CleanupAsync(client, agent, host, caller);
        }
    }

    [Fact]
    public async Task AttachmentsRoundTrip()
    {
        var (host, caller, agent, client, bound) = await StartReferenceAsync();
        try
        {
            var png = new byte[] { 0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255 };
            var env = new PromptEnvelope("see", [PromptEnvelope.CreateAttachment("pic.png", png), new DataContent("hello"u8.ToArray(), "text/plain")]);
            var resp = await bound.GetResponseAsync(env);
            Assert.Equal("echo: see [received 2 attachment(s): pic.png, attachment-2.txt]", resp.Text);
            Assert.Equal(2, resp.Attachments.Count);
            Assert.Equal(png, resp.Attachments[0].Data.ToArray());
            Assert.Equal("image/png", resp.Attachments[0].MediaType);
            Assert.Equal("attachment-2.txt", resp.Attachments[1].Name);
        }
        finally
        {
            await CleanupAsync(client, agent, host, caller);
        }
    }

    [Fact]
    public async Task AttachmentsRejectedClientSideWhenNotOk()
    {
        var (host, caller, agent, client, bound) = await StartReferenceAsync(new ReferenceAgentOptions { Owner = Unique.Owner(), AttachmentsOk = false });
        try
        {
            Assert.False(bound.Info.PromptEndpoint.AttachmentsOk);
            var env = new PromptEnvelope("x", [PromptEnvelope.CreateAttachment("a.txt", "a"u8.ToArray())]);
            Assert.Throws<AttachmentsNotSupportedException>(() => bound.PromptAsync(env));
        }
        finally
        {
            await CleanupAsync(client, agent, host, caller);
        }
    }

    [Fact]
    public async Task PayloadTooLargeIsRejectedBeforeSending()
    {
        var (host, caller, agent, client, bound) = await StartReferenceAsync(new ReferenceAgentOptions { Owner = Unique.Owner(), MaxPayload = 1024 });
        try
        {
            Assert.Equal(1024, bound.Info.PromptEndpoint.MaxPayloadBytes);
            Assert.Throws<PayloadTooLargeException>(() => bound.PromptAsync(new string('x', 2000)));
        }
        finally
        {
            await CleanupAsync(client, agent, host, caller);
        }
    }

    [Fact]
    public async Task ErrorFrameRaisesServiceException()
    {
        var (host, caller, agent, client, bound) = await StartReferenceAsync();
        try
        {
            var ex = await Assert.ThrowsAsync<AgentServiceException>(() => bound.GetResponseTextAsync("fail 429 slow down\nplease"));
            Assert.Equal(429, ex.Code);
            Assert.Equal("slow down | please", ex.Description);

            // Stream still usable afterwards and the terminator followed the error frame (no stall).
            Assert.Equal("echo: ok", await bound.GetResponseTextAsync("ok"));
        }
        finally
        {
            await CleanupAsync(client, agent, host, caller);
        }
    }

    [Fact]
    public async Task MalformedEnvelopeGets400ThenTerminator()
    {
        var (host, caller, agent, client, bound) = await StartReferenceAsync();
        try
        {
            var inbox = caller.NewInbox();
            await using var sub = await caller.SubscribeCoreAsync<byte[]>(inbox);
            await caller.PublishAsync(bound.PromptSubject, Encoding.UTF8.GetBytes("{\"prompt\":"), replyTo: inbox);
            using var cts = new CancellationTokenSource(Wait);
            var first = await sub.Msgs.ReadAsync(cts.Token);
            Assert.Equal("400", first.Headers?["Nats-Service-Error-Code"].ToString());
            var second = await sub.Msgs.ReadAsync(cts.Token);
            Assert.True(second.Data is null or { Length: 0 });
            Assert.Null(second.Headers);
        }
        finally
        {
            await CleanupAsync(client, agent, host, caller);
        }
    }

    [Fact]
    public async Task HandlerExceptionBecomes500()
    {
        var host = await nats.ConnectAsync();
        var caller = await nats.ConnectAsync();
        var owner = Unique.Owner();
        var svc = new AgentService(host, new AgentServiceOptions { Agent = "boom", Owner = owner, Name = "x" })
            .OnPrompt((_, _, _) => throw new InvalidOperationException("secret detail"));
        await svc.StartAsync();
        var client = new AgentsClient(caller);
        try
        {
            var bound = Assert.Single(await client.DiscoverAsync(new AgentFilter { Owner = owner }));
            var ex = await Assert.ThrowsAsync<AgentServiceException>(() => bound.GetResponseTextAsync("hi"));
            Assert.Equal(500, ex.Code);
            Assert.DoesNotContain("secret", ex.Description);
        }
        finally
        {
            await CleanupAsync(client, svc, host, caller);
        }
    }

    [Fact]
    public async Task StatusEndpointReturnsHeartbeat()
    {
        var (host, caller, agent, client, bound) = await StartReferenceAsync();
        try
        {
            var hb = await bound.GetStatusAsync(Wait);
            Assert.Equal(bound.Info.InstanceId, hb.InstanceId);
            Assert.Equal("demo-agent", hb.Agent);
            Assert.Equal(5, hb.IntervalSeconds);
            Assert.Equal("0.3", hb.ProtocolVersion);
        }
        finally
        {
            await CleanupAsync(client, agent, host, caller);
        }
    }

    [Fact]
    public async Task HeartbeatsDriveLiveness()
    {
        var (host, caller, agent, client, bound) = await StartReferenceAsync(
            new ReferenceAgentOptions { Owner = Unique.Owner(), HeartbeatInterval = TimeSpan.FromMilliseconds(200) });
        try
        {
            var deadline = DateTime.UtcNow + Wait;
            while (bound.Liveness is null && DateTime.UtcNow < deadline) await Task.Delay(50);
            var live = bound.Liveness;
            Assert.NotNull(live);
            Assert.True(live!.IsOnline);
            Assert.Equal(0.2, live.IntervalSeconds, 3);
        }
        finally
        {
            await CleanupAsync(client, agent, host, caller);
        }
    }

    [Fact]
    public async Task MidStreamQueryRoundTrip()
    {
        var (host, caller, agent, client, bound) = await StartReferenceAsync();
        try
        {
            string? asked = null;
            var resp = await bound.GetResponseAsync(new PromptEnvelope("ask favourite colour?"), async (q, ct) =>
            {
                asked = q.Prompt;
                await q.ReplyAsync("blue", ct);
            });
            Assert.Equal("favourite colour?", asked);
            Assert.Equal("you answered: blue", resp.Text);
        }
        finally
        {
            await CleanupAsync(client, agent, host, caller);
        }
    }

    [Fact]
    public async Task QueryReplyWithAttachments()
    {
        var host = await nats.ConnectAsync();
        var caller = await nats.ConnectAsync();
        var owner = Unique.Owner();
        var svc = new AgentService(host, new AgentServiceOptions { Agent = "asker", Owner = owner, Name = "x" })
            .OnPrompt(async (ctx, stream, ct) =>
            {
                var answer = await stream.AskAsync("send file", timeout: Wait, cancellationToken: ct);
                await stream.WriteAsync($"{answer.Prompt}:{answer.Attachments.Count}:{answer.Attachments[0].Name}", cancellationToken: ct);
            });
        await svc.StartAsync();
        var client = new AgentsClient(caller);
        try
        {
            var bound = Assert.Single(await client.DiscoverAsync(new AgentFilter { Owner = owner }));
            var resp = await bound.GetResponseAsync(new PromptEnvelope("go"), (q, ct) =>
                q.ReplyAsync(new PromptEnvelope("here", [PromptEnvelope.CreateAttachment("f.txt", "x"u8.ToArray())]), ct));
            Assert.Equal("here:1:f.txt", resp.Text);
        }
        finally
        {
            await CleanupAsync(client, svc, host, caller);
        }
    }

    [Fact]
    public async Task UnansweredQueryTimesOutOnHost()
    {
        var (host, caller, agent, client, bound) = await StartReferenceAsync(
            new ReferenceAgentOptions { Owner = Unique.Owner(), QueryTimeout = TimeSpan.FromMilliseconds(300) });
        try
        {
            var ex = await Assert.ThrowsAsync<AgentServiceException>(() =>
                bound.GetResponseAsync(new PromptEnvelope("ask anyone?"), (_, _) => ValueTask.CompletedTask));
            Assert.Equal(500, ex.Code);
        }
        finally
        {
            await CleanupAsync(client, agent, host, caller);
        }
    }

    [Fact]
    public async Task StatusChunksSurfaceAndKeepStreamAlive()
    {
        var (host, caller, agent, client, bound) = await StartReferenceAsync();
        try
        {
            var resp = await bound.GetResponseAsync(new PromptEnvelope("slow 200"));
            Assert.Contains("working", resp.Statuses);
            Assert.Equal("echo: slow 200", resp.Text);
        }
        finally
        {
            await CleanupAsync(client, agent, host, caller);
        }
    }

    [Fact]
    public async Task StalledStreamTimesOut()
    {
        var host = await nats.ConnectAsync();
        var caller = await nats.ConnectAsync();
        var owner = Unique.Owner();
        var svc = new AgentService(host, new AgentServiceOptions { Agent = "stall", Owner = owner, Name = "x", KeepAliveInterval = null })
            .OnPrompt((_, _, ct) => Task.Delay(Timeout.Infinite, ct));
        await svc.StartAsync();
        var client = new AgentsClient(caller);
        try
        {
            var bound = Assert.Single(await client.DiscoverAsync(new AgentFilter { Owner = owner }));
            await Assert.ThrowsAsync<StreamStalledException>(() =>
                bound.GetResponseAsync(new PromptEnvelope("hi"), options: new PromptOptions { InactivityTimeout = TimeSpan.FromMilliseconds(500) }));
        }
        finally
        {
            await CleanupAsync(client, svc, host, caller);
        }
    }

    [Fact]
    public async Task KeepAliveAcksPreventStall()
    {
        var host = await nats.ConnectAsync();
        var caller = await nats.ConnectAsync();
        var owner = Unique.Owner();
        var svc = new AgentService(host, new AgentServiceOptions
        {
            Agent = "slowpoke", Owner = owner, Name = "x", KeepAliveInterval = TimeSpan.FromMilliseconds(100),
        }).OnPrompt(async (_, stream, ct) =>
        {
            await Task.Delay(800, ct);
            await stream.WriteAsync("done", cancellationToken: ct);
        });
        await svc.StartAsync();
        var client = new AgentsClient(caller);
        try
        {
            var bound = Assert.Single(await client.DiscoverAsync(new AgentFilter { Owner = owner }));
            var text = (await bound.GetResponseAsync(new PromptEnvelope("hi"),
                options: new PromptOptions { InactivityTimeout = TimeSpan.FromMilliseconds(400) })).Text;
            Assert.Equal("done", text);
        }
        finally
        {
            await CleanupAsync(client, svc, host, caller);
        }
    }

    [Fact]
    public async Task NoRespondersAfterStop()
    {
        var (host, caller, agent, client, bound) = await StartReferenceAsync();
        try
        {
            await agent.StopAsync();
            await Assert.ThrowsAsync<NoRespondersException>(() => bound.GetResponseTextAsync("anyone?"));
            Assert.Empty(await client.DiscoverAsync(new AgentFilter { Owner = bound.Info.Owner }));
        }
        finally
        {
            await CleanupAsync(client, agent, host, caller);
        }
    }

    [Fact]
    public async Task ChatResponseUpdatesMapToChunks()
    {
        var host = await nats.ConnectAsync();
        var caller = await nats.ConnectAsync();
        var owner = Unique.Owner();
        var svc = new AgentService(host, new AgentServiceOptions { Agent = "meai", Owner = owner, Name = "x" })
            .OnPrompt(async (ctx, stream, ct) =>
            {
                var msg = ctx.ToChatMessage();
                Assert.Equal(ChatRole.User, msg.Role);
                await stream.WriteAsync(new ChatResponseUpdate(ChatRole.Assistant, [new FunctionCallContent("c1", "lookup")]), cancellationToken: ct);
                await stream.WriteAsync(new ChatResponseUpdate(ChatRole.Assistant, "Hel"), cancellationToken: ct);
                await stream.WriteAsync(new ChatResponseUpdate(ChatRole.Assistant, [new TextContent("lo"), new DataContent("a"u8.ToArray(), "text/plain") { Name = "a.txt" }]),
                    cancellationToken: ct);
            });
        await svc.StartAsync();
        var client = new AgentsClient(caller);
        try
        {
            var bound = Assert.Single(await client.DiscoverAsync(new AgentFilter { Owner = owner }));
            var resp = await bound.GetResponseAsync(new PromptEnvelope("hi"));
            Assert.Equal("Hello", resp.Text);
            Assert.Equal("a.txt", Assert.Single(resp.Attachments).Name);
            Assert.Contains(resp.Statuses, s => s.Contains("lookup", StringComparison.Ordinal));
        }
        finally
        {
            await CleanupAsync(client, svc, host, caller);
        }
    }
}
