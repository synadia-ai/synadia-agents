// Per-instance heartbeat listener (agents.hb.*.*.*) plus a periodic liveness snapshot. Ctrl-C to stop.
#:project ../src/Synadia.AI.Agents/Synadia.AI.Agents.csproj

using NATS.Client.Core;
using Synadia.AI.Agents;

await using var nc = new NatsConnection(new NatsOpts { Url = Environment.GetEnvironmentVariable("NATS_URL") ?? "nats://127.0.0.1:4222" });
await using var agents = new AgentsClient(nc);

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

agents.Heartbeats.HeartbeatReceived += hb =>
    Console.WriteLine($"♥ {hb.Payload.Agent}/{hb.Payload.Owner} {hb.Payload.InstanceId} every {hb.Payload.IntervalSeconds}s");
await agents.Heartbeats.StartAsync(cts.Token);
Console.Error.WriteLine("listening for heartbeats — Ctrl-C to stop");

try
{
    while (!cts.IsCancellationRequested)
    {
        await Task.Delay(TimeSpan.FromSeconds(10), cts.Token);
        Console.WriteLine($"--- snapshot {DateTimeOffset.Now:T}");
        foreach (var id in agents.Heartbeats.Latest.Keys)
        {
            var l = agents.Heartbeats.GetLiveness(id);
            if (l is not null)
                Console.WriteLine($"  {id}  {(l.IsOnline ? "online " : "OFFLINE")}  last seen {l.LastSeen.ToLocalTime():T}");
        }
    }
}
catch (OperationCanceledException) { }
