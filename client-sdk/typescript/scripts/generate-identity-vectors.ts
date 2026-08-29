// Generates the shared known-answer vectors for the sender-identity
// extension into `test-fixtures/identity/`:
//
//   sender-vectors.json — `Agent-Sender` headers: for each case the exact
//                         signed input, the exact header bytes and the
//                         framed wire length; includes an empty payload, a
//                         non-ASCII `name`, a renamed-import `sub`, and an
//                         unsigned claim.
//   id-sig-vectors.json — `AGENT-ID-V1` registration signatures, including
//                         a custom (non-default) prompt subject.
//
// The TypeScript implementation is the generator; every SDK verifies the
// vectors (Python: byte-equal serialisation and signature verification).
// ed25519 is deterministic and every input (ts, nonce) is fixed, so a
// regeneration must be byte-identical — `test/unit/identity/vectors.test.ts`
// asserts exactly that.
//
//   bun scripts/generate-identity-vectors.ts          # write
//   bun scripts/generate-identity-vectors.ts --check  # compare with the files

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createAccount } from "@nats-io/nkeys";
import {
  buildAgentIdSignedInput,
  buildClaimHeader,
  buildSignedInput,
  encodeBase64,
  encodedHeaderLength,
  newAgentId,
  serializeSenderHeader,
  sha256Hex,
  signAgentId,
  signerFromSeed,
  signSenderHeader,
  agentIdAccount,
  agentIdUser,
} from "../src/index.js";

export const FIXTURES_DIR = fileURLToPath(
  new URL("../../../test-fixtures/identity/", import.meta.url),
);

/** The spec's own account key (parse-fixture row 1) — a real NKEY with a valid CRC. */
const SPEC_ACCOUNT_KEY = "AABYLMBR6Q2CDXTLGRQCFA2GP76BGCDF7NZF2OVHH4RQ7L3Y3TZWJDRL";
const FIXED_TS = "2026-08-28T12:00:00Z";

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>;
}

export interface SenderVectorInput {
  readonly user: string;
  readonly seed: string;
  readonly account: string;
  readonly subject: string;
  /** Present only when it differs from `subject` (renamed import). */
  readonly sub?: string;
  readonly payload_b64: string;
  readonly ts?: string;
  readonly nonce?: string;
  readonly name?: string;
  readonly signed: boolean;
}

export interface SenderVector {
  readonly id: string;
  readonly note: string;
  readonly input: SenderVectorInput;
  readonly expected: {
    /** Only for signed vectors. */
    readonly signed_input?: string;
    readonly sig?: string;
    /** The exact header value (bytes = UTF-8 of this string). */
    readonly header: string;
    readonly header_bytes: number;
    /** `header_bytes` + 28 (`NATS/1.0\r\nAgent-Sender: ` … `\r\n\r\n`). */
    readonly header_wire_bytes: number;
  };
}

export interface IdSigVector {
  readonly id: string;
  readonly note: string;
  readonly input: {
    readonly user: string;
    readonly seed: string;
    readonly account: string;
    readonly agent: string;
    readonly owner: string;
    readonly prompt_subject: string;
  };
  readonly expected: {
    readonly signed_input: string;
    readonly id_sig: string;
    /** The metadata keys a verifier reads. */
    readonly metadata: Record<string, string>;
  };
}

export interface SenderVectorsFile {
  readonly _comment: string;
  readonly _generated_by: string;
  readonly signed_input_format: string;
  readonly header_framing_bytes: number;
  readonly vectors: ReadonlyArray<SenderVector>;
}

export interface IdSigVectorsFile {
  readonly _comment: string;
  readonly _generated_by: string;
  readonly signed_input_format: string;
  readonly vectors: ReadonlyArray<IdSigVector>;
}

const enc = new TextEncoder();

