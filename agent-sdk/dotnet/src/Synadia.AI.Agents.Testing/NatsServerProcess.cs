using System.Diagnostics;
using System.Net;
using System.Net.Sockets;

namespace Synadia.AI.Agents.Testing;

/// <summary>
/// Starts a throw-away <c>nats-server</c> (must be on PATH, or set <c>NATS_SERVER_BIN</c>) bound to
/// 127.0.0.1 on a random free port. Intended for integration tests and local demos; never uses 4222.
/// </summary>
public sealed class NatsServerProcess : IAsyncDisposable
{
    private readonly Process _process;

    private NatsServerProcess(Process process, int port)
    {
        _process = process;
        Port = port;
    }

    /// <summary>The TCP port the server listens on.</summary>
    public int Port { get; }

    /// <summary><c>nats://127.0.0.1:{Port}</c>.</summary>
    public string Url => $"nats://127.0.0.1:{Port}";

    /// <summary>The <c>nats-server</c> executable that will be used.</summary>
    public static string Executable => Environment.GetEnvironmentVariable("NATS_SERVER_BIN") is { Length: > 0 } bin ? bin : "nats-server";

    /// <summary>True when <see cref="Executable"/> can be launched.</summary>
    public static bool IsAvailable()
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo(Executable, "--version")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            });
            if (p is null) return false;
            p.WaitForExit(10_000);
            return p.ExitCode == 0;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>Start a server and wait until it accepts TCP connections.</summary>
    /// <param name="extraArgs">Additional command-line arguments (e.g. <c>-c path.conf</c>).</param>
    /// <param name="cancellationToken">Cancels the startup wait.</param>
    public static async Task<NatsServerProcess> StartAsync(IEnumerable<string>? extraArgs = null, CancellationToken cancellationToken = default)
    {
        for (var attempt = 0; ; attempt++)
        {
            var port = GetFreePort();
            var psi = new ProcessStartInfo(Executable)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add("-a");
            psi.ArgumentList.Add("127.0.0.1");
            psi.ArgumentList.Add("-p");
            psi.ArgumentList.Add(port.ToString(System.Globalization.CultureInfo.InvariantCulture));
            foreach (var a in extraArgs ?? []) psi.ArgumentList.Add(a);

            var process = Process.Start(psi) ?? throw new InvalidOperationException($"could not start {Executable}");
            process.OutputDataReceived += static (_, _) => { };
            process.ErrorDataReceived += static (_, _) => { };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            var server = new NatsServerProcess(process, port);
            if (await WaitForPortAsync(process, port, cancellationToken).ConfigureAwait(false)) return server;
            await server.DisposeAsync().ConfigureAwait(false);
            if (attempt >= 4) throw new InvalidOperationException("nats-server did not start (port race?)");
        }
    }

    private static async Task<bool> WaitForPortAsync(Process process, int port, CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (process.HasExited) return false;
            try
            {
                using var client = new TcpClient();
                await client.ConnectAsync(IPAddress.Loopback, port, cancellationToken).ConfigureAwait(false);
                return true;
            }
            catch (SocketException)
            {
                await Task.Delay(50, cancellationToken).ConfigureAwait(false);
            }
        }
        return false;
    }

    private static int GetFreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        try
        {
            if (!_process.HasExited)
            {
                _process.Kill(entireProcessTree: true);
                await _process.WaitForExitAsync().ConfigureAwait(false);
            }
        }
        catch (InvalidOperationException)
        {
        }
        _process.Dispose();
    }
}
