// Real `.creds` connection-bundle lifecycle: reconnect keeps the immutable
// connection/signing snapshot usable; rotation retires, closes, and wipes the
// old bundle before a newly resolved credential becomes the connection identity.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agents } from "../../src/agents.js";
import { resolveNatsConnectionBundle } from "../../src/connection-bundle.js";
import { identityFromJwt } from "../../src/identity/signer.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";

const bin = await findNatsServerBinary();
const enc = new TextEncoder();

function untilReconnect(nc: NatsConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for reconnect")), 10_000);
    void (async (): Promise<void> => {
      for await (const status of nc.status()) {
        if (status.type !== "reconnect") continue;
        clearTimeout(timer);
        resolve();
        return;
      }
      clearTimeout(timer);
      reject(new Error("connection closed before reconnect"));
    })();
  });
}

describe.skipIf(!bin)("credentials connection bundle — reconnect and rotation", () => {
  const first = new NatsServerProcess();
  const second = new NatsServerProcess();
  let root = "";
  let creds = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "credentials-bundle-integration-"));
    creds = join(root, "current.creds");
    await first.start({ configPath: identityFixture("operator/operator.conf") });
    await second.start({ configPath: identityFixture("operator/operator.conf") });
  });

  afterAll(async () => {
    await first.stop();
    await second.stop();
    await rm(root, { recursive: true, force: true });
  });

  it("reconnects from captured credentials and revalidates signed identity", async () => {
    await writeFile(creds, await readFile(identityFixture("operator/alice.creds")));
    const bundle = await resolveNatsConnectionBundle(
      { url: `${first.url},${second.url}`, creds },
      { identity: "signed" },
    );
    const nc = await connect({
      ...bundle.connectionOptions,
      noRandomize: true,
      maxReconnectAttempts: 100,
      reconnectTimeWait: 50,
    });
    const agents = new Agents({ nc, identity: { signer: bundle.signer } });
    const expectedId = identityFromJwt(bundle.signer.jwt!);
    try {
      expect(await agents.selfId()).toBe(expectedId);
      const reconnected = untilReconnect(nc);
      await first.stop();
      await reconnected;
      expect(await agents.selfId()).toBe(expectedId);
      const header = await agents.signSender("events.reconnected", enc.encode("after reconnect"));
      expect(header).toContain('"sig"');
    } finally {
      await agents.close();
      await nc.close();
      bundle.wipe();
    }
    expect(bundle.signer.jwt).toBeUndefined();
    expect(bundle.connectionOptions.authenticator).toBeUndefined();
  });

  it("rotates by closing and wiping the retired bundle before resolving the replacement", async () => {
    await writeFile(creds, await readFile(identityFixture("operator/alice.creds")));
    const aliceBundle = await resolveNatsConnectionBundle(
      { url: second.url, creds },
      { identity: "signed" },
    );
    const aliceNc = await connect(aliceBundle.connectionOptions);
    const aliceAgents = new Agents({ nc: aliceNc, identity: { signer: aliceBundle.signer } });
    expect(await aliceAgents.selfId()).toBe(identityFromJwt(aliceBundle.signer.jwt!));
    await aliceAgents.close();
    await aliceNc.close();
    aliceBundle.wipe();
    expect(aliceBundle.signer.jwt).toBeUndefined();
    expect(aliceBundle.connectionOptions.authenticator).toBeUndefined();
    expect(() => aliceBundle.signer.sign(enc.encode("retired"))).toThrow(/wiped/);

    await writeFile(creds, await readFile(identityFixture("operator/bob.creds")));
    const bobBundle = await resolveNatsConnectionBundle(
      { url: second.url, creds },
      { identity: "signed" },
    );
    const bobNc = await connect(bobBundle.connectionOptions);
    const bobAgents = new Agents({ nc: bobNc, identity: { signer: bobBundle.signer } });
    try {
      expect(await bobAgents.selfId()).toBe(identityFromJwt(bobBundle.signer.jwt!));
      const header = await bobAgents.signSender("events.rotated", enc.encode("after rotation"));
      expect(header).toContain('"sig"');
    } finally {
      await bobAgents.close();
      await bobNc.close();
      bobBundle.wipe();
    }
    expect(bobBundle.signer.jwt).toBeUndefined();
  });
});
