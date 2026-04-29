// Minimal `nats` CLI context-file loader for openclaw.
//
// Reads files under `~/.config/nats/context/<name>.json` written by
// `nats context add` / `nats context save`, and translates them into
// the small subset openclaw needs: the `url` (with credentials folded
// into userinfo so `parseNatsUrl` can extract them at connect time),
// plus an optional `credentials` path for nats user-creds files.
//
// Inlined per the repo CLAUDE.md "Agents do NOT depend on the SDK"
// rule. This file is openclaw-specific and intentionally narrower than
// the @synadia-ai/agents SDK's `loadContextOptions` — it only honours
// fields openclaw can actually use today (url, token, user, password,
// creds). nkey / user_jwt / TLS triple are not supported here; users
// who need those should configure auth on the openclaw account directly.

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
   * `parseNatsUrl()`. Round-trip safe via WHATWG `URL`.
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
 */
export function loadNatsContextFromFile(name: string): NatsContextResolved {
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

  // Fold token / user:password into userinfo so the existing
  // `parseNatsUrl` path in connection.ts extracts them at connect time.
  // Comma-separated cluster URLs round-trip via WHATWG `URL` per-entry.
  let urlWithAuth = parsed.url;
  if (parsed.token !== undefined && parsed.token !== "") {
    urlWithAuth = injectUserinfo(parsed.url, parsed.token);
  } else if (parsed.user !== undefined && parsed.user !== "") {
    urlWithAuth = injectUserinfo(parsed.url, parsed.user, parsed.password);
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
  const parts = url.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return url;
  const rebuilt: string[] = [];
  for (const part of parts) {
    const withScheme = /^[a-z]+:\/\//i.test(part) ? part : `nats://${part}`;
    try {
      const u = new URL(withScheme);
      u.username = encodeURIComponent(usernameRaw);
      if (passwordRaw !== undefined) u.password = encodeURIComponent(passwordRaw);
      rebuilt.push(u.toString());
    } catch {
      return url; // give up, hand the original back
    }
  }
  return rebuilt.join(",");
}
