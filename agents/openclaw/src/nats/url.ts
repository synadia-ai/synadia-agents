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

interface ParsedSingle {
  server: string;
  token?: string;
  user?: string;
  pass?: string;
}

/**
 * Parse a NATS URL into options ready to pass to `connect()`.
 *
 *   parseNatsUrl("nats://host:4222")               → { servers: ["nats://host:4222"] }
 *   parseNatsUrl("nats://TOKEN@host:4222")         → { servers, token: "TOKEN" }
 *   parseNatsUrl("nats://USER:PASS@host:4222")     → { servers, user, pass }
 *   parseNatsUrl("host:4222")                      → { servers: ["nats://host:4222"] }
 *
 * Supports comma-separated cluster URLs (the form `@nats-io/transport-node`
 * accepts via `servers: string`):
 *
 *   parseNatsUrl("nats://h1:4222,nats://h2:4222")  → { servers: [...] }
 *
 * For cluster URLs, userinfo (if present) MUST be identical on every
 * entry — mixed credentials in a single URL string can't be expressed as
 * one ConnectionOptions and would otherwise silently drop credentials.
 *
 * `tls://`, `ws://`, `wss://` schemes are preserved on output. Throws on
 * unparseable URL, unsupported scheme, missing host, empty input, or
 * mixed credentials across cluster entries.
 */
export function parseNatsUrl(url: string): NodeConnectionOptions {
  const parts = url
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error(`empty NATS URL: ${JSON.stringify(url)}`);
  }

  const parsedAll = parts.map((p) => parseSingleNatsUrl(p, url));

  // All servers in a comma-separated cluster URL must agree on userinfo.
  // Mixed userinfo can't be expressed in one ConnectionOptions.
  const first = parsedAll[0]!;
  for (const p of parsedAll.slice(1)) {
    if (p.token !== first.token || p.user !== first.user || p.pass !== first.pass) {
      throw new Error(
        `NATS URL has mixed credentials across server entries: ${url}`,
      );
    }
  }

  const opts: NodeConnectionOptions = {
    servers: parsedAll.map((p) => p.server),
  };
  if (first.token !== undefined) opts.token = first.token;
  if (first.user !== undefined) opts.user = first.user;
  if (first.pass !== undefined) opts.pass = first.pass;
  return opts;
}

function parseSingleNatsUrl(part: string, original: string): ParsedSingle {
  // Tolerate scheme-less input ("host:port"); `@nats-io/transport-node`
  // does the same thing for the `servers` array.
  const withScheme = /^[a-z]+:\/\//i.test(part) ? part : `nats://${part}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch (e) {
    throw new Error(
      `invalid NATS URL ${JSON.stringify(original)}: ${(e as Error).message}`,
    );
  }
  if (!SUPPORTED_SCHEMES.test(parsed.protocol)) {
    throw new Error(
      `unsupported scheme "${parsed.protocol}" in NATS URL ${JSON.stringify(original)}`,
    );
  }
  if (!parsed.host) {
    throw new Error(`NATS URL ${JSON.stringify(original)} is missing a host`);
  }

  const out: ParsedSingle = { server: `${parsed.protocol}//${parsed.host}` };

  // WHATWG `URL` squashes `nats://user@host` and `nats://user:@host` into
  // `password === ""`, losing the colon-separator intent. Sniff the raw
  // input for `:` in the userinfo to recover whether it was user:password
  // form (even with empty password) or a single-component token.
  const userinfoMatch = withScheme.match(/^[a-z]+:\/\/([^/@]*)@/i);
  const hasColonSeparator = (userinfoMatch?.[1] ?? "").includes(":");

  if (hasColonSeparator) {
    out.user = decodeURIComponent(parsed.username);
    out.pass = decodeURIComponent(parsed.password);
  } else if (parsed.username !== "") {
    out.token = decodeURIComponent(parsed.username);
  }
  return out;
}
