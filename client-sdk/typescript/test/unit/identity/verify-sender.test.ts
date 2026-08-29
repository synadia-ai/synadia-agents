// `verifySender(msg, mode)` over a structural message, the
// `Nats-Request-Info` stamp parser, and the operator-attested cross-check
// (spec Appendix A) — no server.

import { readFile } from "node:fs/promises";
import { headers, type MsgHdrs } from "@nats-io/nats-core";
import { describe, expect, it } from "vitest";
import { identityFixture } from "../../harness/nats-server.js";
import { newAgentId } from "../../../src/identity/agent-id.js";
import {
  NATS_REQUEST_INFO_HEADER,
  parseRequestInfo,
  readRequestInfo,
} from "../../../src/identity/request-info.js";
import {
  AGENT_SENDER_HEADER,
  buildClaimHeader,
  formatSenderTimestamp,
  serializeSenderHeader,
  signSenderHeader,
  verifySender,
  verifySenderHeader,
  type VerifySenderMsgOptions,
} from "../../../src/identity/sender-header.js";
import { signerFromSeed } from "../../../src/identity/signer.js";
import { MalformedSenderHeaderError, SenderVerificationError } from "../../../src/errors.js";

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>;
}
const keys = JSON.parse(await readFile(identityFixture("keys.json"), "utf8")) as KeysFile;
const alice = signerFromSeed(keys.users["alice"]!.seed);
const BOB_PUBLIC = keys.users["bob"]!.public;
const aliceId = newAgentId("ACME", alice.publicKey);
const enc = new TextEncoder();
const SUBJECT = "agents.prompt.demo.acme.main";
const PAYLOAD = enc.encode('{"prompt":"hello"}');
const STALE_TS = formatSenderTimestamp(Date.now() - 120_000);

function withHeaders(entries: Record<string, string | string[]>): MsgHdrs {
  const h = headers();
  for (const [k, v] of Object.entries(entries)) {
    if (Array.isArray(v)) for (const x of v) h.append(k, x);
    else h.set(k, v);
  }
  return h;
}

function msg(hdrs?: MsgHdrs, subject = SUBJECT, data = PAYLOAD) {
  return { subject, data, ...(hdrs ? { headers: hdrs } : {}) };
}

async function signedValue(
  overrides: Partial<Parameters<typeof signSenderHeader>[0]> = {},
): Promise<string> {
  return serializeSenderHeader(
    await signSenderHeader({
      signer: alice,
      id: aliceId,
      sub: SUBJECT,
      payload: PAYLOAD,
      ...overrides,
    }),
  );
}

async function rejection(p: Promise<unknown>): Promise<SenderVerificationError> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SenderVerificationError);
  return err as SenderVerificationError;
}

const stamp = (o: Record<string, unknown>): string => JSON.stringify(o);

describe("parseRequestInfo / readRequestInfo", () => {
  it("reads acc and user, ignores every other field", () => {
    expect(
      parseRequestInfo(stamp({ acc: "APP", user: BOB_PUBLIC, rtt: 12, server: "n1", jwt: "x" })),
    ).toEqual({ account: "APP", user: BOB_PUBLIC });
    expect(parseRequestInfo(stamp({ acc: "APP2", rtt: 1 }))).toEqual({ account: "APP2" });
    expect(parseRequestInfo(stamp({}))).toEqual({});
  });

  it("malformed → null: not JSON, not an object, acc / user of the wrong type", () => {
    expect(parseRequestInfo("{bad")).toBeNull();
    expect(parseRequestInfo("[]")).toBeNull();
    expect(parseRequestInfo('"APP"')).toBeNull();
    expect(parseRequestInfo(stamp({ acc: 7 }))).toBeNull();
    expect(parseRequestInfo(stamp({ acc: "APP", user: null }))).toBeNull();
  });

  it("readRequestInfo: absent → undefined; two values → null; header name is exact-case", () => {
    expect(readRequestInfo(undefined)).toBeUndefined();
    expect(readRequestInfo(headers())).toBeUndefined();
    expect(readRequestInfo(withHeaders({ "nats-request-info": stamp({ acc: "APP" }) }))).toBe(
      undefined,
    );
    expect(
      readRequestInfo(withHeaders({ [NATS_REQUEST_INFO_HEADER]: stamp({ acc: "APP" }) })),
    ).toEqual({ account: "APP" });
    expect(
      readRequestInfo(
        withHeaders({ [NATS_REQUEST_INFO_HEADER]: [stamp({ acc: "APP" }), stamp({ acc: "APP" })] }),
      ),
    ).toBeNull();
    expect(readRequestInfo(withHeaders({ [NATS_REQUEST_INFO_HEADER]: "{bad" }))).toBeNull();
  });
});

