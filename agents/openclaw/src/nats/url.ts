// Parse a NATS URL into `NodeConnectionOptions`, extracting credentials
// from `userinfo` if present.
//
// `@nats-io/transport-node`'s `connect({ servers: url })` does NOT parse
// userinfo — it expects credentials as separate config fields — but the
// `nats` CLI does, which causes a confusing UX gap whenever a user pastes
// a `nats://TOKEN@host:port` URL into a config that takes a plain `url`
// field. This helper closes the gap.
//
// Mirrors the `@synadia-ai/agents` SDK's `parseNatsUrl`. Inlined here
// because openclaw deliberately does not depend on the SDK package — per
// the repo CLAUDE.md "Agents do NOT depend on the SDK" rule, agents share
// only the wire protocol with the SDK; small helpers are duplicated.

import type { NodeConnectionOptions } from "@nats-io/transport-node";

const SUPPORTED_SCHEMES = /^(nats|tls|ws|wss):$/;

/**
 * Parse a NATS URL into options ready to pass to `connect()`.
 *
 *   parseNatsUrl("nats://host:4222")               → { servers: "nats://host:4222" }
 *   parseNatsUrl("nats://TOKEN@host:4222")         → { servers, token: "TOKEN" }
 *   parseNatsUrl("nats://USER:PASS@host:4222")     → { servers, user, pass }
 *   parseNatsUrl("host:4222")                      → { servers: "nats://host:4222" }
 *
 * `tls://`, `ws://`, `wss://` schemes are preserved on output. Throws on
 * unparseable URL, unsupported scheme, or missing host.
 */
export function parseNatsUrl(url: string): NodeConnectionOptions {
  // Tolerate scheme-less input ("host:port"); `@nats-io/transport-node`
  // does the same thing for the `servers` array.
  const withScheme = /^[a-z]+:\/\//i.test(url) ? url : `nats://${url}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch (e) {
    throw new Error(
      `invalid NATS URL ${JSON.stringify(url)}: ${(e as Error).message}`,
    );
  }
  if (!SUPPORTED_SCHEMES.test(parsed.protocol)) {
    throw new Error(
      `unsupported scheme "${parsed.protocol}" in NATS URL ${JSON.stringify(url)}`,
    );
  }
  if (!parsed.host) {
    throw new Error(`NATS URL ${JSON.stringify(url)} is missing a host`);
  }

  const opts: NodeConnectionOptions = {
    servers: `${parsed.protocol}//${parsed.host}`,
  };

  // WHATWG `URL` squashes `nats://user@host` and `nats://user:@host` into
  // `password === ""`, losing the colon-separator intent. Sniff the raw
  // input for `:` in the userinfo to recover whether it was user:password
  // form (even with empty password) or a single-component token.
  const userinfoMatch = withScheme.match(/^[a-z]+:\/\/([^/@]*)@/i);
  const hasColonSeparator = (userinfoMatch?.[1] ?? "").includes(":");

  if (hasColonSeparator) {
    opts.user = decodeURIComponent(parsed.username);
    opts.pass = decodeURIComponent(parsed.password);
  } else if (parsed.username !== "") {
    opts.token = decodeURIComponent(parsed.username);
  }
  return opts;
}
