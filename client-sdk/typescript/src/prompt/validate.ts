// Pure: local validation per spec §5.4. These checks MUST run before the
// request hits the wire; failing here saves a round trip and agent resources.

import type { EndpointInfo } from "../discovery/endpoint-info.js";
import { AttachmentsNotSupportedError, PayloadTooLargeError, PromptEmptyError } from "../errors.js";

export function assertPromptNonEmpty(text: string): void {
  if (text.length === 0) throw new PromptEmptyError();
}

export function assertAttachmentsAllowed(
  attachmentsPresent: boolean,
  endpoint: EndpointInfo,
): void {
  if (!attachmentsPresent) return;
  if (endpoint.attachmentsOk === false) throw new AttachmentsNotSupportedError();
}

/**
 * Two caps bind a publish:
 *
 * 1. `endpoint.maxPayloadBytes` — the agent's advertised limit (from its
 *    `$SRV.INFO` metadata, §2.1). What the *agent's* broker accepts.
 * 2. `connectionMaxPayload` — the *caller's* own `nc.info.max_payload`
 *    (from the local NATS server's INFO block). What the broker holding
 *    the caller's connection will publish at all. In multi-cluster /
 *    per-account deployments this can be smaller than the agent's
 *    advertised cap, in which case the caller's broker rejects the
 *    publish with `MAX_PAYLOAD_VIOLATION` before it ever reaches the
 *    agent.
 *
 * The effective cap is the smaller of whichever are set. `undefined`
 * for either means "not declared / not known" — when both are
 * `undefined` we don't enforce locally and let the server decide
 * (§5.4 last paragraph).
 */
export function assertWithinMaxPayload(
  encodedByteSize: number,
  endpoint: EndpointInfo,
  connectionMaxPayload?: number,
): void {
  const endpointLimit = endpoint.maxPayloadBytes;
  const connLimit =
    connectionMaxPayload !== undefined && connectionMaxPayload > 0
      ? connectionMaxPayload
      : undefined;

  let effective: number | undefined;
  if (endpointLimit !== undefined && connLimit !== undefined) {
    effective = Math.min(endpointLimit, connLimit);
  } else {
    effective = endpointLimit ?? connLimit;
  }
  if (effective === undefined) return;
  if (encodedByteSize > effective) {
    throw new PayloadTooLargeError(effective, encodedByteSize);
  }
}