describe("verifySender(msg, mode)", () => {
  it("no header, unknown v, or a differently-cased name → undefined", async () => {
    expect(await verifySender(msg(), "live")).toBeUndefined();
    expect(await verifySender(msg(headers()), "live")).toBeUndefined();
    const v2 = JSON.stringify({ v: 2, account: "ACME", user: alice.publicKey });
    expect(await verifySender(msg(withHeaders({ [AGENT_SENDER_HEADER]: v2 })), "live")).toBe(
      undefined,
    );
    expect(
      await verifySender(msg(withHeaders({ "agent-sender": await signedValue() })), "live"),
    ).toBeUndefined();
  });

  it("a claim → ClaimedSender (no id); a signed header → VerifiedSender against msg.subject / msg.data", async () => {
    const claim = serializeSenderHeader(buildClaimHeader({ id: aliceId, name: "cli" }));
    const claimed = await verifySender(msg(withHeaders({ [AGENT_SENDER_HEADER]: claim })), "live");
    expect(claimed?.trust).toBe("claimed");
    expect(claimed && "id" in claimed).toBe(false);

    const verified = await verifySender(
      msg(withHeaders({ [AGENT_SENDER_HEADER]: await signedValue({ name: "cli" }) })),
      "live",
    );
    expect(verified).toMatchObject({
      trust: "verified",
      id: aliceId,
      name: "cli",
      accountAttested: false,
    });
    expect(await (verified as { resolve(): Promise<unknown> }).resolve()).toBeUndefined();
  });

  it("malformed → MalformedSenderHeaderError; another subject or payload → 401", async () => {
    await expect(
      verifySender(msg(withHeaders({ [AGENT_SENDER_HEADER]: "{bad" })), "live"),
    ).rejects.toBeInstanceOf(MalformedSenderHeaderError);
    const h = withHeaders({ [AGENT_SENDER_HEADER]: await signedValue() });
    expect(
      (await rejection(verifySender(msg(h, "agents.prompt.demo.acme.other"), "live"))).code,
    ).toBe(401);
    expect((await rejection(verifySender(msg(h, SUBJECT, enc.encode("x")), "live"))).code).toBe(
      401,
    );
  });

  it("stored mode skips freshness: a stale ts verifies; live rejects it", async () => {
    const h = withHeaders({ [AGENT_SENDER_HEADER]: await signedValue({ ts: STALE_TS }) });
    expect((await verifySender(msg(h), "stored"))?.trust).toBe("verified");
    expect((await rejection(verifySender(msg(h), "live"))).detail).toMatch(/^ts /);
  });

  it("passes the options through: nonceSeen, resolver, accountTokenPosition", async () => {
    const h = withHeaders({ [AGENT_SENDER_HEADER]: await signedValue({ nonce: "n1" }) });
    const seen: string[] = [];
    const opts: VerifySenderMsgOptions = {
      nonceSeen: (user, nonce) => {
        seen.push(`${user}.${nonce}`);
        return false;
      },
      resolver: (id) => Promise.resolve({ instanceId: `resolved:${id}` } as never),
    };
    const s = await verifySender(msg(h), "live", opts);
    expect(seen).toEqual([`${alice.publicKey}.n1`]);
    expect(await (s as { resolve(): Promise<{ instanceId: string }> }).resolve()).toEqual({
      instanceId: `resolved:${aliceId}`,
    });

    const inserted = withHeaders({
      [AGENT_SENDER_HEADER]: await signedValue({ sub: "svc.prompt" }),
    });
    const viaToken = await verifySender(msg(inserted, "svc.ACME.prompt"), "live", {
      accountTokenPosition: 2,
    });
    expect(viaToken).toMatchObject({ trust: "verified", accountAttested: false });
  });
});

