using System.Runtime.InteropServices;
using NATS.Client.Core;
using NATS.NKeys;
using Synadia.AI.Agents.Identity;
using Synadia.AI.Agents.Service;

namespace Synadia.AI.Agents.Examples;

/// <summary>
/// CLI + environment → NATS connection, agent identity and shutdown for the numbered host examples. Mirrors the Python
/// examples' <c>_connect_cli.py</c> and the TypeScript examples' <c>_connection.ts</c>, so every ladder rung is configured
/// the same way in all three languages:
/// <list type="bullet">
/// <item><c>--url</c> / <c>$NATS_URL</c>, else <c>nats://127.0.0.1:4222</c>.</item>
/// <item><c>--nkey</c> / <c>$NATS_NKEY_SEED_FILE</c> or <c>--creds</c> / <c>$NATS_CREDS</c> (<c>$NATS_CREDENTIALS</c>)
/// authenticate that connection; the nkey wins when both env vars are set.</item>
/// <item><c>--sender-identity signed</c> / <c>$NATS_SENDER_IDENTITY=signed</c> derives the registration signer from the
/// same seed or creds file (default <c>off</c>).</item>
/// <item><c>--owner</c> / <c>--session-name</c>, else <c>$SYNADIA_&lt;AGENT&gt;_OWNER</c> &gt; <c>$SYNADIA_OWNER</c> &gt;
/// <c>$NATS_AGENT_OWNER</c> &gt; your user name &gt; <c>anon</c> (and the <c>_NAME</c> analogue, default <c>main</c>).</item>
/// <item><c>--heartbeat-interval</c> / <c>$NATS_AGENT_HEARTBEAT_INTERVAL</c> in seconds (default 30; 0 means unset).</item>
/// </list>
/// NATS CLI contexts (<c>--context</c> / <c>$NATS_CONTEXT</c>) are not supported: neither NATS.Net nor this SDK reads
/// context files yet.
/// </summary>
public sealed class ExampleHost : IAsyncDisposable
{
    private const string DefaultUrl = "nats://127.0.0.1:4222";
    private const int DefaultHeartbeatSeconds = 30;

    private readonly SenderSigner? _signer;

    private ExampleHost(NatsConnection connection, SenderSigner? signer, string agent, string owner, string name, TimeSpan heartbeat,
        string url, IReadOnlySet<string> switches)
    {
        Connection = connection;
        _signer = signer;
        Agent = agent;
        Owner = owner;
        Name = name;
        HeartbeatInterval = heartbeat;
        Url = url;
        Switches = switches;
    }

    /// <summary>The open NATS connection; disposed with this host.</summary>
    public NatsConnection Connection { get; }

    /// <summary>The <c>agent</c> token this example registers as.</summary>
    public string Agent { get; }

    /// <summary>The resolved <c>owner</c> token.</summary>
    public string Owner { get; }

    /// <summary>The resolved instance <c>name</c> token.</summary>
    public string Name { get; }

    /// <summary>The resolved heartbeat cadence.</summary>
    public TimeSpan HeartbeatInterval { get; }

    /// <summary>The NATS server URL that was dialled.</summary>
    public string Url { get; }

    /// <summary>The example-specific boolean switches (e.g. <c>--think</c>) that were passed.</summary>
    public IReadOnlySet<string> Switches { get; }

    /// <summary>Whether example-specific <paramref name="flag"/> was passed.</summary>
    public bool Has(string flag) => Switches.Contains(flag);

