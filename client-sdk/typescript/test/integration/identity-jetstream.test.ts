// Stored mode over JetStream: `publishSigned` into a stream (`Nats-Msg-Id`
// = nonce), a consumer verifies the header against the *stored* subject
// with `verifySenderHeader(…, { mode: "stored" })` — freshness skipped,
// identity proven. The stream's de-duplication window catches a copy
// inside the window; a copy after it verifies too and is only caught by
// consumer-side `(user, nonce)` dedupe (documented). A client-set
// `Nats-Request-Info` is not stored. Renamed-import variant: the stored
// subject is the exporter's, so the caller signs it (`sub`).

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { headers, nanos, nkeyAuthenticator, type NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_SENDER_HEADER,
  Agents,
  NATS_MSG_ID_HEADER,
  newAgentId,
  parseSenderHeader,
  readSenderHeaderValue,
  SenderVerificationError,
  signerFromSeed,
  verifySenderHeader,
  type SenderInfo,
} from "../../src/index.js";
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
const ALICE = keys.users["alice"]!;
const BOB = keys.users["bob"]!;
const DUPE_WINDOW_MS = 1_000;

function connectAs(url: string, seed: string): Promise<NatsConnection> {
  return connect({
    servers: url,
    authenticator: nkeyAuthenticator(enc.encode(seed)),
    reconnect: false,
  });
}

interface Stored {
  readonly subject: string;
  readonly data: Uint8Array;
  readonly msgId: string | undefined;
  readonly requestInfo: string | undefined;
  readonly sender: SenderInfo | undefined;
  readonly error: unknown;
}

/** Read every message of `stream` and classify each in stored mode. */
async function readAll(
  nc: NatsConnection,
  jsm: JetStreamManager,
  stream: string,
): Promise<Stored[]> {
  const info = await jsm.streams.info(stream);
  const out: Stored[] = [];
  const consumer = await jetstream(nc).consumers.get(stream);
  for (let i = 0; i < info.state.messages; i++) {
    const m = await consumer.next({ expires: 2_000 });
    if (!m) break;
    let sender: SenderInfo | undefined;
    let error: unknown;
    try {
      const value = readSenderHeaderValue(m.headers);
      const header = value === undefined ? null : parseSenderHeader(value);
      if (header) sender = await verifySenderHeader(header, m.subject, m.data, { mode: "stored" });
    } catch (err) {
      error = err;
    }
    out.push({
      subject: m.subject,
      data: m.data,
      msgId: m.headers?.get(NATS_MSG_ID_HEADER) || undefined,
      requestInfo: m.headers?.get("Nats-Request-Info") || undefined,
      sender,
      error,
    });
    m.ack();
  }
  return out;
}