async function senderVector(
  id: string,
  note: string,
  seed: string,
  account: string,
  subject: string,
  payload: Uint8Array,
  extras: { sub?: string; name?: string; nonce?: string; signed?: boolean } = {},
): Promise<SenderVector> {
  const signer = signerFromSeed(seed);
  const agentId = newAgentId(account, signer.publicKey);
  const signed = extras.signed ?? true;
  const sub = extras.sub ?? subject;
  const nameOpt = extras.name !== undefined ? { name: extras.name } : {};
  const input: SenderVectorInput = {
    user: signer.publicKey,
    seed,
    account,
    subject,
    ...(extras.sub !== undefined ? { sub: extras.sub } : {}),
    payload_b64: encodeBase64(payload),
    ...(signed ? { ts: FIXED_TS, nonce: extras.nonce ?? `nonce-${id}` } : {}),
    ...nameOpt,
    signed,
  };
  if (!signed) {
    const header = serializeSenderHeader(buildClaimHeader({ id: agentId, ...nameOpt }));
    return {
      id,
      note,
      input,
      expected: {
        header,
        header_bytes: enc.encode(header).length,
        header_wire_bytes: encodedHeaderLength(header),
      },
    };
  }
  const nonce = input.nonce!;
  const h = await signSenderHeader({
    signer,
    id: agentId,
    ...nameOpt,
    sub,
    payload,
    ts: FIXED_TS,
    nonce,
  });
  const signedInput = new TextDecoder().decode(
    buildSignedInput({
      account,
      user: signer.publicKey,
      subject: sub,
      ts: FIXED_TS,
      nonce,
      payloadSha256Hex: await sha256Hex(payload),
    }),
  );
  const header = serializeSenderHeader(h);
  return {
    id,
    note,
    input,
    expected: {
      signed_input: signedInput,
      sig: h.sig!,
      header,
      header_bytes: enc.encode(header).length,
      header_wire_bytes: encodedHeaderLength(header),
    },
  };
}

async function idSigVector(
  id: string,
  note: string,
  seed: string,
  account: string,
  agent: string,
  owner: string,
  promptSubject: string,
): Promise<IdSigVector> {
  const signer = signerFromSeed(seed);
  const agentId = newAgentId(account, signer.publicKey);
  const idSig = await signAgentId({ signer, id: agentId, agent, owner, promptSubject });
  const signedInput = new TextDecoder().decode(
    buildAgentIdSignedInput({
      user: agentIdUser(agentId),
      account: agentIdAccount(agentId),
      agent,
      owner,
      promptSubject,
    }),
  );
  return {
    id,
    note,
    input: { user: signer.publicKey, seed, account, agent, owner, prompt_subject: promptSubject },
    expected: {
      signed_input: signedInput,
      id_sig: idSig,
      metadata: {
        agent,
        owner,
        user_nkey: agentIdUser(agentId),
        account: agentIdAccount(agentId),
        id_sig: idSig,
      },
    },
  };
}

