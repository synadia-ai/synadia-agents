// Local `nats-server` process lifecycle for integration tests.
//
// The binary must be on PATH. We skip tests gracefully when it is not,
// rather than failing the run — that pattern is friendlier for contributors
// who haven't installed `nats-server` yet. Matches the Python SDK's approach.
//
// `start()` composes three things on the command line: the `-a/-p` listen
// flags (always), an optional `-c <config>` — the repo-level identity
// fixtures under IDENTITY_FIXTURES_DIR are port-less on purpose, `-a/-p`
// supply the address, so nothing is templated — and an optional
// `-js -sd <tmpdir>` for JetStream. stderr is captured so a config the
// server rejects fails `start()` fast with the reason, instead of a bare
// 5 s timeout.
//
// Byte-identical to agent-sdk/typescript/test/harness/nats-server.ts — keep
// the two in sync.

import { type ChildProcess, spawn } from "node:child_process";
import { access, constants as fsc, mkdtemp, rm } from "node:fs/promises";
import { connect as tcpConnect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo-level identity fixtures (`test-fixtures/identity/`): throwaway nkeys
 * (`keys.json`), agent-ID parse fixtures, and port-less nats-server configs.
 *
 * Resolved from this file's URL, never from `cwd` — CI runs vitest with
 * cwd = the package dir. Four `..`: `harness/` → `test/` → `<package>/` →
 * `client-sdk/` (or `agent-sdk/`) → repo root.
 */
export const IDENTITY_FIXTURES_DIR = fileURLToPath(
  new URL("../../../../test-fixtures/identity/", import.meta.url),
);

/** Absolute path of a file under {@link IDENTITY_FIXTURES_DIR}. */
export function identityFixture(name: string): string {
  return joinPath(IDENTITY_FIXTURES_DIR, name);
}

export class NatsServerNotAvailableError extends Error {
  constructor(reason: string) {
    super(`nats-server not available: ${reason}`);
    this.name = "NatsServerNotAvailableError";
  }
}

export async function findNatsServerBinary(): Promise<string | null> {
  const pathEnv = process.env["PATH"] ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = joinPath(dir, "nats-server");
    try {
      await access(candidate, fsc.X_OK);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** A free TCP port on 127.0.0.1 (bind-to-0, read back, release). */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("unexpected socket address"));
      }
    });
  });
}

function tryTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = tcpConnect({ host, port });
    s.once("connect", () => {
      s.end();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

/**
 * Poll until `host:port` accepts a TCP connection. `abortReason`, when
 * given, is consulted on every iteration; a non-null string aborts the wait
 * with that message — used to fail fast once the server process has exited.
 */
export async function waitForTcp(
  host: string,
  port: number,
  timeoutMs: number,
  abortReason?: () => string | null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reason = abortReason?.() ?? null;
    if (reason !== null) throw new Error(reason);
    if (await tryTcp(host, port)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`nats-server did not open port ${port} within ${timeoutMs}ms`);
}

export interface NatsServerStartOptions {
  /**
   * Config file for `-c`. Fixture configs are port-less; the harness's
   * `-a/-p` flags still supply the listen address (verified on 2.12.7).
   */
  readonly configPath?: string;
  /** Enable JetStream (`-js`) on a throwaway store dir (`-sd`), removed by `stop()`. */
  readonly jetstream?: boolean;
}

/** How much of the server's stderr to keep for error messages. */
const STDERR_TAIL_BYTES = 4_096;
const START_TIMEOUT_MS = 5_000;

export class NatsServerProcess {
  #proc: ChildProcess | null = null;
  #port = 0;
  #ready = false;
  #storeDir: string | null = null;
  #stderrTail = "";

  get url(): string {
    if (this.#port === 0) throw new Error("NatsServerProcess.url: not started");
    return `nats://127.0.0.1:${this.#port}`;
  }

  get port(): number {
    return this.#port;
  }

  /** Tail of the server's stderr — config errors land here before `-l` logging starts. */
  get stderrTail(): string {
    return this.#stderrTail;
  }

  /** JetStream store dir when started with `{ jetstream: true }`, else `null`. */
  get storeDir(): string | null {
    return this.#storeDir;
  }

  async start(opts: NatsServerStartOptions = {}): Promise<void> {
    if (this.#proc) return;
    const bin = await findNatsServerBinary();
    if (!bin) {
      throw new NatsServerNotAvailableError("binary not found on PATH");
    }
    this.#port = await findFreePort();
    this.#stderrTail = "";
    this.#ready = false;
    const args = ["-a", "127.0.0.1", "-p", String(this.#port)];
    if (opts.configPath !== undefined) args.push("-c", opts.configPath);
    if (opts.jetstream) {
      this.#storeDir = await mkdtemp(joinPath(tmpdir(), "synadia-nats-js-"));
      args.push("-js", "-sd", this.#storeDir);
    }
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], detached: false });
    this.#proc = proc;
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    // `close` fires after every stdio stream has drained — awaiting it on the
    // failure path guarantees the stderr tail in the error is complete.
    const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
    proc.once("exit", (code, signal) => {
      if (this.#ready && this.#proc === proc) {
        // unexpected exit after a successful start
        console.error(
          `nats-server exited unexpectedly (code=${code}, signal=${signal})${this.#tailSuffix()}`,
        );
      }
    });
    const exited = (): string | null =>
      proc.exitCode !== null || proc.signalCode !== null
        ? `nats-server exited before listening (code=${proc.exitCode}, signal=${proc.signalCode})`
        : null;
    try {
      await waitForTcp("127.0.0.1", this.#port, START_TIMEOUT_MS, exited);
      this.#ready = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.stop();
      await Promise.race([closed, new Promise((r) => setTimeout(r, 500))]);
      throw new Error(`${message}; args: ${args.join(" ")}${this.#tailSuffix()}`);
    }
  }

  async stop(): Promise<void> {
    const proc = this.#proc;
    this.#proc = null;
    this.#ready = false;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 3_000);
        proc.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
    if (this.#storeDir) {
      await rm(this.#storeDir, { recursive: true, force: true });
      this.#storeDir = null;
    }
  }

  #tailSuffix(): string {
    const tail = this.#stderrTail.trim();
    return tail ? `\n--- nats-server stderr (tail) ---\n${tail}` : "";
  }
}