describe.skipIf(!bin)("identity — JetStream stored mode (nkey user, $G)", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;
  let jsm: JetStreamManager;
  let agents: Agents;

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("nkey-noaccounts.conf"), jetstream: true });
    nc = await connectAs(server.url, ALICE.seed);
    jsm = await jetstreamManager(nc);
    await jsm.streams.add({
      name: "IDENT",
      subjects: ["js.identity.>"],
      duplicate_window: nanos(DUPE_WINDOW_MS),
    });
    agents = new Agents({
      nc,
      identity: { signer: signerFromSeed(ALICE.seed), name: "publisher" },
    });
  });

  afterAll(async () => {
    await agents.close();
    await nc.close();
    await server.stop();
  });

  it("publishSigned stores a verifiable record; a duplicate inside the window is dropped; a copy after it verifies too", async () => {
    const payload = enc.encode(JSON.stringify({ event: "hello" }));
    await agents.publishSigned("js.identity.a", payload);
    await nc.flush();
    let stored = await readAll(nc, jsm, "IDENT");
    expect(stored).toHaveLength(1);
    const first = stored[0]!;
    expect(first.error).toBeUndefined();
    expect(first.sender).toMatchObject({
      trust: "verified",
      id: newAgentId("$G", ALICE.public),
      name: "publisher",
    });
    expect(first.msgId).toBe(first.sender!.header.nonce);
    expect(first.subject).toBe("js.identity.a");

    // Same headers (same Nats-Msg-Id) republished inside the window: not stored.
    const dupe = headers();
    dupe.set(
      AGENT_SENDER_HEADER,
      readSenderHeaderValue((await jsm.streams.getMessage("IDENT", { seq: 1 }))!.header)!,
    );
    dupe.set(NATS_MSG_ID_HEADER, first.msgId!);
    nc.publish("js.identity.a", payload, { headers: dupe });
    await nc.flush();
    expect((await jsm.streams.info("IDENT")).state.messages).toBe(1);

    // After the window the copy is stored and verifies: stored mode proves
    // authorship of content, not uniqueness — consumers dedupe on (user, nonce).
    await new Promise((r) => setTimeout(r, DUPE_WINDOW_MS + 300));
    nc.publish("js.identity.a", payload, { headers: dupe });
    await nc.flush();
    stored = await readAll(nc, jsm, "IDENT");
    expect(stored).toHaveLength(2);
    expect(stored[1]!.sender).toMatchObject({ trust: "verified" });
    expect(stored[1]!.sender!.header.nonce).toBe(stored[0]!.sender!.header.nonce);
  });

  it("a client-set Nats-Request-Info is not stored, even same-account", async () => {
    const h = headers();
    h.set("Nats-Request-Info", JSON.stringify({ acc: "FAKE" }));
    h.set(AGENT_SENDER_HEADER, await agents.signSender("js.identity.b", "x"));
    nc.publish("js.identity.b", enc.encode("x"), { headers: h });
    await nc.flush();
    const stored = await readAll(nc, jsm, "IDENT");
    const b = stored.find((s) => s.subject === "js.identity.b")!;
    expect(b.requestInfo).toBeUndefined();
    expect(b.sender?.trust).toBe("verified");
  });

  it("a stored record with a tampered payload fails stored-mode verification", async () => {
    const value = await agents.signSender("js.identity.c", "original");
    const h = headers();
    h.set(AGENT_SENDER_HEADER, value);
    nc.publish("js.identity.c", enc.encode("tampered"), { headers: h });
    await nc.flush();
    const stored = await readAll(nc, jsm, "IDENT");
    const c = stored.find((s) => s.subject === "js.identity.c")!;
    expect(c.sender).toBeUndefined();
    expect(c.error).toBeInstanceOf(SenderVerificationError);
    expect((c.error as SenderVerificationError).code).toBe(401);
  });
});

describe.skipIf(!bin)("identity — JetStream behind a renamed import", () => {
  const server = new NatsServerProcess();
  let dir = "";
  let alice: NatsConnection;
  let bob: NatsConnection;
  let jsm: JetStreamManager;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "synadia-js-accounts-"));
    // Not a shared fixture: the shared `accounts.conf` exports `agents.>`
    // and `$SRV.>` only, and JetStream must be enabled per account.
    const conf = join(dir, "js-accounts.conf");
    await writeFile(
      conf,
      [
        "accounts {",
        "  ACME {",
        "    jetstream: enabled",
        `    users: [ { nkey: "${ALICE.public}" } ]`,
        '    exports: [ { service: "js.>" } ]',
        "  }",
        "  APP {",
        `    users: [ { nkey: "${BOB.public}" } ]`,
        '    imports: [ { service: { account: ACME, subject: "js.>" }, to: "local.js.>" } ]',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    await server.start({ configPath: conf, jetstream: true });
    alice = await connectAs(server.url, ALICE.seed);
    bob = await connectAs(server.url, BOB.seed);
    jsm = await jetstreamManager(alice);
    await jsm.streams.add({ name: "RENAMED", subjects: ["js.identity.>"] });
  });

  afterAll(async () => {
    await alice.close();
    await bob.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("the stored subject is the exporter's: the caller signs it via `sub`; a naive publishSigned fails stored-mode verification", async () => {
    const agents = new Agents({ nc: bob, identity: { signer: signerFromSeed(BOB.seed) } });
    try {
      const payload = enc.encode("from APP");
      await agents.publishSigned("local.js.identity.b", payload, { sub: "js.identity.b" });
      await agents.publishSigned("local.js.identity.naive", payload);
      await bob.flush();
      const stored = await readAll(alice, jsm, "RENAMED");
      expect(stored.map((s) => s.subject)).toEqual(["js.identity.b", "js.identity.naive"]);
      expect(stored[0]!.sender).toMatchObject({
        trust: "verified",
        id: newAgentId("APP", BOB.public),
      });
      expect(stored[1]!.sender).toBeUndefined();
      expect((stored[1]!.error as SenderVerificationError).detail).toMatch(/arrival subject/);
    } finally {
      await agents.close();
    }
  });
});
