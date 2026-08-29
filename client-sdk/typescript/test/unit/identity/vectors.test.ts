// Known-answer vectors (`test-fixtures/identity/*-vectors.json`): the
// implementation reproduces every expected byte, verifies every
// signature, and regenerating the files yields identical content.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { identityFixture } from "../../harness/nats-server.js";
import {
  FIXTURES_DIR,
  generate,
  render,
  type IdSigVectorsFile,
  type SenderVectorsFile,
} from "../../../scripts/generate-identity-vectors.js";
import { decodeBase64 } from "../../../src/prompt/envelope.js";
import { newAgentId } from "../../../src/identity/agent-id.js";
import { base64UrlDecode, sha256Hex, verifyWithPublicKey } from "../../../src/identity/crypto.js";
import { buildAgentIdSignedInput, verifyAgentId } from "../../../src/identity/id-sig.js";
import {
  buildClaimHeader,
  buildSignedInput,
  encodedHeaderLength,
  maxSenderHeaderBytes,
  parseSenderHeader,
  serializeSenderHeader,
  signSenderHeader,
  verifySenderHeader,
} from "../../../src/identity/sender-header.js";
import { signerFromSeed } from "../../../src/identity/signer.js";

const sender = JSON.parse(
  await readFile(identityFixture("sender-vectors.json"), "utf8"),
) as SenderVectorsFile;
const idSig = JSON.parse(
  await readFile(identityFixture("id-sig-vectors.json"), "utf8"),
) as IdSigVectorsFile;
const enc = new TextEncoder();
const dec = new TextDecoder();

describe("sender-vectors.json", () => {
  it("has the expected shape", () => {
    expect(sender.header_framing_bytes).toBe(28);
    expect(sender.vectors.length).toBeGreaterThanOrEqual(8);
    expect(sender.vectors.some((v) => v.input.payload_b64 === "")).toBe(true);
    expect(sender.vectors.some((v) => !v.input.signed)).toBe(true);
    expect(sender.vectors.some((v) => /[^\x00-\x7f]/.test(v.input.name ?? ""))).toBe(true);
    expect(sender.vectors.some((v) => v.input.sub !== undefined)).toBe(true);
  });

  for (const v of sender.vectors) {
    it(`${v.id}: ${v.note}`, async () => {
      const signer = signerFromSeed(v.input.seed);
      expect(signer.publicKey).toBe(v.input.user);
      const id = newAgentId(v.input.account, v.input.user);
      const payload = decodeBase64(v.input.payload_b64);
      const nameOpt = v.input.name !== undefined ? { name: v.input.name } : {};
      const sub = v.input.sub ?? v.input.subject;

      const header = v.input.signed
        ? await signSenderHeader({
            signer,
            id,
            ...nameOpt,
            sub,
            payload,
            ts: v.input.ts!,
            nonce: v.input.nonce!,
          })
        : buildClaimHeader({ id, ...nameOpt });

      const value = serializeSenderHeader(header);
      expect(value).toBe(v.expected.header);
      expect(enc.encode(value).length).toBe(v.expected.header_bytes);
      expect(encodedHeaderLength(value)).toBe(v.expected.header_wire_bytes);
      expect(v.expected.header_wire_bytes).toBe(v.expected.header_bytes + 28);
      expect(encodedHeaderLength(value)).toBeLessThanOrEqual(
        maxSenderHeaderBytes(sub, v.input.name),
      );

      const parsed = parseSenderHeader(v.expected.header);
      expect(parsed).toEqual(header);

      if (v.input.signed) {
        const input = buildSignedInput({
          account: v.input.account,
          user: v.input.user,
          subject: sub,
          ts: v.input.ts!,
          nonce: v.input.nonce!,
          payloadSha256Hex: await sha256Hex(payload),
        });
        expect(dec.decode(input)).toBe(v.expected.signed_input);
        expect(header.sig).toBe(v.expected.sig);
        expect(verifyWithPublicKey(v.input.user, input, base64UrlDecode(v.expected.sig!))).toBe(
          true,
        );
        // Stored-mode verification against the signed subject (ts is fixed in the past).
        const verified = await verifySenderHeader(parsed!, sub, payload, { mode: "stored" });
        expect(verified.trust).toBe("verified");
      } else {
        expect(v.expected.signed_input).toBeUndefined();
        const claimed = await verifySenderHeader(parsed!, sub, payload, { mode: "live" });
        expect(claimed.trust).toBe("claimed");
      }
    });
  }
});

describe("id-sig-vectors.json", () => {
  for (const v of idSig.vectors) {
    it(`${v.id}: ${v.note}`, () => {
      const input = buildAgentIdSignedInput({
        user: v.input.user,
        account: v.input.account,
        agent: v.input.agent,
        owner: v.input.owner,
        promptSubject: v.input.prompt_subject,
      });
      expect(dec.decode(input)).toBe(v.expected.signed_input);
      expect(verifyWithPublicKey(v.input.user, input, base64UrlDecode(v.expected.id_sig))).toBe(
        true,
      );
      expect(verifyAgentId(v.expected.metadata, v.input.prompt_subject)).toBe(true);
      expect(verifyAgentId(v.expected.metadata, v.input.prompt_subject + ".x")).toBe(false);
    });
  }
});

describe("generator determinism", () => {
  it("regenerating yields byte-identical files (ed25519 is deterministic; all inputs fixed)", async () => {
    const out = await generate();
    expect(render(out.sender)).toBe(
      await readFile(join(FIXTURES_DIR, "sender-vectors.json"), "utf8"),
    );
    expect(render(out.idSig)).toBe(
      await readFile(join(FIXTURES_DIR, "id-sig-vectors.json"), "utf8"),
    );
  });
});