export async function generate(): Promise<{ sender: SenderVectorsFile; idSig: IdSigVectorsFile }> {
  const keys = JSON.parse(await readFile(join(FIXTURES_DIR, "keys.json"), "utf8")) as KeysFile;
  const alice = keys.users["alice"]!;
  const bob = keys.users["bob"]!;
  const envelope = enc.encode(JSON.stringify({ prompt: "hello" }));
  const promptSubject = "agents.prompt.demo-agent.alice.example";

  // Sanity: the spec's account key must still be a valid NKEY.
  createAccount(); // keeps the import meaningful for future operator-mode vectors
  const senderVectors: SenderVector[] = [
    await senderVector(
      "global-account-signed",
      "config-file server, no accounts ($G); JSON envelope",
      alice.seed,
      "$G",
      promptSubject,
      envelope,
    ),
    await senderVector(
      "named-account-signed",
      "config-file account name (ACME)",
      alice.seed,
      "ACME",
      promptSubject,
      envelope,
      { name: "claude-code" },
    ),
    await senderVector(
      "operator-account-signed",
      "operator-mode account NKEY (113-char agent ID)",
      alice.seed,
      SPEC_ACCOUNT_KEY,
      promptSubject,
      envelope,
      { name: "claude-code" },
    ),
    await senderVector(
      "empty-payload-status",
      "empty payload (a status request): sha256 of zero bytes",
      alice.seed,
      "$G",
      "agents.status.demo-agent.alice.example",
      new Uint8Array(0),
    ),
    await senderVector(
      "non-ascii-name",
      "non-ASCII display name serialised raw (no \\u escapes)",
      bob.seed,
      "APP",
      promptSubject,
      envelope,
      { name: "Bob · 日本語 🤖" },
    ),
    await senderVector(
      "renamed-import-sub",
      "caller behind its own account's `to:` rename publishes the local name and signs the exporter's subject",
      bob.seed,
      "APP",
      "local.agents.prompt.demo-agent.alice.example",
      envelope,
      { sub: promptSubject },
    ),
    await senderVector(
      "max-nonce",
      "64-character nonce (upper bound of the alphabet rule)",
      alice.seed,
      "$G",
      promptSubject,
      envelope,
      { nonce: "N".repeat(64) },
    ),
    await senderVector(
      "non-ascii-payload",
      "payload bytes with multi-byte UTF-8; hash is over the raw bytes",
      alice.seed,
      "$G",
      promptSubject,
      enc.encode(JSON.stringify({ prompt: "grüße 🌍" })),
    ),
    await senderVector(
      "unsigned-claim",
      "unsigned claim: exactly v, account, user, name",
      alice.seed,
      "$G",
      promptSubject,
      envelope,
      { name: "claude-code", signed: false },
    ),
    await senderVector(
      "unsigned-claim-no-name",
      "unsigned claim without a name: exactly v, account, user",
      alice.seed,
      "ACME",
      promptSubject,
      envelope,
      { signed: false },
    ),
  ];
  const idSigVectors: IdSigVector[] = [
    await idSigVector(
      "global-account",
      "default prompt subject on a $G server",
      alice.seed,
      "$G",
      "demo-agent",
      "alice",
      promptSubject,
    ),
    await idSigVector(
      "named-account",
      "config-file account name",
      alice.seed,
      "ACME",
      "demo-agent",
      "alice",
      promptSubject,
    ),
    await idSigVector(
      "operator-account",
      "operator-mode account NKEY",
      alice.seed,
      SPEC_ACCOUNT_KEY,
      "demo-agent",
      "alice",
      promptSubject,
    ),
    await idSigVector(
      "custom-prompt-subject",
      "the signature binds the advertised prompt subject, not the name-derived one",
      bob.seed,
      "APP",
      "custom-agent",
      "bob",
      "svc.custom.prompt",
    ),
    await idSigVector(
      "subject-token-abbrev",
      "metadata.agent differs from the wire token (subjectToken)",
      alice.seed,
      "$G",
      "claude-code",
      "alice",
      "agents.prompt.cc.alice.laptop",
    ),
  ];
  return {
    sender: {
      _comment:
        "Known-answer vectors for the Agent-Sender header (sender-identity extension). `expected.header` is the exact header value (UTF-8); `header_wire_bytes` adds the 28 framing bytes the server counts against max_payload. Seeds are the throwaway keys.json users. TEST-ONLY.",
      _generated_by: "client-sdk/typescript/scripts/generate-identity-vectors.ts",
      signed_input_format:
        "AGENT-SENDER-V1\\n{account}\\n{user}\\n{subject}\\n{ts}\\n{nonce}\\n{sha256(payload) lowercase hex}\\n",
      header_framing_bytes: 28,
      vectors: senderVectors,
    },
    idSig: {
      _comment:
        "Known-answer vectors for the AGENT-ID-V1 registration signature (`id_sig`). Verify `expected.id_sig` over `expected.signed_input` with `input.user`. Seeds are the throwaway keys.json users. TEST-ONLY.",
      _generated_by: "client-sdk/typescript/scripts/generate-identity-vectors.ts",
      signed_input_format:
        "AGENT-ID-V1\\n{user_nkey}\\n{account}\\n{agent}\\n{owner}\\n{prompt_subject}\\n",
      vectors: idSigVectors,
    },
  };
}

export function render(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main(): Promise<void> {
  const { sender, idSig } = await generate();
  const senderPath = join(FIXTURES_DIR, "sender-vectors.json");
  const idSigPath = join(FIXTURES_DIR, "id-sig-vectors.json");
  if (process.argv.includes("--check")) {
    const same =
      (await readFile(senderPath, "utf8")) === render(sender) &&
      (await readFile(idSigPath, "utf8")) === render(idSig);
    if (!same) {
      console.error("vectors are out of date — run without --check to regenerate");
      process.exit(1);
    }
    console.log("vectors are up to date");
    return;
  }
  await writeFile(senderPath, render(sender));
  await writeFile(idSigPath, render(idSig));
  console.log(`wrote ${senderPath}\nwrote ${idSigPath}`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  await main();
}
