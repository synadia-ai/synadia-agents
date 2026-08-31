// Agent-Sender codec: canonical serialisation, parser hardening (§2.2),
// size bound vs exact size, subject acceptance (equality / token removal),
// and verification outcomes without a server.

import { readFile } from "node:fs/promises";
import { headers } from "@nats-io/nats-core";
import { describe, expect, it } from "vitest";
import { identityFixture } from "../../harness/nats-server.js";
import { newAgentId } from "../../../src/identity/agent-id.js";
import { base64UrlEncode } from "../../../src/identity/crypto.js";
import {
  AGENT_SENDER_HEADER,
  assertValidSenderName,
  buildClaimHeader,
  checkSubjectAcceptance,
  encodedHeaderLength,
  expectedSenderHeaderBytes,
  formatSenderTimestamp,
  maxSenderHeaderBytes,
  normalizeAccountTokenPosition,
  parseSenderHeader,
  readSenderHeaderValue,
  serializeSenderHeader,
  signSenderHeader,
  verifySenderHeader,
  type AgentSenderHeader,
} from "../../../src/identity/sender-header.js";
import { signerFromSeed } from "../../../src/identity/signer.js";
import {
  IdentityError,
  MalformedSenderHeaderError,
  SenderVerificationError,
} from "../../../src/errors.js";

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>;
}
const keys = JSON.parse(await readFile(identityFixture("keys.json"), "utf8")) as KeysFile;
const alice = signerFromSeed(keys.users["alice"]!.seed);
const bob = signerFromSeed(keys.users["bob"]!.seed);
const aliceId = newAgentId("$G", alice.publicKey);
const enc = new TextEncoder();
const SUBJECT = "agents.prompt.demo.alice.example";
const PAYLOAD = enc.encode('{"prompt":"hello"}');
const C1_NEL = String.fromCharCode(0x85);
const DEL = String.fromCharCode(0x7f);
const LINE_SEP = String.fromCharCode(0x2028);

async function signed(overrides: Partial<Parameters<typeof signSenderHeader>[0]> = {}) {
  return signSenderHeader({
    signer: alice,
    id: aliceId,
    sub: SUBJECT,
    payload: PAYLOAD,
    ...overrides,
  });
}

function withField(h: AgentSenderHeader, patch: Record<string, unknown>): string {
  return JSON.stringify({ ...(JSON.parse(serializeSenderHeader(h)) as object), ...patch });
}

async function verify(h: AgentSenderHeader, arrival = SUBJECT, payload = PAYLOAD, opts = {}) {
  return verifySenderHeader(h, arrival, payload, { mode: "live", ...opts });
}

async function rejection(p: Promise<unknown>): Promise<SenderVerificationError> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SenderVerificationError);
  return err as SenderVerificationError;
}

describe("serializeSenderHeader", () => {
  it("emits the fixed field order, compact, `v` as the integer 1, absent fields omitted", () => {
    const claim = buildClaimHeader({ id: aliceId });
    expect(serializeSenderHeader(claim)).toBe(`{"v":1,"account":"$G","user":"${alice.publicKey}"}`);
    const named = buildClaimHeader({ id: aliceId, name: "x" });
    expect(serializeSenderHeader(named)).toBe(
      `{"v":1,"account":"$G","user":"${alice.publicKey}","name":"x"}`,
    );
  });

  it("keeps non-ASCII raw (no \\u escapes) — byte-equal with Python's ensure_ascii=False", () => {
    const s = serializeSenderHeader(buildClaimHeader({ id: aliceId, name: "Bob · 日本語 🤖" }));
    expect(s).toContain('"name":"Bob · 日本語 🤖"');
    expect(s).not.toContain("\\u");
  });

  it("orders sub, ts, nonce, sig after name", async () => {
    const h = await signed({ name: "n", ts: "2026-08-28T12:00:00Z", nonce: "abc" });
    expect(Object.keys(JSON.parse(serializeSenderHeader(h)) as object)).toEqual([
      "v",
      "account",
      "user",
      "name",
      "sub",
      "ts",
      "nonce",
      "sig",
    ]);
  });
});