describe("operator-attested cross-check (Nats-Request-Info)", () => {
  const forged = stamp({ acc: "EVIL", user: BOB_PUBLIC });

  it("off by default: the stamp is never read — a forged one changes nothing", async () => {
    const h = withHeaders({
      [AGENT_SENDER_HEADER]: await signedValue(),
      [NATS_REQUEST_INFO_HEADER]: forged,
    });
    expect(await verifySender(msg(h), "live")).toMatchObject({
      trust: "verified",
      accountAttested: false,
    });
  });

  it("on, no stamp: verified, compared to nothing, accountAttested=false", async () => {
    const h = withHeaders({ [AGENT_SENDER_HEADER]: await signedValue() });
    expect(await verifySender(msg(h), "live", { operatorAttested: true })).toMatchObject({
      trust: "verified",
      accountAttested: false,
    });
  });

  it("on, acc agrees (with or without user, the no-share shape) → accountAttested=true", async () => {
    for (const s of [
      stamp({ acc: "ACME", rtt: 3 }),
      stamp({ acc: "ACME", user: alice.publicKey }),
    ]) {
      const h = withHeaders({
        [AGENT_SENDER_HEADER]: await signedValue(),
        [NATS_REQUEST_INFO_HEADER]: s,
      });
      expect(await verifySender(msg(h), "live", { operatorAttested: true })).toMatchObject({
        trust: "verified",
        id: aliceId,
        accountAttested: true,
      });
    }
  });

  it("on, acc or user disagrees → 401 (detail names the field); the nonce lookup never ran", async () => {
    let lookedUp = 0;
    const opts: VerifySenderMsgOptions = {
      operatorAttested: true,
      nonceSeen: () => {
        lookedUp++;
        return false;
      },
    };
    const accWrong = withHeaders({
      [AGENT_SENDER_HEADER]: await signedValue(),
      [NATS_REQUEST_INFO_HEADER]: stamp({ acc: "EVIL", user: alice.publicKey }),
    });
    const e1 = await rejection(verifySender(msg(accWrong), "live", opts));
    expect(e1.code).toBe(401);
    expect(e1.description).toBe("sender rejected");
    expect(e1.detail).toMatch(/Nats-Request-Info acc "EVIL" disagrees/);

    const userWrong = withHeaders({
      [AGENT_SENDER_HEADER]: await signedValue(),
      [NATS_REQUEST_INFO_HEADER]: stamp({ acc: "ACME", user: BOB_PUBLIC }),
    });
    const e2 = await rejection(verifySender(msg(userWrong), "live", opts));
    expect(e2.detail).toMatch(/Nats-Request-Info user .* disagrees/);
    expect(lookedUp).toBe(0);
  });

  it("on, a stamp the server would not write (malformed, or two of them) → 401", async () => {
    for (const ri of [
      "{bad",
      stamp({ acc: 7 }),
      [stamp({ acc: "ACME" }), stamp({ acc: "ACME" })],
    ]) {
      const h = withHeaders({
        [AGENT_SENDER_HEADER]: await signedValue(),
        [NATS_REQUEST_INFO_HEADER]: ri,
      });
      const e = await rejection(verifySender(msg(h), "live", { operatorAttested: true }));
      expect(e.code).toBe(401);
      expect(e.detail).toMatch(/not a server stamp/);
    }
  });

  it("on, an unsigned claim is never cross-checked (a forged stamp leaves it a claim)", async () => {
    const h = withHeaders({
      [AGENT_SENDER_HEADER]: serializeSenderHeader(buildClaimHeader({ id: aliceId })),
      [NATS_REQUEST_INFO_HEADER]: forged,
    });
    expect((await verifySender(msg(h), "live", { operatorAttested: true }))?.trust).toBe("claimed");
  });

  it("on, the accountTokenPosition cross-check attests the account without a stamp — live and stored", async () => {
    const h = withHeaders({ [AGENT_SENDER_HEADER]: await signedValue({ sub: "svc.prompt" }) });
    for (const mode of ["live", "stored"] as const) {
      expect(
        await verifySender(msg(h, "svc.ACME.prompt"), mode, {
          accountTokenPosition: 2,
          operatorAttested: true,
        }),
      ).toMatchObject({ trust: "verified", accountAttested: true });
    }
    // The same request without the mode: verified, but only the sender's word on the account.
    expect(
      await verifySender(msg(h, "svc.ACME.prompt"), "live", { accountTokenPosition: 2 }),
    ).toMatchObject({ trust: "verified", accountAttested: false });
  });

  it("verifySenderHeader takes the stamp through opts.headers; without headers nothing is attested", async () => {
    const header = await signSenderHeader({
      signer: alice,
      id: aliceId,
      sub: SUBJECT,
      payload: PAYLOAD,
    });
    const bare = await verifySenderHeader(header, SUBJECT, PAYLOAD, {
      mode: "live",
      operatorAttested: true,
    });
    expect(bare).toMatchObject({ trust: "verified", accountAttested: false });
    const stamped = await verifySenderHeader(header, SUBJECT, PAYLOAD, {
      mode: "live",
      operatorAttested: true,
      headers: withHeaders({ [NATS_REQUEST_INFO_HEADER]: stamp({ acc: "ACME" }) }),
    });
    expect(stamped).toMatchObject({ trust: "verified", accountAttested: true });
  });
});
