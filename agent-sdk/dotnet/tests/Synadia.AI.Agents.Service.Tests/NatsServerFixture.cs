using NATS.Client.Core;
using Synadia.AI.Agents.Testing;

namespace Synadia.AI.Agents.Service.Tests;

/// <summary>One nats-server per test collection, on a random free port.</summary>
public sealed class NatsServerFixture : IAsyncLifetime
{
    private NatsServerProcess? _server;

    public string Url => _server?.Url ?? throw new InvalidOperationException("server not started");

    public async Task InitializeAsync() => _server = await NatsServerProcess.StartAsync();

    public async Task DisposeAsync()
    {
        if (_server is not null) await _server.DisposeAsync();
    }

    public async Task<NatsConnection> ConnectAsync()
    {
        var nc = new NatsConnection(new NatsOpts { Url = Url, Name = "dotnet-tests" });
        await nc.ConnectAsync();
        return nc;
    }
}

[CollectionDefinition(Name)]
public sealed class NatsCollection : ICollectionFixture<NatsServerFixture>
{
    public const string Name = "nats";
}

internal static class Unique
{
    private static int _n;

    /// <summary>A unique, subject-safe owner token so tests sharing a server never see each other's agents.</summary>
    public static string Owner() => $"t{Environment.ProcessId}x{Interlocked.Increment(ref _n)}";
}
