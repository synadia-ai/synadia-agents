// Signed heartbeats through `AgentService`: with a live-bound signer every
// heartbeat the service publishes carries a verifying `Agent-Sender` —
// `sub` the heartbeat subject, `ts` the frame's own, the nonce fresh per
// beat — and the status reply carries none. Without a signer, whether host
// identity is omitted or registered unsigned, the frame goes out bare, as
// plain protocol 0.3.

import { readFile } from "node:fs/promises";
import { nkeyAuthenticator, type Msg, type NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodeHeartbeatPayload,
  newAgentId,
  readSenderHeaderValue,
  signerFromSeed,
  verifySender,
  type Logger,
  type SenderSigner,
} from "@synadia-ai/agents";
import { AgentService, type AgentServiceOptions } from "../../src/service.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>;
}

const bin = await findNatsServerBinary();
const keys = JSON.parse(await readFile(identityFixture("keys.json"), "utf8")) as KeysFile;
const enc = new TextEncoder();
const dec = new TextDecoder();
const ALICE = keys.users["alice"]!;

/**
 * A signer whose `sign()` waits at a gate the test opens — a stand-in for a
 * remote HSM that is slower than the heartbeat interval. `calls` counts
 * every `sign()` that started, open gate or not.
 */
function gatedSigner(seed: string): {
  readonly signer: SenderSigner;
  readonly calls: () => number;
  close: () => void;
  open: () => void;
} {
  const inner = signerFromSeed(seed);
  let calls = 0;
  let gate: Promise<void> = Promise.resolve();
  let release: () => void = () => undefined;
  const signer: SenderSigner = {
    publicKey: inner.publicKey,
    async sign(data: Uint8Array): Promise<Uint8Array> {
      calls++;
      await gate;
      return inner.sign(data);
    },
  };
  return {
    signer,
    calls: () => calls,
    close: () => {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    open: () => release(),
  };
}

function capturingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const noop = (): void => undefined;
  return {
    warnings,
    logger: {
      debug: noop,
      info: noop,
      warn: (msg: string): void => {
        warnings.push(msg);
      },
      error: noop,
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function connectAs(url: string, seed: string): Promise<NatsConnection> {
  return connect({
    servers: url,
    authenticator: nkeyAuthenticator(enc.encode(seed)),
    reconnect: false,
  });
}

describe.skipIf(!bin)("AgentService — signed heartbeats (nkey user, $G)", () => {
  const server = new NatsServerProcess();
  let hostNc: NatsConnection;
  let probeNc: NatsConnection;

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("nkey-noaccounts.conf") });
    hostNc = await connectAs(server.url, ALICE.seed);
    probeNc = await connectAs(server.url, ALICE.seed);
  });

  afterAll(async () => {
    await probeNc.close();
    await hostNc.close();
    await server.stop();
  });

  /** Start a service, collect `count` beats and one status reply, stop it. */
  async function observe(
    name: string,
    options: Partial<AgentServiceOptions>,
    count: number,
  ): Promise<{ readonly beats: Msg[]; readonly status: Msg; readonly service: AgentService }> {
    const service = new AgentService({
      nc: hostNc,
      agent: "hb-signed",
      owner: "alice",
      name,
      heartbeatIntervalS: 1,
      keepaliveIntervalS: null,
      ...options,
    });
    service.onPrompt(async (_envelope, response) => {
      await response.send("ok");
    });
    const sub = probeNc.subscribe(service.subject.heartbeat);
    await probeNc.flush();
    await service.start();
    try {
      const beats: Msg[] = [];
      for await (const m of sub) {
        beats.push(m);
        if (beats.length === count) break;
      }
      const status = await probeNc.request(service.subject.status, new Uint8Array(0), {
        timeout: 2_000,
      });
      return { beats, status, service };
    } finally {
      sub.unsubscribe();
      await service.stop();
    }
  }

  it("signs every beat with the id_sig signer: sub the subject, ts the frame's, a fresh nonce", async () => {
    const { beats, status, service } = await observe(
      "signed",
      { identity: { signer: signerFromSeed(ALICE.seed) } },
      2,
    );
    expect(service.identity).toBe(newAgentId("$G", ALICE.public));
    const seen = new Set<string>();
    for (const m of beats) {
      const frame = decodeHeartbeatPayload(JSON.parse(dec.decode(m.data)));
      if (!frame) throw new Error("malformed heartbeat frame");
      // The SDK's own verifier, live mode, over the bytes as they arrived.
      const verified = await verifySender(m, "live", {
        nonceSeen: (user, nonce) => seen.has(`${user}.${nonce}`),
      });
      expect(verified?.trust).toBe("verified");
      if (verified?.trust !== "verified") throw new Error("unreachable");
      expect(verified.id).toBe(service.identity);
      expect(verified.header.sub).toBe(m.subject);
      expect(verified.header.sub).toBe(service.subject.heartbeat);
      expect(verified.header.ts).toBe(frame.ts);
      expect(verified.header.name).toBeUndefined();
      seen.add(`${verified.header.user}.${verified.header.nonce}`);
    }
    expect(seen.size).toBe(beats.length);
    // The status reply builds the same frame but is not a heartbeat: no header.
    expect(readSenderHeaderValue(status.headers)).toBeUndefined();
    expect(decodeHeartbeatPayload(JSON.parse(dec.decode(status.data)))).toBeDefined();
  });

  it("skips a tick while the previous beat is still being signed, and keeps beats in order", async () => {
    const gated = gatedSigner(ALICE.seed);
    const { logger, warnings } = capturingLogger();
    const service = new AgentService({
      nc: hostNc,
      agent: "hb-signed",
      owner: "alice",
      name: "slow-signer",
      heartbeatIntervalS: 1,
      keepaliveIntervalS: null,
      identity: { signer: gated.signer },
      logger,
    });
    service.onPrompt(async (_envelope, response) => {
      await response.send("ok");
    });
    const sub = probeNc.subscribe(service.subject.heartbeat);
    await probeNc.flush();
    await service.start(); // id_sig and the first beat, signed with the gate open
    try {
      const base = gated.calls();
      // Close the gate: the beat at tick 1 starts signing and waits. Tick 2
      // finds it pending and is skipped — no further sign() call starts.
      gated.close();
      await sleep(2_400);
      expect(gated.calls()).toBe(base + 1);
      expect(warnings.filter((w) => w.startsWith("heartbeat skipped"))).not.toHaveLength(0);
      // Open the gate: the pending beat goes out, then the loop resumes.
      gated.open();
      const beats: Msg[] = [];
      for await (const m of sub) {
        beats.push(m);
        if (beats.length === 3) break;
      }
      const frames = beats.map((m) => decodeHeartbeatPayload(JSON.parse(dec.decode(m.data))));
      const seen = new Set<string>();
      for (const [i, m] of beats.entries()) {
        const verified = await verifySender(m, "live", {
          nonceSeen: (user, nonce) => seen.has(`${user}.${nonce}`),
        });
        expect(verified?.trust).toBe("verified");
        if (verified?.trust !== "verified") throw new Error("unreachable");
        seen.add(`${verified.header.user}.${verified.header.nonce}`);
        expect(verified.header.ts).toBe(frames[i]!.ts);
        if (i > 0) {
          expect(Date.parse(frames[i]!.ts)).toBeGreaterThanOrEqual(Date.parse(frames[i - 1]!.ts));
        }
      }
    } finally {
      gated.open();
      sub.unsubscribe();
      await service.stop();
    }
  });

  it("stop() returns without waiting for a busy signer, and that beat never publishes", async () => {
    const gated = gatedSigner(ALICE.seed);
    const service = new AgentService({
      nc: hostNc,
      agent: "hb-signed",
      owner: "alice",
      name: "stop-race",
      heartbeatIntervalS: 1,
      keepaliveIntervalS: null,
      identity: { signer: gated.signer },
    });
    service.onPrompt(async (_envelope, response) => {
      await response.send("ok");
    });
    // A callback subscription: a NATS subscription iterates only once, and
    // this test looks at it twice.
    const received: Msg[] = [];
    const sub = probeNc.subscribe(service.subject.heartbeat, {
      callback: (_err, m) => {
        received.push(m);
      },
    });
    await probeNc.flush();
    await service.start();
    try {
      while (received.length === 0) await sleep(20);
      expect(readSenderHeaderValue(received[0]!.headers)).toBeDefined();
      const base = gated.calls();
      // Tick 1 starts a beat that waits at the closed gate; stop() must not.
      gated.close();
      await sleep(1_300);
      expect(gated.calls()).toBe(base + 1);
      const outcome = await Promise.race([
        service.stop().then(() => "stopped"),
        sleep(500).then(() => "timeout"),
      ]);
      expect(outcome).toBe("stopped");
      // The signer finishes after teardown began: that beat is dropped.
      gated.open();
      await sleep(700);
      expect(received).toHaveLength(1);
    } finally {
      gated.open();
      sub.unsubscribe();
      await service.stop();
    }
  });

  it("beats bare with an unsigned registration", async () => {
    const { beats, status, service } = await observe("claimed", { identity: {} }, 1);
    expect(service.identity).toBe(newAgentId("$G", ALICE.public));
    for (const m of [...beats, status]) {
      expect(readSenderHeaderValue(m.headers)).toBeUndefined();
      expect(await verifySender(m, "live")).toBeUndefined();
    }
  });

  it("beats bare without host identity", async () => {
    const { beats, status, service } = await observe("plain", {}, 1);
    expect(service.identity).toBeUndefined();
    for (const m of [...beats, status]) {
      expect(readSenderHeaderValue(m.headers)).toBeUndefined();
    }
  });
});
