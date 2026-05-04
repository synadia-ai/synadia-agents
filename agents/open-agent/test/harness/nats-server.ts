// Lightweight `nats-server` lifecycle helper for the integration test.
// Mirrors the structure used in agent-sdk/typescript/test/harness/, but
// trimmed to what bun:test needs (no vitest globalSetup).

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

async function findNatsServerBinary(): Promise<string | null> {
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

  async start(): Promise<void> {
    if (this.#proc) return;
    const bin = await findNatsServerBinary();
    if (!bin) {
      throw new NatsServerNotAvailableError("binary not found on PATH");
    }
    this.#port = await findFreePort();
    const proc = spawn(bin, ["-a", "127.0.0.1", "-p", String(this.#port)], {
      stdio: "ignore",
      detached: false,
    });
    proc.once("exit", (code, signal) => {
      if (this.#proc === proc) {
        console.error(`nats-server exited unexpectedly (code=${code}, signal=${signal})`);
      }
    });
    this.#proc = proc;
    await waitForTcp("127.0.0.1", this.#port, 5_000);
  }

  async stop(): Promise<void> {
    const proc = this.#proc;
    if (!proc) return;
    this.#proc = null;
    proc.kill("SIGKILL");
    await new Promise((resolve) => {
      proc.once("exit", () => resolve(undefined));
      setTimeout(resolve, 250);
    });
  }
}
