// `loadContextOptions` ↔ nkey CONNECT integration test.
//
// Generates a real nkey user keypair via `@nats-io/nkeys`, writes the
// seed and a matching NATS CLI context file under a temp dir, then
// spawns an nkey-auth-required nats-server and verifies that
// `loadContextOptions(name)`'s `NodeConnectionOptions` connect cleanly
// while the same options stripped of the authenticator are rejected.
//
// Skipped cleanly when `nats-server` is not on PATH, mirroring the
// pattern in the rest of the integration suite.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { connect as tcpConnect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { createUser } from "@nats-io/nkeys";
import { findNatsServerBinary } from "../harness/nats-server.js";
import { loadContextOptions } from "../../src/context.js";

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

const bin = await findNatsServerBinary();

describe.skipIf(!bin)("loadContextOptions — nkey auth", () => {
  let proc: ChildProcess | null = null;
  let port = 0;
  let tmpRoot = "";
  let originalConfigHome: string | undefined;

  beforeAll(async () => {
    if (!bin) return;
    tmpRoot = await mkdtemp(join(tmpdir(), "synadia-nkey-test-"));

    // Mint a fresh user keypair. The seed bytes are the canonical
    // "SU..." text — the same string `nats nkey gen user` would write.
    const kp = createUser();
    const seedBytes = kp.getSeed();
    const publicKey = kp.getPublicKey();
    const seedPath = join(tmpRoot, "user.nk");
    await writeFile(seedPath, seedBytes);

    // Minimal nats-server config: only the user with this nkey is
    // allowed to connect. No accounts, no JWT — the simplest auth
    // surface that exercises the nonce-signing code path.
    const confPath = join(tmpRoot, "nats-server.conf");
    port = await findFreePort();
    await writeFile(
      confPath,
      `port: ${port}\n` +
        `host: "127.0.0.1"\n` +
        `authorization {\n` +
        `  users: [\n` +
        `    { nkey: "${publicKey}" }\n` +
        `  ]\n` +
        `}\n`,
    );
    proc = spawn(bin, ["-c", confPath], { stdio: "ignore" });
    await waitForTcp("127.0.0.1", port, 5_000);

    // Pretend `~/.config/nats` is `tmpRoot` for the duration of the
    // test. `loadContextOptions` reads `NATS_CONFIG_HOME` first, so
    // setting it bypasses the user's real home directory.
    originalConfigHome = process.env["NATS_CONFIG_HOME"];
    process.env["NATS_CONFIG_HOME"] = tmpRoot;
    await mkdir(join(tmpRoot, "context"), { recursive: true });
    await writeFile(
      join(tmpRoot, "context", "nkey-test.json"),
      JSON.stringify({
        description: "nkey integration test",
        url: `nats://127.0.0.1:${port}`,
        nkey: seedPath,
      }),
    );
  });

  afterAll(async () => {
    if (originalConfigHome === undefined) {
      delete process.env["NATS_CONFIG_HOME"];
    } else {
      process.env["NATS_CONFIG_HOME"] = originalConfigHome;
    }
    if (proc) {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          proc?.kill("SIGKILL");
          resolve();
        }, 2_000);
        proc!.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
      proc = null;
    }
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("resolves an nkey context to options with a working authenticator", async () => {
    const opts = await loadContextOptions("nkey-test");
    expect(opts.servers).toEqual([`nats://127.0.0.1:${port}`]);
    expect(opts.authenticator).toBeDefined();

    const nc = await connect(opts);
    try {
      // Round-trip a request to confirm the connection is actually
      // authenticated — `connect` only completes the CONNECT exchange,
      // and a subscription/publish is what proves the broker accepted us.
      const sub = nc.subscribe("nkey.test.echo", { max: 1 });
      const echoLoop = (async () => {
        for await (const m of sub) {
          m.respond(m.data);
          break;
        }
      })();
      const reply = await nc.request("nkey.test.echo", new TextEncoder().encode("hi"), {
        timeout: 1_000,
      });
      await echoLoop;
      expect(new TextDecoder().decode(reply.data)).toBe("hi");
    } finally {
      await nc.close();
    }
  });

  it("rejects a connect attempt that drops the authenticator", async () => {
    const opts = await loadContextOptions("nkey-test");
    const stripped: typeof opts = { ...opts };
    delete stripped.authenticator;

    await expect(connect({ ...stripped, reconnect: false, timeout: 1_000 })).rejects.toBeDefined();
  });
});
