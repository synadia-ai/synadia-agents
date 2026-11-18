using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.AI;
using Synadia.AI.Agents.Testing;
using Xunit.Abstractions;

namespace Synadia.AI.Agents.Service.Tests;

/// <summary>
/// Cross-SDK wire compatibility: the .NET caller against TypeScript hosts, and the TypeScript caller against the
/// .NET host. Needs <c>bun</c> on PATH and the TS SDKs installed and built (<c>bun install &amp;&amp; bun run build</c>
/// in <c>client-sdk/typescript</c> and <c>agent-sdk/typescript</c>); without them every test returns early with a
/// note in the output, mirroring how the Python interop test skips without bun.
/// </summary>
[Collection(NatsCollection.Name)]
public sealed class InteropTests(NatsServerFixture nats, ITestOutputHelper output)
{
    private static readonly TimeSpan StartupTimeout = TimeSpan.FromSeconds(30);

    // ---- .NET caller → TS hosts ------------------------------------------------------------------------------------

    [Fact]
    public async Task DotnetCallerPromptsTsReferenceAgent()
    {
        if (!Ts.Available(output)) return;
        var owner = Unique.Owner();
        await using var ts = await BunProcess.StartAsync(Ts.ClientDir, ["run", "examples/_run-reference-agent.ts"],
            Env(("USER", owner)), "reference agent listening on ", output);

        await using var caller = await nats.ConnectAsync();
        await using var client = new AgentsClient(caller);
        var agent = Assert.Single(await client.DiscoverAsync(new AgentFilter { Agent = "demo-agent", Owner = owner }));
        Assert.Equal("0.3", agent.Info.ProtocolVersion);
        Assert.Equal(VersionCompatibility.Compatible, agent.Info.Compatibility);
        Assert.Equal($"agents.prompt.demo-agent.{owner}.example", agent.Info.PromptEndpoint.Subject);

        var resp = await agent.GetResponseAsync(new PromptEnvelope("hello"));
        Assert.Equal("demo agent received your prompt.", resp.Text);
        Assert.NotNull(await agent.PingAsync(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public async Task DotnetCallerExchangesAttachmentsAndQueriesWithTsHost()
    {
        if (!Ts.Available(output)) return;
        var owner = Unique.Owner();
        await using var ts = await BunProcess.StartAsync(Ts.ClientDir, ["run", Ts.Script, "agent", owner], Env(), "listening on ", output);

        await using var caller = await nats.ConnectAsync();
        await using var client = new AgentsClient(caller);
        var agent = Assert.Single(await client.DiscoverAsync(new AgentFilter { Agent = "ts-interop", Owner = owner }));

        var bytes = new byte[] { 0, 1, 2, 0xfe, 0xff };
        var echo = await agent.GetResponseAsync(new PromptEnvelope("files", [PromptEnvelope.CreateAttachment("blob.bin", bytes)]));
        Assert.Equal("ts echo: files [1 attachment(s): blob.bin:5]", echo.Text);
        var back = Assert.Single(echo.Attachments);
        Assert.Equal("blob.bin", back.Name);
        Assert.Equal(bytes, back.Data.ToArray());

        string? asked = null;
        var answered = await agent.GetResponseAsync(new PromptEnvelope("ask favourite colour?"), async (q, ct) =>
        {
            asked = q.Prompt;
            await q.ReplyAsync(new PromptEnvelope("teal", [new DataContent("x"u8.ToArray(), "text/plain") { Name = "a.txt" }]), ct);
        });
        Assert.Equal("favourite colour?", asked);
        Assert.Equal("you answered: teal", answered.Text);
        Assert.Equal("a.txt", Assert.Single(answered.Attachments).Name);

        // Plain-text (§5.1 shorthand) query reply.
        var plain = await agent.GetResponseAsync(new PromptEnvelope("ask again?"), (q, ct) => q.ReplyAsync("plain", ct));
        Assert.Equal("you answered: plain", plain.Text);
    }

    // ---- TS caller → .NET host -------------------------------------------------------------------------------------

    [Fact]
    public async Task TsProbePromptsDotnetReferenceAgent()
    {
        if (!Ts.Available(output)) return;
        var owner = Unique.Owner();
        await using var host = await nats.ConnectAsync();
        await using var agent = new ReferenceAgent(host, new ReferenceAgentOptions { Owner = owner });
        await agent.StartAsync();

        var (code, lines) = await BunProcess.RunAsync(Ts.ClientDir,
            ["examples/_run-client-probe.ts", "--agent", "demo-agent", "--owner", owner, "--prompt", "hello", "--timeout-s", "10"], Env(), output);
        Assert.Equal(0, code);
        Assert.Equal("echo: hello", lines.Single(l => l.GetProperty("type").GetString() == "response").GetProperty("text").GetString());
        Assert.Equal("done", lines[^1].GetProperty("type").GetString());
    }

    [Fact]
    public async Task TsCallerExchangesAttachmentsQueriesAndErrorsWithDotnetHost()
    {
        if (!Ts.Available(output)) return;
        var owner = Unique.Owner();
        await using var host = await nats.ConnectAsync();
        await using var agent = new ReferenceAgent(host, new ReferenceAgentOptions { Owner = owner });
        await agent.StartAsync();

        // Attachments both ways (the TS caller always attaches note.txt = "hi"; the .NET agent echoes it back).
        var (code, lines) = await Caller(owner, "files");
        Assert.Equal(0, code);
        var info = lines.First(l => Type(l) == "info");
        Assert.Equal("0.3", info.GetProperty("protocol_version").GetString());
        Assert.True(info.GetProperty("attachments_ok").GetBoolean());
        var resp = lines.Single(l => Type(l) == "response");
        Assert.Equal("echo: files [received 1 attachment(s): note.txt]", resp.GetProperty("text").GetString());
        Assert.Equal("note.txt:2", Assert.Single(resp.GetProperty("attachments").EnumerateArray()).GetString());

        // Mid-stream query answered by the TS caller.
        (code, lines) = await Caller(owner, "ask what is your name?", "Ada");
        Assert.Equal(0, code);
        Assert.Equal("what is your name?", lines.Single(l => Type(l) == "query").GetProperty("prompt").GetString());
        Assert.Equal("you answered: Ada", lines.Single(l => Type(l) == "response").GetProperty("text").GetString());

        // §9 error frame surfaces as a TS ServiceError with the code.
        (code, lines) = await Caller(owner, "fail 429 slow down");
        Assert.Equal(1, code);
        var err = lines.Single(l => Type(l) == "error");
        Assert.Equal(429, err.GetProperty("code").GetInt32());
        Assert.Contains("slow down", err.GetProperty("message").GetString());

        // A working status chunk reaches the TS caller too.
        (code, lines) = await Caller(owner, "slow 50");
        Assert.Equal(0, code);
        Assert.Contains(lines, l => Type(l) == "status" && l.GetProperty("status").GetString() == "working");
    }

    private Task<(int Code, List<JsonElement> Lines)> Caller(string owner, string prompt, string? answer = null)
        => BunProcess.RunAsync(Ts.ClientDir,
            answer is null ? ["run", Ts.Script, "caller", "demo-agent", owner, prompt] : ["run", Ts.Script, "caller", "demo-agent", owner, prompt, answer],
            Env(), output);

    private static string? Type(JsonElement e) => e.GetProperty("type").GetString();

    private Dictionary<string, string> Env(params (string Key, string Value)[] extra)
    {
        var env = new Dictionary<string, string> { ["NATS_URL"] = nats.Url };
        foreach (var (k, v) in extra) env[k] = v;
        return env;
    }

    /// <summary>Locates the TS SDK checkout and stages <c>interop/ts-interop.ts</c> next to its node_modules.</summary>
    private static class Ts
    {
        private static readonly Lazy<string?> Root = new(FindRepoRoot);
        private static readonly object Gate = new();
        private static bool _staged;

        public static string ClientDir => Path.Combine(Root.Value!, "client-sdk", "typescript");

        /// <summary>Path of the staged helper, relative to <see cref="ClientDir"/>.</summary>
        public static string Script => Path.Combine("node_modules", ".dotnet-interop", "ts-interop.ts");

        public static bool Available(ITestOutputHelper output)
        {
            string? reason = null;
            if (Root.Value is null) reason = "repository root not found";
            else if (!OnPath("bun")) reason = "bun not on PATH";
            else if (!File.Exists(Path.Combine(ClientDir, "node_modules", "@synadia-ai", "agent-service", "dist", "index.js"))
                     || !File.Exists(Path.Combine(ClientDir, "dist", "index.js")))
            {
                reason = "TS SDKs not installed/built (bun install && bun run build in client-sdk/typescript and agent-sdk/typescript)";
            }
            if (reason is not null)
            {
                output.WriteLine($"SKIPPED: {reason}");
                return false;
            }
            lock (Gate)
            {
                if (!_staged)
                {
                    var dest = Path.Combine(ClientDir, Script);
                    Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                    var src = Path.Combine(AppContext.BaseDirectory, "interop", "ts-interop.ts");
                    try
                    {
                        File.Copy(src, dest, overwrite: true);
                    }
                    catch (IOException) when (File.Exists(dest) && File.ReadAllText(dest) == File.ReadAllText(src))
                    {
                        // Another target framework's test process staged it concurrently.
                    }
                    _staged = true;
                }
            }
            return true;
        }

        private static string? FindRepoRoot()
        {
            for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            {
                if (Directory.Exists(Path.Combine(dir.FullName, "client-sdk", "typescript"))
                    && Directory.Exists(Path.Combine(dir.FullName, "test-fixtures")))
                {
                    return dir.FullName;
                }
            }
            return null;
        }

        private static bool OnPath(string exe)
        {
            var names = OperatingSystem.IsWindows() ? new[] { exe + ".exe", exe + ".cmd" } : [exe];
            return (Environment.GetEnvironmentVariable("PATH") ?? "")
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Any(d => names.Any(n => File.Exists(Path.Combine(d, n))));
        }
    }

    /// <summary>A bun child process: long-running (waits for a ready marker) or one-shot (collects NDJSON).</summary>
    private sealed class BunProcess : IAsyncDisposable
    {
        private readonly Process _process;

        private BunProcess(Process process) => _process = process;

        private static Process Create(string cwd, IEnumerable<string> args, IDictionary<string, string> env)
        {
            var psi = new ProcessStartInfo("bun")
            {
                WorkingDirectory = cwd,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
                UseShellExecute = false,
                StandardOutputEncoding = Encoding.UTF8,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);
            foreach (var (k, v) in env) psi.Environment[k] = v;
            psi.Environment.Remove("NATS_CONTEXT");
            return Process.Start(psi) ?? throw new InvalidOperationException("failed to start bun");
        }

        public static async Task<BunProcess> StartAsync(string cwd, string[] args, IDictionary<string, string> env, string readyMarker,
            ITestOutputHelper output)
        {
            var p = Create(cwd, args, env);
            var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            p.OutputDataReceived += (_, e) =>
            {
                if (e.Data is null) return;
                Log(output, "[bun] " + e.Data);
                if (e.Data.StartsWith(readyMarker, StringComparison.Ordinal)) ready.TrySetResult();
            };
            p.ErrorDataReceived += (_, e) => { if (e.Data is not null) Log(output, "[bun:err] " + e.Data); };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            var proc = new BunProcess(p);
            var exited = p.WaitForExitAsync();
            var winner = await Task.WhenAny(ready.Task, exited, Task.Delay(StartupTimeout));
            if (winner != ready.Task)
            {
                await proc.DisposeAsync();
                throw new TimeoutException($"bun {string.Join(' ', args)} did not print '{readyMarker}'");
            }
            return proc;
        }

        public static async Task<(int Code, List<JsonElement> Lines)> RunAsync(string cwd, string[] args, IDictionary<string, string> env,
            ITestOutputHelper output)
        {
            using var p = Create(cwd, args, env);
            p.StandardInput.Close();
            var stdout = p.StandardOutput.ReadToEndAsync();
            var stderr = p.StandardError.ReadToEndAsync();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            await p.WaitForExitAsync(cts.Token);
            var text = await stdout;
            var err = await stderr;
            Log(output, $"[bun {string.Join(' ', args)}] exit={p.ExitCode}\n{text}{err}");
            var lines = new List<JsonElement>();
            foreach (var line in (text + "\n" + err).Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (!line.StartsWith('{')) continue;
                lines.Add(JsonDocument.Parse(line).RootElement.Clone());
            }
            return (p.ExitCode, lines);
        }

        private static void Log(ITestOutputHelper output, string line)
        {
            try
            {
                output.WriteLine(line);
            }
            catch (InvalidOperationException)
            {
                // The test already finished.
            }
        }

        public async ValueTask DisposeAsync()
        {
            if (!_process.HasExited)
            {
                try
                {
                    _process.StandardInput.Close();
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                    await _process.WaitForExitAsync(cts.Token);
                }
                catch (OperationCanceledException)
                {
                    _process.Kill(entireProcessTree: true);
                }
                catch (IOException)
                {
                    _process.Kill(entireProcessTree: true);
                }
            }
            _process.Dispose();
        }
    }
}
