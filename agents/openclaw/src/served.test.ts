import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { MsgHdrs, NatsConnection } from "@nats-io/nats-core";
import {
  AGENT_SENDER_HEADER,
  parseAgentId,
  parseSenderHeader,
  readSenderHeaderValue,
  signerFromSeed,
  traceRecordCounts,
  type AgentId,
  type Logger,
  type TraceScope,
} from "@synadia-ai/agents";
import {
  buildServedRecord,
  HARNESS,
  SERVED_RECORD_VERSION,
  HARNESS_ID_MAX,
  ServedPublisher,
  unixSeconds,
  validHarnessId,
} from "./served.js";

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>;
}
const keys = JSON.parse(
  readFileSync(
    new URL("../../../test-fixtures/identity/keys.json", import.meta.url),
    "utf8",
  ),
) as KeysFile;
const ALICE = keys.users["alice"]!;
const AGENT: AgentId = parseAgentId(`$G.${ALICE.public}`);
const THREAD = "0".repeat(32);
const ROOT = "f".repeat(32);
const SUBJECT = "TRACE.edges";

function decode(payload: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
}

function scope(): TraceScope {
  return { threadId: THREAD, rootId: ROOT, turnCountHint: 0 };
}

function capturingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg) => warnings.push(msg),
      error: () => undefined,
    },
  };
}

type Published = { subject: string; payload: Uint8Array; headers: MsgHdrs };

function fakeConnection(): { nc: NatsConnection; published: Published[] } {
  const published: Published[] = [];
  const nc = {
    publish: (subject: string, payload: Uint8Array, opts: { headers: MsgHdrs }) => {
      published.push({ subject, payload, headers: opts.headers });
    },
  } as unknown as NatsConnection;
  return { nc, published };
}

