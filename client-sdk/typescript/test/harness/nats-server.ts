// Local `nats-server` process lifecycle for integration tests.
//
// The binary must be on PATH. We skip tests gracefully when it is not,
// rather than failing the run — that pattern is friendlier for contributors
// who haven't installed `nats-server` yet. Matches the Python SDK's approach.

import { type ChildProcess, spawn } from "node:child_process";
import { access, constants as fsc } from "node:fs/promises";
import { connect as tcpConnect, createServer } from "node:net";
import { join as joinPath } from "node:path";

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

async function findFreePort(): Promise<number> {
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

async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const s = tcpConnect({ host, port });
        s.once("connect", () => {
          s.end();
          resolve();
        });
        s.once("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`nats-server did not open port ${port} within ${timeoutMs}ms`);
}

export class NatsServerProcess {
  #proc: ChildProcess | null = null;
  #port = 0;

  get url(): string {
    if (this.#port === 0) throw new Error("NatsServerProcess.url: not started");
    return `nats://127.0.0.1:${this.#port}`;
  }

  get port(): number {
    return this.#port;
  }

  async start(): Promise<void> {
    if (this.#proc) return;
    const bin = await findNatsServerBinary();
    if (!bin) {
      throw new NatsServerNotAvailableError("binary not found on PATH");
    }
    this.#port = await findFreePort();
    this.#proc = spawn(bin, ["-a", "127.0.0.1", "-p", String(this.#port)], {
      stdio: "ignore",
      detached: false,
    });
    this.#proc.once("exit", (code, signal) => {
      if (this.#proc) {
        // unexpected exit

        console.error(`nats-server exited unexpectedly (code=${code}, signal=${signal})`);
      }
    });
    try {
      await waitForTcp("127.0.0.1", this.#port, 5_000);
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    const proc = this.#proc;
    if (!proc) return;
    this.#proc = null;
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
}