describe("signSenderHeader", () => {
  it("emits ts at second precision with Z, a 22-char NUID nonce and an 86-char base64url sig", async () => {
    const h = await signed();
    expect(h.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(h.nonce).toHaveLength(22);
    expect(h.sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(h.sub).toBe(SUBJECT);
  });

  it("fresh nonce per call", async () => {
    const [a, b] = await Promise.all([signed(), signed()]);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("formatSenderTimestamp drops milliseconds", () => {
    expect(formatSenderTimestamp(Date.UTC(2026, 7, 28, 12, 0, 0, 999))).toBe(
      "2026-08-28T12:00:00Z",
    );
  });
});

describe("parseSenderHeader — hardening", () => {
  const good = (): Promise<AgentSenderHeader> => signed({ name: "claude-code" });

  it("parses a signed header back to the same fields (unknown fields ignored)", async () => {
    const h = await good();
    const parsed = parseSenderHeader(withField(h, { extra: { deep: true }, zzz: 1 }));
    expect(parsed).toEqual(h);
    expect(Object.keys(parsed!)).not.toContain("extra");
  });

  it("treats an unknown numeric `v` as absent (null)", async () => {
    expect(parseSenderHeader(withField(await good(), { v: 2 }))).toBeNull();
  });

  it.each([
    ["v as string", { v: "1" }],
    ["v as boolean", { v: true }],
    ["v missing", { v: undefined }],
  ])("rejects %s", async (_label, patch) => {
    const h = await good();
    expect(() => parseSenderHeader(withField(h, patch))).toThrow(MalformedSenderHeaderError);
  });

  it("rejects non-JSON, non-object, and over-size values", () => {
    expect(() => parseSenderHeader("not json")).toThrow(MalformedSenderHeaderError);
    expect(() => parseSenderHeader("[1]")).toThrow(MalformedSenderHeaderError);
    expect(() =>
      parseSenderHeader(
        `{"v":1,"account":"$G","user":"${alice.publicKey}","pad":"${"x".repeat(2100)}"}`,
      ),
    ).toThrow(/exceeds 2048/);
  });

  it("rejects a 55-char user, a bad-CRC account, missing account/user", async () => {
    const h = await good();
    expect(() => parseSenderHeader(withField(h, { user: h.user.slice(0, 55) }))).toThrow(
      MalformedSenderHeaderError,
    );
    expect(() =>
      parseSenderHeader(
        withField(h, { account: "AABYLMBR6Q2CDXTLGRQCFA2GP76BGCDF7NZF2OVHH4RQ7L3Y3TZWJDRM" }),
      ),
    ).toThrow(MalformedSenderHeaderError);
    expect(() => parseSenderHeader(`{"v":1,"user":"${alice.publicKey}"}`)).toThrow(
      MalformedSenderHeaderError,
    );
    expect(() => parseSenderHeader(`{"v":1,"account":"$G"}`)).toThrow(MalformedSenderHeaderError);
  });

  it("rejects `sig` without sub / ts / nonce", async () => {
    const h = await good();
    for (const missing of ["sub", "ts", "nonce"]) {
      const o = JSON.parse(serializeSenderHeader(h)) as Record<string, unknown>;
      delete o[missing];
      expect(() => parseSenderHeader(JSON.stringify(o)), missing).toThrow(
        MalformedSenderHeaderError,
      );
    }
  });

  it.each([
    ["yesterday"],
    ["2026-08-28 12:00:00Z"],
    ["2026-08-28T12:00:00"],
    ["2026-08-28T12:00:00+00:00"],
    ["2026-13-28T12:00:00Z"],
  ])("rejects ts %s", async (ts) => {
    const h = await good();
    expect(() => parseSenderHeader(withField(h, { ts }))).toThrow(MalformedSenderHeaderError);
  });

  it("accepts fractional seconds in ts (verifiers MUST)", async () => {
    expect(parseSenderHeader(withField(await good(), { ts: "2026-08-28T12:00:00.123Z" }))?.ts).toBe(
      "2026-08-28T12:00:00.123Z",
    );
  });

  it.each([[""], ["a.b"], ["has space"], ["x".repeat(65)], ["ünïcode"]])(
    "rejects nonce %j",
    async (nonce) => {
      const h = await good();
      expect(() => parseSenderHeader(withField(h, { nonce }))).toThrow(MalformedSenderHeaderError);
    },
  );

  it("rejects a malformed or wrong-size sig", async () => {
    const h = await good();
    expect(() => parseSenderHeader(withField(h, { sig: "not base64url!" }))).toThrow(
      MalformedSenderHeaderError,
    );
    expect(() =>
      parseSenderHeader(withField(h, { sig: base64UrlEncode(new Uint8Array(63)) })),
    ).toThrow(/64 bytes/);
    expect(() => parseSenderHeader(withField(h, { sig: h.sig + "=" }))).toThrow(
      MalformedSenderHeaderError,
    );
  });

  it("rejects a name with a control character, over 64 chars, or of the wrong type", async () => {
    const h = await good();
    expect(() => parseSenderHeader(withField(h, { name: "a\nb" }))).toThrow(
      MalformedSenderHeaderError,
    );
    expect(() => parseSenderHeader(withField(h, { name: "x".repeat(65) }))).toThrow(
      MalformedSenderHeaderError,
    );
    expect(() => parseSenderHeader(withField(h, { name: 5 }))).toThrow(MalformedSenderHeaderError);
    expect(() => parseSenderHeader(withField(h, { name: `a${C1_NEL}b` }))).toThrow(
      MalformedSenderHeaderError,
    );
  });

  it("rejects a sub that is not a subject", async () => {
    const h = await good();
    for (const sub of ["", "a..b", "a b", ".a", "a."]) {
      expect(() => parseSenderHeader(withField(h, { sub })), sub).toThrow(
        MalformedSenderHeaderError,
      );
    }
  });
});

describe("readSenderHeaderValue", () => {
  it("matches the header name case-sensitively; lowercase is absent", () => {
    const h = headers();
    h.set("agent-sender", "{}");
    expect(readSenderHeaderValue(h)).toBeUndefined();
    h.set(AGENT_SENDER_HEADER, "{}");
    expect(readSenderHeaderValue(h)).toBe("{}");
    expect(readSenderHeaderValue(undefined)).toBeUndefined();
  });

  it("rejects two values", () => {
    const h = headers();
    h.append(AGENT_SENDER_HEADER, "{}");
    h.append(AGENT_SENDER_HEADER, "{}");
    expect(() => readSenderHeaderValue(h)).toThrow(MalformedSenderHeaderError);
  });
});

describe("assertValidSenderName", () => {
  it("accepts 64 chars, rejects 65, C0, C1, DEL, U+2028, lone surrogates", () => {
    expect(() => assertValidSenderName("x".repeat(64))).not.toThrow();
    expect(() => assertValidSenderName("x".repeat(65))).toThrow(IdentityError);
    expect(() => assertValidSenderName("a\tb")).toThrow(IdentityError);
    expect(() => assertValidSenderName(`a${C1_NEL}b`)).toThrow(IdentityError);
    expect(() => assertValidSenderName(`a${DEL}b`)).toThrow(IdentityError);
    expect(() => assertValidSenderName(`a${LINE_SEP}b`)).toThrow(IdentityError);
    expect(() => assertValidSenderName("\ud83d")).toThrow(/surrogate/);
    expect(() => assertValidSenderName("\ude00")).toThrow(/surrogate/);
    expect(() => assertValidSenderName("🤖 ok")).not.toThrow();
  });

  it("messages never include the name", () => {
    try {
      assertValidSenderName("SECRET\n");
    } catch (err) {
      expect((err as Error).message).not.toContain("SECRET");
    }
  });
});

describe("size accounting", () => {
  it("framed length is 28 + UTF-8 bytes", () => {
    expect(encodedHeaderLength("{}")).toBe(30);
    expect(encodedHeaderLength("é")).toBe(30);
  });

  it("the bound covers every header this SDK produces (signed, claim, long account, long name)", async () => {
    const specAccount = "AABYLMBR6Q2CDXTLGRQCFA2GP76BGCDF7NZF2OVHH4RQ7L3Y3TZWJDRL";
    const name = "🤖".repeat(32); // 64 UTF-16 units, 128 UTF-8 bytes
    for (const account of ["$G", "ACME", specAccount, "x".repeat(64)]) {
      const id = newAgentId(account, alice.publicKey);
      const h = await signSenderHeader({
        signer: alice,
        id,
        name,
        sub: SUBJECT,
        payload: PAYLOAD,
        nonce: "N".repeat(64),
      });
      const actual = encodedHeaderLength(serializeSenderHeader(h));
      expect(actual, account).toBeLessThanOrEqual(maxSenderHeaderBytes(SUBJECT, name));
      const claim = encodedHeaderLength(serializeSenderHeader(buildClaimHeader({ id, name })));
      expect(claim, account).toBeLessThanOrEqual(maxSenderHeaderBytes(SUBJECT, name));
    }
  });

  it("expectedSenderHeaderBytes is exact for the header the SDK sends", async () => {
    const h = await signed({ name: "claude-code" });
    expect(
      expectedSenderHeaderBytes({ id: aliceId, name: "claude-code", sub: SUBJECT, signed: true }),
    ).toBe(encodedHeaderLength(serializeSenderHeader(h)));
    const claim = buildClaimHeader({ id: aliceId });
    expect(expectedSenderHeaderBytes({ id: aliceId, sub: SUBJECT, signed: false })).toBe(
      encodedHeaderLength(serializeSenderHeader(claim)),
    );
  });
});

describe("checkSubjectAcceptance", () => {
  it("without a position: equality only", () => {
    expect(checkSubjectAcceptance({ account: "APP", sub: "a.b" }, "a.b", undefined)).toBeNull();
    expect(checkSubjectAcceptance({ account: "APP", sub: "a.*" }, "a.b", undefined)).toMatch(
      /not the arrival subject/,
    );
  });

  it("with a position: token cross-check always, then equality or removal", () => {
    expect(
      checkSubjectAcceptance({ account: "APP", sub: "svc.prompt" }, "svc.APP.prompt", 2),
    ).toBeNull();
    expect(
      checkSubjectAcceptance({ account: "APP", sub: "svc.APP.prompt" }, "svc.APP.prompt", 2),
    ).toBeNull();
    expect(
      checkSubjectAcceptance({ account: "EVIL", sub: "svc.prompt" }, "svc.APP.prompt", 2),
    ).toMatch(/not the header account/);
    expect(
      checkSubjectAcceptance({ account: "APP", sub: "svc.other" }, "svc.APP.prompt", 2),
    ).toMatch(/neither/);
    expect(
      checkSubjectAcceptance({ account: "APP", sub: "svc.prompt" }, "svc.APP.prompt", 5),
    ).toMatch(/beyond/);
  });

  it("normalizeAccountTokenPosition validates 1-based integers", () => {
    expect(normalizeAccountTokenPosition(undefined)).toBeUndefined();
    expect(normalizeAccountTokenPosition(1)).toBe(1);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => normalizeAccountTokenPosition(bad), String(bad)).toThrow(IdentityError);
    }
  });
});

describe("verifySenderHeader", () => {
  it("verifies a fresh signed header → VerifiedSender with accountAttested=false and an unbound resolve()", async () => {
    const sender = await verify(await signed({ name: "n" }));
    expect(sender.trust).toBe("verified");
    if (sender.trust !== "verified") throw new Error("unreachable");
    expect(sender.id).toBe(aliceId);
    expect(sender.accountAttested).toBe(false);
    expect(sender.name).toBe("n");
    await expect(sender.resolve()).resolves.toBeUndefined();
  });

  it("an unsigned header → ClaimedSender with no id", async () => {
    const sender = await verify(buildClaimHeader({ id: aliceId, name: "n" }));
    expect(sender.trust).toBe("claimed");
    expect("id" in sender).toBe(false);
    if (sender.trust !== "claimed") throw new Error("unreachable");
    expect(sender.claim).toEqual({ account: "$G", user: alice.publicKey });
  });

  it("name is outside the signature: a mutated name still verifies", async () => {
    const h = await signed({ name: "original" });
    const mutated = parseSenderHeader(withField(h, { name: "rewritten" }))!;
    const sender = await verify(mutated);
    expect(sender.trust).toBe("verified");
    expect(sender.name).toBe("rewritten");
  });

  it("401: stale ts, future ts beyond the window; ok inside the window", async () => {
    const h = await signed({ ts: "2026-01-01T00:00:00Z" });
    const err = await rejection(verify(h));
    expect(err.code).toBe(401);
    expect(err.description).toBe("sender rejected");
    expect(err.detail).toMatch(/window/);
    const now = Date.now();
    const soon = await signed({ ts: formatSenderTimestamp(now + 29_000) });
    expect((await verify(soon, SUBJECT, PAYLOAD, { now })).trust).toBe("verified");
    const late = await signed({ ts: formatSenderTimestamp(now + 31_000) });
    expect((await rejection(verify(late, SUBJECT, PAYLOAD, { now }))).detail).toMatch(/window/);
  });

  it("stored mode skips the ts window and the nonce lookup", async () => {
    const h = await signed({ ts: "2026-01-01T00:00:00Z" });
    const sender = await verifySenderHeader(h, SUBJECT, PAYLOAD, {
      mode: "stored",
      nonceSeen: () => true,
    });
    expect(sender.trust).toBe("verified");
  });

  it("401: transplanted to another subject; sub rewritten to the arrival subject", async () => {
    const h = await signed();
    expect((await rejection(verify(h, "agents.prompt.demo.alice.other"))).detail).toMatch(
      /arrival subject/,
    );
    const rewritten = parseSenderHeader(withField(h, { sub: "agents.prompt.demo.alice.other" }))!;
    expect((await rejection(verify(rewritten, "agents.prompt.demo.alice.other"))).detail).toMatch(
      /signature/,
    );
  });

  it("401: account or user rewritten in a valid header; payload tampered", async () => {
    const h = await signed();
    const acct = parseSenderHeader(withField(h, { account: "ACME" }))!;
    expect((await rejection(verify(acct))).detail).toMatch(/signature/);
    const user = parseSenderHeader(withField(h, { user: bob.publicKey }))!;
    expect((await rejection(verify(user))).detail).toMatch(/signature/);
    expect((await rejection(verify(h, SUBJECT, enc.encode('{"prompt":"hellp"}')))).detail).toMatch(
      /signature/,
    );
  });

  it("401: nonce already seen (the lookup runs before the signature)", async () => {
    const h = await signed();
    let asked = 0;
    const err = await rejection(
      verify(h, SUBJECT, PAYLOAD, {
        nonceSeen: () => {
          asked += 1;
          return true;
        },
      }),
    );
    expect(err.detail).toMatch(/already seen/);
    expect(err.detail).not.toContain(h.nonce!);
    expect(err.message).not.toContain(h.nonce!);
    expect(asked).toBe(1);
  });

  it("account_token_position: removal and equality forms verify; forged account / bad position reject", async () => {
    const bobId = newAgentId("APP", bob.publicKey);
    const atp = { mode: "live" as const, accountTokenPosition: 2 };
    const local = await signSenderHeader({
      signer: bob,
      id: bobId,
      sub: "svc.prompt",
      payload: PAYLOAD,
    });
    expect((await verifySenderHeader(local, "svc.APP.prompt", PAYLOAD, atp)).trust).toBe(
      "verified",
    );
    const full = await signSenderHeader({
      signer: bob,
      id: bobId,
      sub: "svc.APP.prompt",
      payload: PAYLOAD,
    });
    expect((await verifySenderHeader(full, "svc.APP.prompt", PAYLOAD, atp)).trust).toBe("verified");
    const forged = await signSenderHeader({
      signer: bob,
      id: newAgentId("EVIL", bob.publicKey),
      sub: "svc.prompt",
      payload: PAYLOAD,
    });
    expect(
      (await rejection(verifySenderHeader(forged, "svc.APP.prompt", PAYLOAD, atp))).detail,
    ).toMatch(/not the header account/);
    expect(
      (
        await rejection(
          verifySenderHeader(local, "svc.APP.prompt", PAYLOAD, {
            mode: "live",
            accountTokenPosition: 5,
          }),
        )
      ).detail,
    ).toMatch(/beyond/);
    // Without the position configured, the removal form is a plain mismatch.
    expect(
      (await rejection(verifySenderHeader(local, "svc.APP.prompt", PAYLOAD, { mode: "live" })))
        .detail,
    ).toMatch(/arrival subject/);
  });

  it("binds a resolver when given", async () => {
    const sender = await verify(await signed(), SUBJECT, PAYLOAD, {
      resolver: () => Promise.resolve(undefined),
    });
    expect(sender.trust).toBe("verified");
  });
});