    /// <summary>
    /// Parse <paramref name="args"/> and the environment, then connect. Prints usage and exits on <c>-h</c>/<c>--help</c>
    /// (code 0) or on an invalid flag (code 2). <paramref name="switches"/> lists the extra boolean flags the example accepts.
    /// </summary>
    public static async Task<ExampleHost> ConnectAsync(string[] args, string agent, string description,
        IReadOnlyDictionary<string, string>? switches = null)
    {
        switches ??= new Dictionary<string, string>();
        var cli = Parse(args, agent, description, switches);

        var url = cli.Get("--url") ?? Env("NATS_URL") ?? DefaultUrl;

        var nkeyFlag = cli.Get("--nkey");
        var credsFlag = cli.Get("--creds");
        if (nkeyFlag is not null && credsFlag is not null) Fail(agent, description, switches, "--nkey and --creds are mutually exclusive");
        string? nkeyFile = nkeyFlag, credsFile = credsFlag;
        if (nkeyFile is null && credsFile is null)
        {
            nkeyFile = Env("NATS_NKEY_SEED_FILE");
            if (nkeyFile is null) credsFile = Env("NATS_CREDS") ?? Env("NATS_CREDENTIALS");
        }

        var identity = cli.Get("--sender-identity") ?? Env("NATS_SENDER_IDENTITY") ?? "off";
        if (identity is not ("off" or "signed")) Fail(agent, description, switches, "--sender-identity / NATS_SENDER_IDENTITY must be 'off' or 'signed'");
        if (identity == "signed" && nkeyFile is null && credsFile is null)
            Fail(agent, description, switches, "signed sender identity needs a user seed: pass --nkey <seed-file> or --creds <creds-file>");

        var token = agent.ToUpperInvariant().Replace('-', '_');
        var owner = cli.Get("--owner") ?? Env($"SYNADIA_{token}_OWNER") ?? Env("SYNADIA_OWNER") ?? Env("NATS_AGENT_OWNER");
        if (owner is null)
        {
            var user = Env("USER") ?? Env("USERNAME");
            owner = AgentSubject.IsValidToken(user) ? user! : "anon";
        }
        var name = cli.Get("--session-name") ?? Env($"SYNADIA_{token}_NAME") ?? Env("SYNADIA_NAME") ?? Env("NATS_AGENT_NAME") ?? "main";
        if (!AgentSubject.IsValidToken(owner)) Fail(agent, description, switches, $"owner '{owner}' is not a valid subject token");
        if (!AgentSubject.IsValidToken(name)) Fail(agent, description, switches, $"session name '{name}' is not a valid subject token");

        var heartbeatSeconds = DefaultHeartbeatSeconds;
        if (cli.Get("--heartbeat-interval") is { } hbFlag)
        {
            if (!int.TryParse(hbFlag, out heartbeatSeconds) || heartbeatSeconds <= 0)
                Fail(agent, description, switches, "--heartbeat-interval must be a positive number of seconds");
        }
        else if (int.TryParse(Env("NATS_AGENT_HEARTBEAT_INTERVAL"), out var hbEnv) && hbEnv > 0)
        {
            heartbeatSeconds = hbEnv;
        }

        // A bare seed file (as nk and the Python/TS examples use). NATS.Net's own NKeyFile option also wants the public
        // key in the file, so read the seed and derive the public key here.
        string? seed = null;
        if (nkeyFile is not null)
        {
            seed = File.ReadLines(nkeyFile).Select(l => l.Trim()).FirstOrDefault(l => l.StartsWith("SU", StringComparison.Ordinal));
            if (seed is null) Fail(agent, description, switches, $"no user seed (SU…) found in {nkeyFile}");
        }

        SenderSigner? signer = null;
        if (identity == "signed")
            signer = seed is not null ? SenderSigner.FromSeed(seed) : SenderSigner.FromCredsFile(credsFile!);

        var auth = NatsAuthOpts.Default;
        if (seed is not null)
        {
            using var keyPair = KeyPair.FromSeed(seed);
            auth = auth with { NKey = keyPair.GetPublicKey(), Seed = seed };
        }
        else if (credsFile is not null) auth = auth with { CredsFile = credsFile };

        var connection = new NatsConnection(new NatsOpts { Url = url, AuthOpts = auth, Name = $"{agent}-example" });
        try
        {
            await connection.ConnectAsync();
        }
        catch (Exception ex) when (ex is NatsException or OperationCanceledException)
        {
            await connection.DisposeAsync();
            signer?.Dispose();
            Console.Error.WriteLine($"error: cannot connect to NATS at {url}: {ex.Message}");
            Environment.Exit(1);
            throw; // unreachable
        }
        return new ExampleHost(connection, signer, agent, owner, name, TimeSpan.FromSeconds(heartbeatSeconds), url, cli.Switches);
    }

