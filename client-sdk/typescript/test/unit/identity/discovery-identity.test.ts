// Discovery-side identity fields: `min_sender_trust` parsing on the prompt
// endpoint, `supportsSenderIdentity`, `identity`, `idSigVerified`; the
// header-inclusive `max_payload` check; the error class re-parenting.

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { identityFixture } from "../../harness/nats-server.js";
import { buildAgentInfo, type RawServiceInfo } from "../../../src/discovery/agent-info.js";
import { buildEndpointInfo, parseMinSenderTrust } from "../../../src/discovery/endpoint-info.js";
import { NatsAgentError, PayloadTooLargeError } from "../../../src/errors.js";
import { newAgentId } from "../../../src/identity/agent-id.js";
import { signAgentId } from "../../../src/identity/id-sig.js";
import { signerFromSeed } from "../../../src/identity/signer.js";
import { assertWithinMaxPayload } from "../../../src/prompt/validate.js";
import { InvalidProtocolVersionError } from "../../../src/version.js";

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>;
}
const keys = JSON.parse(await readFile(identityFixture("keys.json"), "utf8")) as KeysFile;
const alice = signerFromSeed(keys.users["alice"]!.seed);
const SUBJECT = "agents.prompt.cc.alice.sess-1";

function info(
  metadata: Record<string, string>,
  endpointMetadata: Record<string, string> = {},
): RawServiceInfo {
  return {
    name: "agents",
    id: "VMKS6MHK71PCPWGY38A7N5",
    version: "1.0.0",
    description: "t",
    metadata: { agent: "claude-code", owner: "alice", protocol_version: "0.3", ...metadata },
    endpoints: [
      {
        name: "prompt",
        subject: SUBJECT,
        queue_group: "agents",
        metadata: { max_payload: "1MB", ...endpointMetadata },
      },
    ],
  };
}

describe("min_sender_trust", () => {
  it("parseMinSenderTrust: absent → undefined, any, signed, garbage → signed", () => {
    expect(parseMinSenderTrust(undefined)).toBeUndefined();
    expect(parseMinSenderTrust("any")).toBe("any");
    expect(parseMinSenderTrust("signed")).toBe("signed");
    expect(parseMinSenderTrust("verified-plus")).toBe("signed");
    expect(parseMinSenderTrust("")).toBe("signed");
  });

  it("lands on the prompt endpoint only; raw value stays in metadata", () => {
    const p = buildEndpointInfo({
      name: "prompt",
      subject: SUBJECT,
      metadata: { min_sender_trust: "weird" },
    });
    expect(p.minSenderTrust).toBe("signed");
    expect(p.metadata["min_sender_trust"]).toBe("weird");
    const s = buildEndpointInfo({
      name: "status",
      subject: SUBJECT,
      metadata: { min_sender_trust: "any" },
    });
    expect(s.minSenderTrust).toBeUndefined();
  });

  it("supportsSenderIdentity is feature detection: true iff the key exists", () => {
    expect(buildAgentInfo(info({}, { min_sender_trust: "any" }))!.supportsSenderIdentity).toBe(
      true,
    );
    expect(buildAgentInfo(info({}))!.supportsSenderIdentity).toBe(false);
  });
});

describe("registration identity", () => {
  it("identity is built from user_nkey + account; idSigVerified only with a verifying id_sig", async () => {
    const id = newAgentId("ACME", alice.publicKey);
    const idSig = await signAgentId({
      signer: alice,
      id,
      agent: "claude-code",
      owner: "alice",
      promptSubject: SUBJECT,
    });
    const ok = buildAgentInfo(
      info({ user_nkey: alice.publicKey, account: "ACME", id_sig: idSig }),
    )!;
    expect(ok.identity).toBe(id);
    expect(ok.idSigVerified).toBe(true);
    const claimOnly = buildAgentInfo(info({ user_nkey: alice.publicKey, account: "ACME" }))!;
    expect(claimOnly.identity).toBe(id);
    expect(claimOnly.idSigVerified).toBe(false);
    const tampered = buildAgentInfo(
      info({ user_nkey: alice.publicKey, account: "ACME", id_sig: idSig.slice(0, -2) + "AA" }),
    )!;
    expect(tampered.idSigVerified).toBe(false);
    const wrongOwner = buildAgentInfo(
      info({ user_nkey: alice.publicKey, account: "ACME", id_sig: idSig, owner: "mallory" }),
    )!;
    expect(wrongOwner.idSigVerified).toBe(false);
    const malformed = buildAgentInfo(info({ user_nkey: "nope", account: "ACME" }))!;
    expect(malformed.identity).toBeUndefined();
    expect(buildAgentInfo(info({}))!.identity).toBeUndefined();
  });
});

describe("assertWithinMaxPayload with header bytes", () => {
  const endpoint = buildEndpointInfo({
    name: "prompt",
    subject: SUBJECT,
    metadata: { max_payload: "1KB" },
  });

  it("counts the framed header against the limit and reports it on the error", () => {
    expect(() => assertWithinMaxPayload(1024, endpoint)).not.toThrow();
    expect(() => assertWithinMaxPayload(1000, endpoint, undefined, 24)).not.toThrow();
    let caught: unknown;
    try {
      assertWithinMaxPayload(1000, endpoint, undefined, 25);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PayloadTooLargeError);
    const e = caught as PayloadTooLargeError;
    expect(e.headerBytes).toBe(25);
    expect(e.actual).toBe(1000);
    expect(e.limit).toBe(1024);
    expect(e.message).toMatch(/Agent-Sender header 25 bytes/);
    expect(new PayloadTooLargeError(1, 2).headerBytes).toBe(0);
  });
});

describe("InvalidProtocolVersionError", () => {
  it("is a NatsAgentError now", () => {
    expect(new InvalidProtocolVersionError("x")).toBeInstanceOf(NatsAgentError);
  });
});
