// `id_sig` — the registration signature that makes the agent ID in the
// service metadata verifiable (spec "Registration"). Signed input (never
// sent; note the field order — `user` first, unlike `AGENT-SENDER-V1`):
//
//   AGENT-ID-V1\n{user_nkey}\n{account}\n{agent}\n{owner}\n{prompt_subject}\n
//
// A verifier rebuilds it from the `user_nkey`, `account`, `agent`, `owner`
// metadata and the `prompt` endpoint's subject, all from one `$SRV.INFO`
// reply. Verification is synchronous (nkeys `verify` is sync).

import { agentIdAccount, agentIdUser, assertValidUserKey, type AgentId } from "./agent-id.js";
import { base64UrlDecode, base64UrlEncode, utf8, verifyWithPublicKey } from "./crypto.js";
import type { SenderSigner } from "./signer.js";

export const AGENT_ID_SIGNED_INPUT_TAG = "AGENT-ID-V1";

/** The three metadata keys the host registers. */
export const IDENTITY_METADATA_KEYS = Object.freeze({
  userNkey: "user_nkey",
  account: "account",
  idSig: "id_sig",
});

export interface AgentIdSignedInputFields {
  readonly user: string;
  readonly account: string;
  readonly agent: string;
  readonly owner: string;
  readonly promptSubject: string;
}

export function buildAgentIdSignedInput(f: AgentIdSignedInputFields): Uint8Array {
  return utf8.encode(
    `${AGENT_ID_SIGNED_INPUT_TAG}\n${f.user}\n${f.account}\n${f.agent}\n${f.owner}\n${f.promptSubject}\n`,
  );
}

export interface SignAgentIdOptions {
  readonly signer: SenderSigner;
  readonly id: AgentId;
  readonly agent: string;
  readonly owner: string;
  readonly promptSubject: string;
}

/** Produce the base64url `id_sig` value for the registration metadata. */
export async function signAgentId(opts: SignAgentIdOptions): Promise<string> {
  const input = buildAgentIdSignedInput({
    user: agentIdUser(opts.id),
    account: agentIdAccount(opts.id),
    agent: opts.agent,
    owner: opts.owner,
    promptSubject: opts.promptSubject,
  });
  return base64UrlEncode(await opts.signer.sign(input));
}

/**
 * Verify a service record's `id_sig` against its own `prompt` endpoint
 * subject. `false` when any field is missing, the key or signature is
 * malformed, or the signature does not verify.
 */
export function verifyAgentId(
  metadata: Readonly<Record<string, string | undefined>>,
  promptSubject: string,
): boolean {
  const user = metadata[IDENTITY_METADATA_KEYS.userNkey];
  const account = metadata[IDENTITY_METADATA_KEYS.account];
  const agent = metadata["agent"];
  const owner = metadata["owner"];
  const idSig = metadata[IDENTITY_METADATA_KEYS.idSig];
  if (
    user === undefined ||
    account === undefined ||
    agent === undefined ||
    owner === undefined ||
    idSig === undefined
  ) {
    return false;
  }
  let sig: Uint8Array;
  try {
    assertValidUserKey(user);
    sig = base64UrlDecode(idSig);
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  return verifyWithPublicKey(
    user,
    buildAgentIdSignedInput({ user, account, agent, owner, promptSubject }),
    sig,
  );
}