describe("buildServedRecord", () => {
  it("writes the start record: the thread, the prefixed harness id, no status", () => {
    const before = unixSeconds();
    const { recordId, payload } = buildServedRecord(AGENT, THREAD, ROOT, "s-1", "start");
    const { ts, ...rest } = decode(payload);
    expect(rest).toEqual({
      version: SERVED_RECORD_VERSION,
      kind: "served",
      record_id: recordId,
      agent: AGENT,
      thread_id: THREAD,
      root_id: ROOT,
      harness: HARNESS,
      harness_thread_id: "s-1",
      phase: "start",
    });
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(recordId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("writes the end record with its status and the moment given as ts", () => {
    const { payload } = buildServedRecord(AGENT, THREAD, ROOT, "s-1", "end", "error", 1_700_000_000);
    expect(decode(payload)).toMatchObject({ phase: "end", status: "error", ts: 1_700_000_000 });
  });

  it("refuses an end record without a status, a start record with one, and a bad ts", () => {
    expect(() => buildServedRecord(AGENT, THREAD, ROOT, "s", "end")).toThrow(/status/);
    expect(() => buildServedRecord(AGENT, THREAD, ROOT, "s", "start", "ok")).toThrow(/status/);
    expect(() =>
      buildServedRecord(AGENT, THREAD, ROOT, "s", "start", undefined, 1.5),
    ).toThrow(/ts/);
  });
});

describe("validHarnessId", () => {
  it("accepts a trace id and refuses what a header value can never hold", () => {
    expect(validHarnessId("9f2c4b1e8a7d33051c6e0b42d78a91f0")).toBe(true);
    expect(validHarnessId("a".repeat(HARNESS_ID_MAX))).toBe(true);
    for (const bad of [undefined, 42, "", "has space", "a\nb", "ab", "a".repeat(HARNESS_ID_MAX + 1)]) {
      expect(validHarnessId(bad)).toBe(false);
    }
  });
});

describe("ServedPublisher", () => {
  function publisher(
    overrides: Partial<ConstructorParameters<typeof ServedPublisher>[0]> = {},
  ) {
    const { nc, published } = fakeConnection();
    const { logger, warnings } = capturingLogger();
    const p = new ServedPublisher({
      nc,
      subject: SUBJECT,
      signer: signerFromSeed(ALICE.seed),
      identity: () => AGENT,
      logger,
      ...overrides,
    });
    return { p, published, warnings };
  }

  it("publishes a signed start/end pair in order: one id across body, header nonce and Nats-Msg-Id", async () => {
    const { p, published } = publisher();
    const before = traceRecordCounts();
    const arrived = unixSeconds();
    const turn = p.beginTurn(scope())!;
    turn.bind("sess-1");
    turn.settle("ok");
    await p.flush();
    expect(published.map((m) => m.subject)).toEqual([SUBJECT, SUBJECT]);
    // Signed one after another, so end never overtakes start on the wire.
    expect(published.map((m) => decode(m.payload)["phase"])).toEqual(["start", "end"]);
    const [start, end] = published.map((m) => decode(m.payload));
    expect(start).toMatchObject({
      kind: "served",
      harness_thread_id: "sess-1",
      phase: "start",
      thread_id: THREAD,
      root_id: ROOT,
    });
    expect(start!["ts"]).toBeGreaterThanOrEqual(arrived);
    expect(end).toMatchObject({ phase: "end", status: "ok", harness_thread_id: "sess-1" });
    for (const m of published) {
      const record = decode(m.payload);
      const header = parseSenderHeader(readSenderHeaderValue(m.headers) ?? "");
      expect(header?.nonce).toBe(record["record_id"]);
      expect(header?.user).toBe(ALICE.public);
      expect(header?.sub).toBe(SUBJECT);
      expect(m.headers.get(AGENT_SENDER_HEADER)).not.toBe("");
      expect(m.headers.get("Nats-Msg-Id")).toBe(record["record_id"]);
    }
    const after = traceRecordCounts();
    expect(after.published - before.published).toBe(2);
    expect(after.dropped).toBe(before.dropped);
  });

  it("keeps the arrival time on start even when the id is bound late", async () => {
    const { p, published } = publisher();
    const arrived = unixSeconds();
    const turn = p.beginTurn(scope())!;
    await new Promise((r) => setTimeout(r, 1_100));
    turn.bind("late");
    turn.settle("error");
    await p.flush();
    const [start, end] = published.map((m) => decode(m.payload));
    expect(start!["ts"]).toBeLessThanOrEqual(arrived + 1);
    expect((end!["ts"] as number) - (start!["ts"] as number)).toBeGreaterThanOrEqual(1);
    expect(end!["status"]).toBe("error");
  });

  it("binds once and refuses an unusable, repeated or late binding; never binding publishes nothing", async () => {
    const { p, published, warnings } = publisher();
    const turn = p.beginTurn(scope())!;
    turn.bind("has space");
    turn.bind("first");
    turn.bind("first");
    turn.bind("second");
    turn.settle("ok");
    turn.settle("ok");
    turn.bind("third");
    await p.flush();
    expect(published.map((m) => decode(m.payload)["harness_thread_id"])).toEqual([
      "first",
      "first",
    ]);
    expect(warnings.filter((w) => /unusable/.test(w))).toHaveLength(1);
    expect(warnings.filter((w) => /already bound/.test(w))).toHaveLength(1);
    expect(warnings.filter((w) => /after the turn ended/.test(w))).toHaveLength(1);

    const unbound = p.beginTurn(scope())!;
    unbound.settle("ok");
    await p.flush();
    expect(published).toHaveLength(2);
    // An untraced service has no scope and gets no turn at all.
    expect(p.beginTurn(undefined)).toBeUndefined();
  });

  it("publishes nothing without a signer or identity, warns once, and counts the drops", async () => {
    for (const overrides of [{ signer: undefined }, { identity: () => undefined }]) {
      const { p, published, warnings } = publisher(overrides);
      const before = traceRecordCounts();
      const turn = p.beginTurn(scope())!;
      turn.bind("sess");
      turn.settle("ok");
      await p.flush();
      expect(published).toHaveLength(0);
      expect(warnings.filter((w) => /served records are not published/.test(w))).toHaveLength(1);
      expect(traceRecordCounts().dropped - before.dropped).toBe(2);
    }
  });

  it("counts a failed publish as dropped and keeps serving", async () => {
    const { logger, warnings } = capturingLogger();
    const nc = {
      publish: vi.fn(() => {
        throw new Error("connection closed");
      }),
    } as unknown as NatsConnection;
    const p = new ServedPublisher({
      nc,
      subject: SUBJECT,
      signer: signerFromSeed(ALICE.seed),
      identity: () => AGENT,
      logger,
    });
    const before = traceRecordCounts();
    const turn = p.beginTurn(scope())!;
    turn.bind("sess");
    turn.settle("ok");
    await p.flush();
    expect(traceRecordCounts().dropped - before.dropped).toBe(2);
    expect(warnings.filter((w) => /failed to publish/.test(w))).toHaveLength(2);
  });
});
