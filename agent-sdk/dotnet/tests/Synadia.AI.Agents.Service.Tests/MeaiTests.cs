using System.Runtime.CompilerServices;
using System.Text;
using Microsoft.Extensions.AI;
using NATS.Client.Core;
using Synadia.AI.Agents.Testing;

namespace Synadia.AI.Agents.Service.Tests;

/// <summary>The MEAI seams: <c>ServeChatClient</c> on the host and <c>Agent.AsIChatClient()</c> on the caller.</summary>
[Collection(NatsCollection.Name)]
public sealed class MeaiTests(NatsServerFixture nats)
{
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(10);

    private async Task<(NatsConnection host, NatsConnection caller, AgentService service, AgentsClient client, Agent bound)> ServeAsync(
        IChatClient chatClient, ChatClientServeOptions? options = null)
    {
        var host = await nats.ConnectAsync();
        var caller = await nats.ConnectAsync();
        var owner = Unique.Owner();
        var service = new AgentService(host, new AgentServiceOptions { Agent = "meai", Owner = owner, Name = "chat" })
            .ServeChatClient(chatClient, options);
        await service.StartAsync();
        var client = new AgentsClient(caller);
        var found = await client.DiscoverAsync(new AgentFilter { Owner = owner });
        return (host, caller, service, client, Assert.Single(found));
    }

    private static async Task CleanupAsync(params IAsyncDisposable[] items)
    {
        foreach (var d in items) await d.DisposeAsync();
    }

