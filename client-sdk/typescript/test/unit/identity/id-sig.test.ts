// AGENT-ID-V1: field order (user first), custom prompt subject, tampering.

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { identityFixture } from "../../harness/nats-server.js";
import { newAgentId } from "../../../src/identity/agent-id.js";
import {
  AGENT_ID_SIGNED_INPUT_TAG,
  buildAgentIdSignedInput,
  IDENTITY_METADATA_KEYS,
  signAgentId,
  verifyAgentId,
} from "../../../src/identity/id-sig.js";
import { signerFromSeed } from "../../../src/identity/signer.js";

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>;
}
const keys = JSON.parse(await readFile(identityFixture("keys.json"), "utf8")) as KeysFile;
const alice = signerFromSeed(keys.users["alice"]!.seed);
const id = newAgentId("ACME", alice.publicKey);
const SUBJECT = "agents.prompt.demo.alice.example";

async function metadataFor(
  promptSubject: string,
  agent = "demo",
  owner = "alice",
): Promise<Record<string, string>> {
  return {
    agent,
    owner,
    protocol_version: "0.3",
    [IDENTITY_METADATA_KEYS.userNkey]: alice.publicKey,
    [IDENTITY_METADATA_KEYS.account]: "ACME",
    [IDENTITY_METADATA_KEYS.idSig]: await signAgentId({
      signer: alice,
      id,
      agent,
      owner,
      promptSubject,
    }),
  };
}

describe("AGENT-ID-V1", () => {
  it("signed input: tag, user, account, agent, owner, prompt subject — each newline-terminated", () => {
    const s = new TextDecoder().decode(
      buildAgentIdSignedInput({
        user: "U",
        account: "A",
        agent: "ag",
        owner: "ow",
        promptSubject: "s.u.b",
      }),
    );
    expect(s).toBe(`${AGENT_ID_SIGNED_INPUT_TAG}\nU\nA\nag\now\ns.u.b\n`);
  });

  it("verifies against the prompt subject it was signed for, including a custom one", async () => {
    expect(verifyAgentId(await metadataFor(SUBJECT), SUBJECT)).toBe(true);
    expect(verifyAgentId(await metadataFor("svc.custom.prompt"), "svc.custom.prompt")).toBe(true);
    expect(verifyAgentId(await metadataFor("svc.custom.prompt"), SUBJECT)).toBe(false);
  });

  it("fails when any bound field is altered or missing, or the signature is malformed", async () => {
    const m = await metadataFor(SUBJECT);
    expect(verifyAgentId({ ...m, agent: "other" }, SUBJECT)).toBe(false);
    expect(verifyAgentId({ ...m, owner: "other" }, SUBJECT)).toBe(false);
    expect(verifyAgentId({ ...m, account: "$G" }, SUBJECT)).toBe(false);
    expect(verifyAgentId({ ...m, user_nkey: keys.users["bob"]!.public }, SUBJECT)).toBe(false);
    expect(verifyAgentId({ ...m, id_sig: "AAAA" }, SUBJECT)).toBe(false);
    expect(verifyAgentId({ ...m, id_sig: "not-base64url!" }, SUBJECT)).toBe(false);
    expect(verifyAgentId({ ...m, user_nkey: "notakey" }, SUBJECT)).toBe(false);
    for (const key of Object.keys(m)) {
      if (key === "protocol_version") continue;
      const copy: Record<string, string> = { ...m };
      delete copy[key];
      expect(verifyAgentId(copy, SUBJECT), key).toBe(false);
    }
  });
});
