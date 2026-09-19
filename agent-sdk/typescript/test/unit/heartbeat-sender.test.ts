// The `Agent-Sender` header on a heartbeat: the host signs every heartbeat
// it publishes with the header of the sender-identity extension, unchanged
// — `sub` the heartbeat subject as published, `ts` the frame's own `ts`, a
// fresh nonce per beat, `sig` over subject · ts · nonce · sha256 of the
// exact bytes published. Checked here against the shared known-answer
// vector (`test-fixtures/identity/sender-vectors.json`, `signed-heartbeat`)
// byte for byte, and with the SDK's own verifier over a live frame. No
// server needed.

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AGENT_SENDER_HEADER,
  AgentSubject,
  newAgentId,
  SenderVerificationError,
  signerFromSeed,
  verifySender,
} from "@synadia-ai/agents";
import { buildHeartbeatPayload, encodeHeartbeatPayload } from "../../src/heartbeat/payload.js";
import { signHeartbeat, signHeartbeatHeader } from "../../src/heartbeat/sender.js";
import { identityFixture } from "../harness/nats-server.js";

interface SenderVector {
  readonly id: string;
  readonly input: {
    readonly user: string;
    readonly seed: string;
    readonly account: string;
    readonly subject: string;
    readonly payload_b64: string;
    readonly ts?: string;
    readonly nonce?: string;
  };
  readonly expected: { readonly header: string; readonly header_bytes: number };
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const vectors = JSON.parse(await readFile(identityFixture("sender-vectors.json"), "utf8")) as {
  readonly vectors: ReadonlyArray<SenderVector>;
};
const vector = vectors.vectors.find((v) => v.id === "signed-heartbeat");
if (vector === undefined) throw new Error("sender-vectors.json has no signed-heartbeat vector");

describe("signHeartbeat — the signed-heartbeat vector", () => {
  const signer = signerFromSeed(vector.input.seed);
  const sender = { id: newAgentId(vector.input.account, vector.input.user), signer };
  const data = new Uint8Array(Buffer.from(vector.input.payload_b64, "base64"));
  const frame = JSON.parse(dec.decode(data)) as { readonly ts: string };

  it("signs the heartbeat subject and the frame's own ts", () => {
    expect(vector.input.subject).toBe("agents.hb.demo-agent.alice.example");
    expect(frame.ts).toBe(vector.input.ts);
  });

  it("reproduces the header byte for byte", async () => {
    const hdrs = await signHeartbeat({
      sender,
      subject: vector.input.subject,
      ts: frame.ts,
      data,
      nonce: vector.input.nonce!,
    });
    expect(hdrs.values(AGENT_SENDER_HEADER)).toHaveLength(1);
    const value = hdrs.get(AGENT_SENDER_HEADER);
    expect(value).toBe(vector.expected.header);
    expect(enc.encode(value).length).toBe(vector.expected.header_bytes);
  });

  it("verifies with the SDK's verifier over the published bytes", async () => {
    const hdrs = await signHeartbeat({
      sender,
      subject: vector.input.subject,
      ts: frame.ts,
      data,
      nonce: vector.input.nonce!,
    });
    // Stored mode: the vector's ts is fixed in the past.
    const verified = await verifySender(
      { subject: vector.input.subject, data, headers: hdrs },
      "stored",
    );
    expect(verified?.trust).toBe("verified");
    if (verified?.trust !== "verified") throw new Error("unreachable");
    expect(verified.id).toBe(sender.id);
    expect(verified.header.sub).toBe(vector.input.subject);
    expect(verified.header.ts).toBe(frame.ts);
  });
});

describe("signHeartbeat — a live frame", () => {
  const signer = signerFromSeed(vector.input.seed);
  const sender = { id: newAgentId("$G", signer.publicKey), signer };
  const subject = AgentSubject.new("demo-agent", "alice", "example");

  function frame(): { payload: ReturnType<typeof buildHeartbeatPayload>; data: Uint8Array } {
    const payload = buildHeartbeatPayload(subject, 30, "demo-agent-example-1", {
      extras: { records_published: 3, records_dropped: 0 },
    });
    return { payload, data: encodeHeartbeatPayload(payload) };
  }

  it("carries the frame's own ts, the published subject, and a fresh nonce per beat", async () => {
    const { payload, data } = frame();
    const first = await signHeartbeatHeader({
      sender,
      subject: subject.heartbeat,
      ts: payload.ts,
      data,
    });
    const second = await signHeartbeatHeader({
      sender,
      subject: subject.heartbeat,
      ts: payload.ts,
      data,
    });
    for (const h of [first, second]) {
      expect(h.sub).toBe(subject.heartbeat);
      expect(h.ts).toBe(payload.ts);
      expect(h.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.sig).not.toBe(second.sig);
  });

  it("verifies live over the exact bytes and rejects a tampered frame", async () => {
    const { payload, data } = frame();
    const hdrs = await signHeartbeat({ sender, subject: subject.heartbeat, ts: payload.ts, data });
    const seen = new Set<string>();
    const verified = await verifySender(
      { subject: subject.heartbeat, data, headers: hdrs },
      "live",
      {
        nonceSeen: (user, nonce) => seen.has(`${user}.${nonce}`),
      },
    );
    expect(verified?.trust).toBe("verified");

    const tampered = enc.encode(
      dec.decode(data).replace('"records_dropped":0', '"records_dropped":1'),
    );
    expect(tampered).not.toEqual(data);
    await expect(
      verifySender({ subject: subject.heartbeat, data: tampered, headers: hdrs }, "live"),
    ).rejects.toBeInstanceOf(SenderVerificationError);
    // ... and a frame transplanted onto another agent's subject.
    await expect(
      verifySender({ subject: "agents.hb.demo-agent.alice.other", data, headers: hdrs }, "live"),
    ).rejects.toBeInstanceOf(SenderVerificationError);
  });
});