    [Fact]
    public async Task ServeChatClientStreamsTextStatusesAndAttachmentsThroughAsIChatClient()
    {
        var model = new ScriptedChatClient(async (messages, _) =>
        {
            var user = messages.Last(m => m.Role == ChatRole.User);
            var updates = new List<ChatResponseUpdate>
            {
                // The Document-extraction convention: a content-less update carrying AdditionalProperties["synadia.status"].
                new() { Role = ChatRole.Assistant, AdditionalProperties = new() { ["synadia.status"] = "reading document" } },
                new(ChatRole.Assistant, [new AgentStatusContent("extracting")]),
                new(ChatRole.Assistant, "you said: "),
                new(ChatRole.Assistant, user.Text),
                new(ChatRole.Assistant, $" (history={messages.Count(m => m.Role == ChatRole.User)})"),
            };
            foreach (var d in user.Contents.OfType<DataContent>())
            {
                updates.Add(new ChatResponseUpdate(ChatRole.Assistant, [new DataContent(d.Data, d.MediaType) { Name = "echo-" + d.Name }]));
            }
            await Task.Yield();
            return updates;
        });
        var (host, caller, service, client, bound) = await ServeAsync(model);
        try
        {
            IChatClient chat = bound.AsIChatClient();
            var bytes = Encoding.UTF8.GetBytes("col1,col2\n1,2\n");
            var message = new ChatMessage(ChatRole.User,
                [new TextContent("summarize"), new DataContent(bytes, "text/csv") { Name = "data.csv" }]);

            var updates = new List<ChatResponseUpdate>();
            await foreach (var u in chat.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "ignored older turn"), message]))
            {
                updates.Add(u);
            }

            var statuses = updates.SelectMany(u => u.Contents.OfType<AgentStatusContent>()).Select(s => s.Status).ToList();
            Assert.Equal(["reading document", "extracting"], statuses);
            Assert.All(updates, u => Assert.Equal(bound.PromptSubject, u.ConversationId));
            Assert.Equal(ChatFinishReason.Stop, updates[^1].FinishReason);

            var response = updates.ToChatResponse();
            Assert.Equal("you said: summarize (history=1)", response.Text);
            var echoed = Assert.Single(response.Messages.SelectMany(m => m.Contents).OfType<DataContent>());
            Assert.Equal("echo-data.csv", echoed.Name);
            Assert.Equal(bytes, echoed.Data.ToArray());

            // Only the newest user message went over the wire; the host keeps the conversation.
            Assert.Equal("summarize", model.Calls[0].Last().Text);
            Assert.Equal("data.csv", model.Calls[0].Last().Contents.OfType<DataContent>().Single().Name);

            var second = await chat.GetResponseAsync([new ChatMessage(ChatRole.User, "again")]);
            Assert.Equal("you said: again (history=2)", second.Text);
            Assert.Equal(bound.PromptSubject, second.ConversationId);
            Assert.Equal("meai/" + bound.Info.Owner + "/chat", chat.GetService<ChatClientMetadata>()?.DefaultModelId);
            Assert.Same(bound, chat.GetService<Agent>());
        }
        finally
        {
            await CleanupAsync(client, service, host, caller);
        }
    }

    [Fact]
    public async Task ModelErrorContentBecomesServiceError()
    {
        var model = new ScriptedChatClient((_, _) =>
            Task.FromResult(new List<ChatResponseUpdate> { new(ChatRole.Assistant, [new ErrorContent("model overloaded")]) }));
        var (host, caller, service, client, bound) = await ServeAsync(model);
        try
        {
            var ex = await Assert.ThrowsAsync<AgentServiceException>(() => bound.AsIChatClient().GetResponseAsync([new ChatMessage(ChatRole.User, "x")]));
            Assert.Equal(500, ex.Code);
            Assert.Contains("model overloaded", ex.Message);
        }
        finally
        {
            await CleanupAsync(client, service, host, caller);
        }
    }

    [Theory]
    [InlineData("yes", true)]
    [InlineData("no thanks", false)]
    public async Task ToolApprovalRoundTripsAsQuery(string answer, bool approved)
    {
        var invoked = 0;
        var secret = AIFunctionFactory.Create((string name) =>
        {
            Interlocked.Increment(ref invoked);
            return $"secret-of-{name}";
        }, "get_secret", "Reads a secret.");
        var inner = new ScriptedChatClient((messages, _) =>
        {
            var result = messages.SelectMany(m => m.Contents).OfType<FunctionResultContent>().LastOrDefault();
            List<ChatResponseUpdate> updates = result is null
                ? [new(ChatRole.Assistant, [new FunctionCallContent("call-1", "get_secret", new Dictionary<string, object?> { ["name"] = "db" })])]
                : [new(ChatRole.Assistant, $"tool said: {result.Result}")];
            return Task.FromResult(updates);
        });
        IChatClient model = new ChatClientBuilder(inner).UseFunctionInvocation().Build();
        var options = new ChatClientServeOptions { ChatOptions = new ChatOptions { Tools = [new ApprovalRequiredAIFunction(secret)] } };
        var (host, caller, service, client, bound) = await ServeAsync(model, options);
        try
        {
            var asked = new List<string>();
            var chat = bound.AsIChatClient(new AgentChatClientOptions
            {
                QueryHandler = (q, _) =>
                {
                    asked.Add(q.Prompt);
                    return ValueTask.FromResult<string?>(answer);
                },
            });
            var response = await chat.GetResponseAsync([new ChatMessage(ChatRole.User, "what is the db secret?")]);

            Assert.Equal("Allow tool 'get_secret' with arguments {\"name\":\"db\"}? (yes/no)", Assert.Single(asked));
            Assert.Equal(approved ? 1 : 0, invoked);
            if (approved) Assert.Equal("tool said: secret-of-db", response.Text);
            else Assert.DoesNotContain("secret-of-db", response.Text);
        }
        finally
        {
            await CleanupAsync(client, service, host, caller);
        }
    }

    [Fact]
    public async Task StreamingSurfacesQueriesAsInputRequestContent()
    {
        var host = await nats.ConnectAsync();
        var caller = await nats.ConnectAsync();
        var owner = Unique.Owner();
        var service = new AgentService(host, new AgentServiceOptions { Agent = "meai", Owner = owner, Name = "ask" })
            .OnPrompt(async (ctx, stream, ct) =>
            {
                var reply = await stream.AskAsync("favourite colour?", timeout: Wait, cancellationToken: ct);
                await stream.WriteAsync($"you chose {reply.Prompt} with {reply.Attachments.Count} attachment(s)", cancellationToken: ct);
            });
        await service.StartAsync();
        var client = new AgentsClient(caller);
        try
        {
            var bound = Assert.Single(await client.DiscoverAsync(new AgentFilter { Owner = owner }));
            var text = new StringBuilder();
            await foreach (var u in bound.AsIChatClient().GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "start")]))
            {
                foreach (var c in u.Contents)
                {
                    if (c is AgentQueryContent q)
                    {
                        Assert.IsAssignableFrom<InputRequestContent>(q);
                        Assert.Equal("favourite colour?", q.Prompt);
                        await q.ReplyAsync(new ChatMessage(ChatRole.User,
                            [new TextContent("teal"), new DataContent(new byte[] { 1, 2, 3 }, "application/octet-stream") { Name = "swatch.bin" }]));
                    }
                    else if (c is TextContent t)
                    {
                        text.Append(t.Text);
                    }
                }
            }
            Assert.Equal("you chose teal with 1 attachment(s)", text.ToString());

            // Non-streaming without a QueryHandler cannot answer, so it fails fast instead of hanging.
            await Assert.ThrowsAsync<AgentException>(() => bound.AsIChatClient().GetResponseAsync([new ChatMessage(ChatRole.User, "start")]));
        }
        finally
        {
            await CleanupAsync(client, service, host, caller);
        }
    }

    [Fact]
    public async Task AsIChatClientTalksToReferenceAgent()
    {
        var host = await nats.ConnectAsync();
        var caller = await nats.ConnectAsync();
        var opts = new ReferenceAgentOptions { Owner = Unique.Owner() };
        var agent = new ReferenceAgent(host, opts);
        await agent.StartAsync();
        var client = new AgentsClient(caller);
        try
        {
            var bound = Assert.Single(await client.DiscoverAsync(new AgentFilter { Owner = opts.Owner }));
            var response = await bound.AsIChatClient().GetResponseAsync("hello");
            Assert.Equal("echo: hello", response.Text);
            Assert.Equal(ChatRole.Assistant, response.Messages.Single().Role);
        }
        finally
        {
            await CleanupAsync(client, agent, host, caller);
        }
    }

    [Fact]
    public async Task ServeChatClientProxiesRemoteAgentAndRelaysQueries()
    {
        var refConn = await nats.ConnectAsync();
        var proxyConn = await nats.ConnectAsync();
        var refOpts = new ReferenceAgentOptions { Owner = Unique.Owner() };
        var reference = new ReferenceAgent(refConn, refOpts);
        await reference.StartAsync();
        var proxyClient = new AgentsClient(proxyConn);
        try
        {
            var remote = Assert.Single(await proxyClient.DiscoverAsync(new AgentFilter { Owner = refOpts.Owner }));
            var (host, caller, service, client, bound) = await ServeAsync(remote.AsIChatClient(), new ChatClientServeOptions { KeepHistory = false });
            try
            {
                var asked = new List<string>();
                var chat = bound.AsIChatClient(new AgentChatClientOptions
                {
                    QueryHandler = (q, _) =>
                    {
                        asked.Add(q.Prompt);
                        return ValueTask.FromResult<string?>("blue");
                    },
                });
                Assert.Equal("echo: hi", (await chat.GetResponseAsync("hi")).Text);
                var response = await chat.GetResponseAsync("ask favourite colour?");
                Assert.Equal("favourite colour?", Assert.Single(asked));
                Assert.Equal("you answered: blue", response.Text);
            }
            finally
            {
                await CleanupAsync(client, service, host, caller);
            }
        }
        finally
        {
            await CleanupAsync(proxyClient, reference, refConn, proxyConn);
        }
    }

    [Fact]
    public async Task StatefulClientGetsOnlyNewMessagesAndNewestConversationId()
    {
        var n = 0;
        // A stateful service: returns a fresh conversation id on every call; asks for approval when told to.
        var inner = new ScriptedChatClient((messages, _) =>
        {
            var id = $"conv-{Interlocked.Increment(ref n)}";
            var last = messages[^1];
            List<ChatResponseUpdate> updates = last.Text == "use tool"
                ? [new(ChatRole.Assistant, [new ToolApprovalRequestContent("r1", new FunctionCallContent("c1", "tool"))]) { ConversationId = id }]
                : [new(ChatRole.Assistant, $"ok {n}") { ConversationId = id }];
            return Task.FromResult(updates);
        });
        var (host, caller, service, client, bound) = await ServeAsync(inner, new ChatClientServeOptions { Instructions = "be brief" });
        try
        {
            var chat = bound.AsIChatClient(new AgentChatClientOptions { QueryHandler = (_, _) => ValueTask.FromResult<string?>("yes") });
            await chat.GetResponseAsync("one");
            await chat.GetResponseAsync("two");
            await chat.GetResponseAsync("use tool");

            // Call 1 is stateless (system + prompt); afterwards only new messages go out, with the newest id.
            Assert.Equal([ChatRole.System, ChatRole.User], inner.Calls[0].Select(m => m.Role));
            Assert.Null(inner.Options[0]?.ConversationId);
            Assert.Equal("two", Assert.Single(inner.Calls[1]).Text);
            Assert.Equal("conv-1", inner.Options[1]!.ConversationId);
            Assert.Equal("be brief", inner.Options[1]!.Instructions);
            Assert.Equal("use tool", Assert.Single(inner.Calls[2]).Text);
            Assert.Equal("conv-2", inner.Options[2]!.ConversationId);
            // The approval round sends just the approval answer on the id returned with the request.
            var approval = Assert.IsType<ToolApprovalResponseContent>(Assert.Single(Assert.Single(inner.Calls[3]).Contents));
            Assert.True(approval.Approved);
            Assert.Equal("conv-3", inner.Options[3]!.ConversationId);
        }
        finally
        {
            await CleanupAsync(client, service, host, caller);
        }
    }

    [Fact]
    public async Task StatelessClientGetsHistoryPerCallerConversationId()
    {
        var inner = new ScriptedChatClient((messages, _) =>
            Task.FromResult<List<ChatResponseUpdate>>([new(ChatRole.Assistant, $"seen {messages.Count}")]));
        var (host, caller, service, client, bound) = await ServeAsync(inner);
        try
        {
            var chat = bound.AsIChatClient();
            var a1 = await chat.GetResponseAsync("a1", new ChatOptions { ConversationId = "A" });
            await chat.GetResponseAsync("b1", new ChatOptions { ConversationId = "B" });
            var a2 = await chat.GetResponseAsync("a2", new ChatOptions { ConversationId = "A" });
            var plain = await chat.GetResponseAsync("p1");

            Assert.Equal("A", a1.ConversationId);
            Assert.Equal(bound.PromptSubject, plain.ConversationId);
            Assert.Equal(["a1", "seen 1", "a2"], inner.Calls[2].Select(m => m.Text));
            Assert.Equal(["b1"], inner.Calls[1].Select(m => m.Text));
            Assert.Equal(["p1"], inner.Calls[3].Select(m => m.Text));
            Assert.Equal("seen 3", a2.Text);
        }
        finally
        {
            await CleanupAsync(client, service, host, caller);
        }
    }

    [Fact]
    public async Task LeastRecentlyUsedConversationIsEvictedBeyondMaxConversations()
    {
        var inner = new ScriptedChatClient((messages, _) =>
            Task.FromResult<List<ChatResponseUpdate>>([new(ChatRole.Assistant, $"seen {messages.Count}")]));
        var (host, caller, service, client, bound) = await ServeAsync(inner, new ChatClientServeOptions { MaxConversations = 2 });
        try
        {
            var chat = bound.AsIChatClient();
            await chat.GetResponseAsync("a1", new ChatOptions { ConversationId = "A" });
            await chat.GetResponseAsync("b1", new ChatOptions { ConversationId = "B" });
            await chat.GetResponseAsync("b2", new ChatOptions { ConversationId = "B" });
            await chat.GetResponseAsync("c1", new ChatOptions { ConversationId = "C" }); // evicts A, the oldest
            var b3 = await chat.GetResponseAsync("b3", new ChatOptions { ConversationId = "B" });
            var a2 = await chat.GetResponseAsync("a2", new ChatOptions { ConversationId = "A" }); // evicts C

            Assert.Equal("seen 5", b3.Text);
            Assert.Equal("seen 1", a2.Text);
            Assert.Equal(["a2"], inner.Calls[5].Select(m => m.Text));
        }
        finally
        {
            await CleanupAsync(client, service, host, caller);
        }
    }

    [Fact]
    public void OnlyNewestUserMessageAndOptionsExtrasAreSent()
    {
        var envelope = AgentChatClient.BuildEnvelope(
            [
                new ChatMessage(ChatRole.System, "sys"),
                new ChatMessage(ChatRole.User, "old"),
                new ChatMessage(ChatRole.Assistant, "reply"),
                new ChatMessage(ChatRole.User, [new TextContent("new "), new TextContent("prompt"), new DataContent(new byte[] { 9 }, "image/png") { Name = "a.png" }]),
            ],
            new ChatOptions { AdditionalProperties = new() { ["trace"] = "abc", ["n"] = 3 } });
        Assert.Equal("new prompt", envelope.Prompt);
        Assert.Equal("a.png", Assert.Single(envelope.Attachments).Name);
        Assert.Equal("abc", envelope.Extras["trace"].GetString());
        Assert.Equal(3, envelope.Extras["n"].GetInt32());
        Assert.Throws<ArgumentException>(() => AgentChatClient.BuildEnvelope([new ChatMessage(ChatRole.System, "x")], null));

        // A caller ConversationId travels as the session_id extra, unless it is just the echoed prompt subject.
        ChatMessage[] hi = [new ChatMessage(ChatRole.User, "hi")];
        Assert.Equal("conv-7", AgentChatClient.BuildEnvelope(hi, new ChatOptions { ConversationId = "conv-7" }, "agents.prompt.x.y.z").SessionId);
        Assert.Null(AgentChatClient.BuildEnvelope(hi, new ChatOptions { ConversationId = "agents.prompt.x.y.z" }, "agents.prompt.x.y.z").SessionId);
    }

    private sealed class ScriptedChatClient(Func<IReadOnlyList<ChatMessage>, ChatOptions?, Task<List<ChatResponseUpdate>>> script) : IChatClient
    {
        public List<IReadOnlyList<ChatMessage>> Calls { get; } = [];

        public List<ChatOptions?> Options { get; } = [];

        public async Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
        {
            var updates = new List<ChatResponseUpdate>();
            await foreach (var u in GetStreamingResponseAsync(messages, options, cancellationToken)) updates.Add(u);
            return updates.ToChatResponse();
        }

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            var list = messages.ToList();
            lock (Calls)
            {
                Calls.Add(list);
                Options.Add(options);
            }
            foreach (var u in await script(list, options)) yield return u;
        }

        public object? GetService(Type serviceType, object? serviceKey = null) => null;

        public void Dispose()
        {
        }
    }
}