    /// <summary>
    /// <see cref="AgentServiceOptions"/> for this example: agent/owner/name, heartbeat and (in signed mode) the identity.
    /// </summary>
    public AgentServiceOptions ServiceOptions(string description) => new()
    {
        Agent = Agent,
        Owner = Owner,
        Name = Name,
        Description = description,
        HeartbeatInterval = HeartbeatInterval,
        Identity = _signer is null ? null : new AgentServiceIdentityOptions { Signer = _signer },
    };

    /// <summary>Completes on Ctrl+C or SIGTERM.</summary>
    public static async Task WaitForShutdownAsync()
    {
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; done.TrySetResult(); };
        using var sigterm = PosixSignalRegistration.Create(PosixSignal.SIGTERM, ctx => { ctx.Cancel = true; done.TrySetResult(); });
        await done.Task;
        Console.WriteLine();
        Console.WriteLine("shutting down…");
    }

    /// <summary>Close NATS first, then wipe the signing key.</summary>
    public async ValueTask DisposeAsync()
    {
        try
        {
            await Connection.DisposeAsync();
        }
        finally
        {
            _signer?.Dispose();
        }
    }

    private static string? Env(string name) => Environment.GetEnvironmentVariable(name) is { Length: > 0 } v ? v : null;

    private static readonly string[] ValueFlags = ["--url", "--nkey", "--creds", "--sender-identity", "--owner", "--session-name", "--heartbeat-interval"];

    private sealed record Cli(Dictionary<string, string> Values, HashSet<string> Switches)
    {
        public string? Get(string flag) => Values.TryGetValue(flag, out var v) ? v : null;
    }

    private static Cli Parse(string[] args, string agent, string description, IReadOnlyDictionary<string, string> switches)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        var present = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (arg is "-h" or "--help")
            {
                Console.WriteLine(Usage(agent, description, switches));
                Environment.Exit(0);
            }
            var flag = arg;
            string? inline = null;
            var eq = arg.IndexOf('=');
            if (arg.StartsWith("--", StringComparison.Ordinal) && eq > 0) (flag, inline) = (arg[..eq], arg[(eq + 1)..]);

            if (ValueFlags.Contains(flag))
            {
                var value = inline ?? (i + 1 < args.Length ? args[++i] : null);
                if (string.IsNullOrEmpty(value)) Fail(agent, description, switches, $"{flag} needs a value");
                values[flag] = value!;
            }
            else if (switches.ContainsKey(flag) && inline is null)
            {
                present.Add(flag);
            }
            else
            {
                Fail(agent, description, switches, $"unknown argument '{arg}'");
            }
        }
        return new Cli(values, present);
    }

    private static string Usage(string agent, string description, IReadOnlyDictionary<string, string> switches)
    {
        var extra = string.Concat(switches.Select(s => $"\n  {s.Key,-28}{s.Value}"));
        return $"""
            {description}

            options:
              --url <url>                 NATS server URL (default: $NATS_URL, else {DefaultUrl})
              --nkey <seed-file>          authenticate with a user NKEY seed file (default: $NATS_NKEY_SEED_FILE)
              --creds <creds-file>        authenticate with a credentials file (default: $NATS_CREDS)
              --sender-identity <mode>    off | signed — sign the registration with the same seed/creds (default: $NATS_SENDER_IDENTITY, else off)
              --owner <owner>             owner token (default: $SYNADIA_{agent.ToUpperInvariant().Replace('-', '_')}_OWNER > $SYNADIA_OWNER > $NATS_AGENT_OWNER > your user name)
              --session-name <name>       instance name token (default: the _NAME analogue, else main)
              --heartbeat-interval <s>    heartbeat cadence in seconds (default: $NATS_AGENT_HEARTBEAT_INTERVAL, else {DefaultHeartbeatSeconds}){extra}
              -h, --help                  show this help
            """;
    }

    [System.Diagnostics.CodeAnalysis.DoesNotReturn]
    private static void Fail(string agent, string description, IReadOnlyDictionary<string, string> switches, string message)
    {
        Console.Error.WriteLine($"error: {message}");
        Console.Error.WriteLine();
        Console.Error.WriteLine(Usage(agent, description, switches));
        Environment.Exit(2);
    }
}
