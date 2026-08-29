// `Nats-Request-Info` — the stamp the server writes on a request that
// crosses a service import (`acc`, plus `user` behind `share: true`).
//
// On an open endpoint a receiver cannot tell that stamp from a forgery
// (spec "How we transport the agent identity on the wire": same-account
// traffic carries a client-written header verbatim), so the SDK reads it
// **only in operator-attested mode** (spec Appendix A), where the
// deployment declared the endpoint closed. Everywhere else the header is
// never looked at.

import type { MsgHdrs } from "@nats-io/nats-core";

/** The header name — matched case-sensitively. */
export const NATS_REQUEST_INFO_HEADER = "Nats-Request-Info";

/** The two identity fields of a server stamp; everything else is ignored. */
export interface RequestInfoStamp {
  /**
   * `acc` — the caller's account as the server names it: the account
   * public key on an operator-mode server, the configured name otherwise.
   * Present on every stamp.
   */
  readonly account?: string;
  /** `user` — the caller's user public key. Present only behind a `share: true` import. */
  readonly user?: string;
}

/**
 * Parse a header value. `null` when it is not what the server would write:
 * not a JSON object, or `acc` / `user` present but not strings. Unknown
 * fields (`rtt`, `server`, `jwt`, `issuer_key`, …) are ignored.
 *
 * Deliberately no size cap (unlike `parseSenderHeader`'s 2 KiB): behind a
 * `share: true` import the server's stamp embeds the caller's whole user
 * JWT, which grows with its permission lists — a cap would refuse
 * legitimate stamps. The value is only ever parsed under operator-attested
 * mode, where it is the server's, and the broker's `max_payload` bounds it.
 */
export function parseRequestInfo(value: string): RequestInfoStamp | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const acc = o["acc"];
  const user = o["user"];
  if (acc !== undefined && typeof acc !== "string") return null;
  if (user !== undefined && typeof user !== "string") return null;
  return Object.freeze({
    ...(acc !== undefined ? { account: acc } : {}),
    ...(user !== undefined ? { user } : {}),
  });
}

/**
 * Read the stamp from message headers: `undefined` when the header is
 * absent, `null` when it is present but malformed — or present more than
 * once, which the server never produces. Exact-case header name.
 */
export function readRequestInfo(headers: MsgHdrs | undefined): RequestInfoStamp | null | undefined {
  if (!headers) return undefined;
  const values = headers.values(NATS_REQUEST_INFO_HEADER);
  if (values.length === 0) return undefined;
  if (values.length > 1) return null;
  return parseRequestInfo(values[0] ?? "");
}
