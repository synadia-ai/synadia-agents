// Internal: the identity state an `Agents` client owns and threads into
// every `Agent` it hands out — signer, display name, the unsigned-claim
// policy, and the per-connection-and-identity-source `selfId()` memo.
//
// The cost rule (plan §2.1a): a request awaits the identity lookup at most
// once per connection and identity source. Afterwards a memoised answer is
// used. An unsigned configuration may proceed without a header after a
// lookup failure and retry an expired failure in the background. A signer
// configuration always propagates the failure and awaits retries; it never
// silently downgrades.

import type { NatsConnection } from "@nats-io/nats-core";
import { IdentityMismatchError, NoIdentityError, SenderSignatureRequiredError } from "../errors.js";
import type { AgentId } from "./agent-id.js";
import {
  assertValidSenderName,
  buildClaimHeader,
  expectedSenderHeaderBytes,
  signSenderHeader,
  type AgentSenderHeader,
} from "./sender-header.js";
import {
  peekSelfId,
  refreshSelfId,
  selfId,
  selfIdFailureExpired,
  startSelfIdLookup,
  type SelfIdSettled,
} from "./self-id.js";
import type { SenderSigner } from "./signer.js";

/** `AgentsOptions.identity`. */
export interface IdentityOptions {
  /** Signs `Agent-Sender` / `id_sig`. Without it the SDK can only send unsigned claims. */
  readonly signer?: SenderSigner;
  /** Display name carried in the header (`name`, ≤ 64 chars, no control characters). Metadata only. */
  readonly name?: string;
  /**
   * Send an unsigned claim (`v, account, user, name?`) when the identity
   * is known but no signer is configured. Default `true`. Note it
   * discloses the caller's user NKEY to every receiver.
   */
  readonly sendUnsignedClaim?: boolean;
}

/** What the SDK will attach to one request: known before signing, signed at publish time. */
export interface SenderHeaderPlan {
  readonly id: AgentId;
  /** `true` → signed at `build()`; `false` → an unsigned claim. */
  readonly signed: boolean;
  /** The subject that will be signed (`sub`). */
  readonly sub: string;
  /** Exact framed wire size of the header `build()` produces. */
  readonly wireBytes: number;
  /**
   * Build the header over the exact payload bytes — a fresh `ts` each
   * call, and a fresh nonce unless `nonce` names one. A signed record
   * whose body carries its own id (an edge record's `record_id`) passes
   * it here, so the header's nonce, `Nats-Msg-Id` and the body agree.
   */
  build(payload: Uint8Array, nonce?: string): Promise<AgentSenderHeader>;
}

export class IdentityContext {
  readonly nc: NatsConnection;
  readonly signer: SenderSigner | undefined;
  readonly name: string | undefined;
  readonly sendUnsignedClaim: boolean;

  constructor(nc: NatsConnection, opts: IdentityOptions = {}) {
    if (opts.name !== undefined) assertValidSenderName(opts.name);
    this.nc = nc;
    this.signer = opts.signer;
    this.name = opts.name;
    this.sendUnsignedClaim = opts.sendUnsignedClaim ?? true;
  }

  selfId(): Promise<AgentId> {
    return selfId(this.nc, this.#selfIdOptions());
  }

  refresh(): Promise<AgentId> {
    return refreshSelfId(this.nc, this.#selfIdOptions());
  }

  peek(): SelfIdSettled | undefined {
    return peekSelfId(this.nc, this.#selfIdOptions());
  }

  /** Start the lookup without waiting (`discover()` calls this). */
  kickoff(): void {
    if (!this.signer && !this.sendUnsignedClaim) return;
    startSelfIdLookup(this.nc, this.#selfIdOptions());
  }

  /**
   * Synchronous: could the next request carry a header? Governs the
   * size bound applied before any async work. `true` with a signer, or
   * with unsigned claims enabled unless the memo already holds a
   * `NoIdentityError`.
   */
  mayAttachHeader(): boolean {
    if (this.signer) return true;
    if (!this.sendUnsignedClaim) return false;
    const settled = this.peek();
    return !(
      settled !== undefined &&
      "error" in settled &&
      settled.error instanceof NoIdentityError
    );
  }

  /**
   * The identity for one request per the cost rule, or `undefined` when
   * the request goes out without a header. `IdentityMismatchError` always
   * propagates; all identity errors propagate when `requireSigned` or a
   * signer is configured.
   */
  async resolveForRequest(requireSigned: boolean): Promise<AgentId | undefined> {
    // A configured signer is an explicit request for signed identity. Any
    // failure to bind it to the live connection is fatal even when the
    // target is permissive; never silently downgrade to no header.
    const identityRequired = requireSigned || this.signer !== undefined;
    const settled = this.peek();
    if (settled !== undefined) {
      if ("id" in settled) return settled.id;
      if (settled.error instanceof IdentityMismatchError || identityRequired) throw settled.error;
      return undefined;
    }
    if (!identityRequired && selfIdFailureExpired(this.nc, this.#selfIdOptions())) {
      this.kickoff();
      return undefined;
    }
    try {
      return await this.selfId();
    } catch (err) {
      if (err instanceof IdentityMismatchError || identityRequired) throw err;
      return undefined;
    }
  }

  /**
   * Plan the header for a request to `sub`. `undefined` when none will be
   * sent. Throws `SenderSignatureRequiredError` when `requireSigned` and
   * no signer is configured (callers normally check that synchronously).
   */
  async plan(sub: string, requireSigned: boolean): Promise<SenderHeaderPlan | undefined> {
    const signer = this.signer;
    if (requireSigned && !signer) throw new SenderSignatureRequiredError(sub);
    if (!signer && !this.sendUnsignedClaim) return undefined;
    const id = await this.resolveForRequest(requireSigned);
    if (id === undefined) return undefined;
    const name = this.name;
    const nameOpt = name !== undefined ? { name } : {};
    if (signer) {
      return {
        id,
        signed: true,
        sub,
        wireBytes: expectedSenderHeaderBytes({ id, ...nameOpt, sub, signed: true }),
        build: (payload, nonce) =>
          signSenderHeader({
            signer,
            id,
            ...nameOpt,
            sub,
            payload,
            ...(nonce !== undefined ? { nonce } : {}),
          }),
      };
    }
    const claim = buildClaimHeader({ id, ...nameOpt });
    return {
      id,
      signed: false,
      sub,
      wireBytes: expectedSenderHeaderBytes({ id, ...nameOpt, sub, signed: false }),
      build: () => Promise.resolve(claim),
    };
  }

  #selfIdOptions(): { signer?: SenderSigner } {
    return this.signer ? { signer: this.signer } : {};
  }
}
