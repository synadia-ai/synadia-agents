// Thin adapter around `@synadia-ai/agents`'s `loadContextOptions` that
// returns the narrow `{url, credentials?}` shape openclaw's
// `accounts.ts` and `connection.ts` consume.
//
// The SDK helper produces a full `NodeConnectionOptions` blob (with
// authenticator already constructed for creds / nkey / jwt+seed and
// `tls` populated for cert/key/ca/tls_first). For the common case
// openclaw configures today — direct URL or context with creds —
// we pull just the URL (servers, joined with commas to round-trip
// through `parseNatsUrl` later) plus an optional creds path.
//
// Limitations of this narrow layer (deliberate, follow-up work):
// nkey, inline `user_jwt` (+/- `user_seed`), and the TLS triple
// drop on this code path because openclaw's existing internal config
// shape (`{ url, credentials }`) doesn't carry them. The SDK supports
// all of those today; widening openclaw's `ConnectionConfig` to splat
// the full `NodeConnectionOptions` is a follow-up.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONTEXT_DIR_PARTS = [".config", "nats", "context"];

interface RawNatsContext {
  url?: string;
  token?: string;
  user?: string;
  password?: string;
  creds?: string;
}

export interface NatsContextResolved {
  /**
   * Server URL with credentials folded into userinfo, ready to hand to
   * the SDK's `parseNatsUrl()` at connect time.
   */
  url: string;
  /** Path to a nats user-creds file, if the context declared one. */
  credentials?: string;
}

/**
 * Load a context by name and return what openclaw cares about: a URL
 * (with token / user:password folded in if the context had them), plus
 * an optional credentials path.
 *
 * Throws on missing file, malformed JSON, or missing `url` field.
 *
 * Synchronous I/O matches the existing call shape in `accounts.ts`.
 * The path-traversal guard mirrors what the SDK's `loadContextOptions`
 * applies — kept here so a misconfigured `$NATS_CONTEXT` fails fast
 * before we even hit the filesystem.
 */
export function loadNatsContextFromFile(name: string): NatsContextResolved {
  if (
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name === ".." ||
    name.startsWith(".")
  ) {
    throw new Error(
      `NATS context name ${JSON.stringify(name)} is invalid (must not contain path separators or start with '.')`,
    );
  }
  const path = join(homedir(), ...CONTEXT_DIR_PARTS, `${name}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `NATS context "${name}" not found at ${path}: ${(err as Error).message}`,
    );
  }
  let parsed: RawNatsContext;
  try {
    parsed = JSON.parse(raw) as RawNatsContext;
  } catch (err) {
    throw new Error(
      `NATS context "${name}" is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed.url || typeof parsed.url !== "string") {
    throw new Error(`NATS context "${name}" is missing 'url'`);
  }

  // Fold token / user:password into userinfo so the SDK's `parseNatsUrl`
  // path in `connection.ts` extracts them at connect time. Comma-separated
  // cluster URLs round-trip per-entry.
  let urlWithAuth = parsed.url;
  if (parsed.token !== undefined && parsed.token !== "") {
    urlWithAuth = injectUserinfo(parsed.url, parsed.token);
  } else if (parsed.user !== undefined && parsed.user !== "") {
    urlWithAuth = injectUserinfo(parsed.url, parsed.user, parsed.password ?? "");
  }

  const out: NatsContextResolved = { url: urlWithAuth };
  if (parsed.creds && typeof parsed.creds === "string" && parsed.creds.length > 0) {
    out.credentials = expandHome(parsed.creds);
  }
  return out;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

/**
 * Inject userinfo into a NATS URL. Handles single URLs and comma-separated
 * cluster URLs (each entry gets the same userinfo). Returns the original
 * url unchanged on parse failure (defensive — `parseNatsUrl` will surface
 * the same parse error at connect time with a more actionable message).
 */
function injectUserinfo(url: string, usernameRaw: string, passwordRaw?: string): string {
  // Build the URL string manually rather than via `new URL()` + `.toString()`
  // because WHATWG `URL` collapses `nats://user:@host` (empty password) to
  // `nats://user@host` on serialisation — the spec treats both as
  // equivalent. But the SDK's `parseNatsUrl` uses the colon to discriminate
  // user/pass from a single-component token, so we have to preserve it.
  const parts = url
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return url;
  const rebuilt: string[] = [];
  for (const part of parts) {
    const withScheme = /^[a-z]+:\/\//i.test(part) ? part : `nats://${part}`;
    const match = withScheme.match(/^([a-z]+:\/\/)([^/?#]*)([/?#].*)?$/i);
    if (!match) return url;
    const scheme = match[1]!;
    const authority = match[2]!;
    const rest = match[3] ?? "";
    const atIdx = authority.lastIndexOf("@");
    const hostPart = atIdx >= 0 ? authority.slice(atIdx + 1) : authority;
    if (!hostPart) return url;
    const userEnc = encodeURIComponent(usernameRaw);
    const userinfo =
      passwordRaw === undefined ? userEnc : `${userEnc}:${encodeURIComponent(passwordRaw)}`;
    rebuilt.push(`${scheme}${userinfo}@${hostPart}${rest}`);
  }
  return rebuilt.join(",");
}
