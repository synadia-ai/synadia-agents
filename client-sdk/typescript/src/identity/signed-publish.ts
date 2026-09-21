// Signing an arbitrary publish with a client's sender identity: the core of
// `Agents.signSender` / `publishSigned` / `requestSigned`, shared with the
// signing handle a prompt interceptor receives (`prompt/interceptor.ts`),
// so a message an interceptor publishes is signed exactly like one the
// application publishes itself.

import { headers, type MsgHdrs } from "@nats-io/nats-core";
import { IdentityError, SenderSignatureRequiredError } from "../errors.js";
import type { IdentityContext } from "./context.js";
import {
  AGENT_SENDER_HEADER,
  isValidSenderNonce,
  serializeSenderHeader,
  type AgentSenderHeader,
} from "./sender-header.js";

/** JetStream de-duplication header; `publishSigned` sets it to the nonce. */
export const NATS_MSG_ID_HEADER = "Nats-Msg-Id";

/** Options for the signed low-level wrappers. */
export interface SignedPublishOptions {
  /**
   * Subject to sign instead of the publish subject — only for a caller
   * whose own account renamed the import (sign the exporter's subject).
   */
  readonly sub?: string;
  /** Existing headers to add `Agent-Sender` (and `Nats-Msg-Id`) to. */
  readonly headers?: MsgHdrs;
  /**
   * The header's nonce, in place of a fresh one — for a message whose body
   * carries its own id: sign with that id and it is the nonce and the
   * `Nats-Msg-Id` as well, so a reader de-duplicating on `(user, nonce)`
   * and a stream de-duplicating on the message id see one message once.
   * Must match `[A-Za-z0-9_-]{1,64}` and be unique per signer: a receiver
   * refuses a nonce it has already seen from the same user.
   */
  readonly nonce?: string;
}

/**
 * The signed `Agent-Sender` header for a publish of `payload` to `subject`.
 * Rejects with {@link SenderSignatureRequiredError} when no signer is
 * configured, with {@link IdentityError} for a malformed `nonce`, else with
 * the `selfId()` error when the identity is unavailable.
 */
export async function signedSenderHeader(
  identity: IdentityContext | undefined,
  subject: string,
  payload: Uint8Array,
  opts: Pick<SignedPublishOptions, "sub" | "nonce">,
): Promise<AgentSenderHeader> {
  if (!identity?.signer) throw new SenderSignatureRequiredError(subject);
  const nonce = opts.nonce;
  if (nonce !== undefined && !isValidSenderNonce(nonce)) {
    throw new IdentityError("nonce must match [A-Za-z0-9_-]{1,64}");
  }
  const plan = await identity.plan(opts.sub ?? subject, true);
  if (!plan) throw new SenderSignatureRequiredError(subject); // unreachable with a signer
  return plan.build(payload, nonce);
}

/** {@link signedSenderHeader}, set on `opts.headers` (or fresh ones) with its `Nats-Msg-Id`. */
export async function signedPublishHeaders(
  identity: IdentityContext | undefined,
  subject: string,
  payload: Uint8Array,
  opts: SignedPublishOptions,
): Promise<MsgHdrs> {
  const h = await signedSenderHeader(identity, subject, payload, opts);
  const hdrs = opts.headers ?? headers();
  hdrs.set(AGENT_SENDER_HEADER, serializeSenderHeader(h));
  if (h.nonce !== undefined) hdrs.set(NATS_MSG_ID_HEADER, h.nonce);
  return hdrs;
}

export function toBytes(payload: Uint8Array | string): Uint8Array {
  return typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
}
