// The `Agent-Sender` header on a heartbeat.
//
// To a receiver that requires signed heartbeats, an agent's presence is its
// signed heartbeat: the host sets an `Agent-Sender` header of the
// sender-identity extension on every heartbeat it publishes — `sub` the
// heartbeat subject as published, `ts` the heartbeat's own `ts`, a fresh
// nonce per beat, `sig` over subject · ts · nonce · sha256(the exact
// payload bytes published). No new payload field, no new signing format:
// the header of the sender-identity extension, unchanged, signed with the
// same signer that signs `id_sig`. A host without a signer beats unsigned,
// exactly as plain protocol 0.3 — a claim, never proof of presence — and a
// 0.3 subscriber ignores headers either way.

import { headers, type MsgHdrs } from "@nats-io/nats-core";
import {
  AGENT_SENDER_HEADER,
  serializeSenderHeader,
  signSenderHeader,
  type AgentId,
  type AgentSenderHeader,
  type SenderSigner,
} from "@synadia-ai/agents";

/** Who signs the heartbeats: the host's agent ID and the signer over its user NKEY seed. */
export interface HeartbeatSigner {
  readonly id: AgentId;
  readonly signer: SenderSigner;
}

export interface SignHeartbeatOptions {
  readonly sender: HeartbeatSigner;
  /** The heartbeat subject as published (`agents.hb.{agent}.{owner}.{name}`). */
  readonly subject: string;
  /** The heartbeat's own `ts`; the header carries the same instant. */
  readonly ts: string;
  /** The exact payload bytes published; the signature binds their SHA-256. */
  readonly data: Uint8Array;
  /** Override for tests / vectors; default: a fresh NUID per beat. */
  readonly nonce?: string;
}

/** Build and sign the `Agent-Sender` header of one heartbeat. */
export async function signHeartbeatHeader(opts: SignHeartbeatOptions): Promise<AgentSenderHeader> {
  return signSenderHeader({
    signer: opts.sender.signer,
    id: opts.sender.id,
    sub: opts.subject,
    payload: opts.data,
    ts: opts.ts,
    ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
  });
}

/** The message headers of one heartbeat: exactly one `Agent-Sender`, signed. */
export async function signHeartbeat(opts: SignHeartbeatOptions): Promise<MsgHdrs> {
  const h = headers();
  h.set(AGENT_SENDER_HEADER, serializeSenderHeader(await signHeartbeatHeader(opts)));
  return h;
}
