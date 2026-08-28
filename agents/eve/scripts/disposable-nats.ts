// Disposable nats-server helper for the smoke scripts: honor NATS_URL when
// set (external broker), otherwise spawn a private nats-server on a free
// port and tear it down with the run.

import { createConnection, createServer } from "node:net";

export interface DisposableNats {
  readonly url: string;
  close(): Promise<void>;
}

export async function ensureNats(): Promise<DisposableNats> {
  const external = process.env["NATS_URL"];
  if (external) return { url: external, close: async () => {} };

  const port = await freePort();
  const url = `nats://127.0.0.1:${port}`;
  const proc = Bun.spawn(["nats-server", "-a", "127.0.0.1", "-p", String(port)], {
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await waitForPort(port, 5000);
  } catch (err) {
    proc.kill();
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    throw new Error(
      `failed to start disposable nats-server: ${(err as Error).message}${stderr ? `\n${stderr}` : ""}`,
    );
  }
  return {
    url,
    close: async () => {
      proc.kill();
      await proc.exited.catch(() => undefined);
    },
  };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) resolve(address.port);
        else reject(new Error("failed to allocate free port"));
      });
    });
    server.on("error", reject);
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port }, () => {
          socket.end();
          resolve();
        });
        socket.on("error", reject);
      });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`port ${port} not accepting connections after ${timeoutMs}ms: ${String(lastErr)}`);
}
