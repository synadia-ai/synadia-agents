// `nats` CLI context loader and URL parser.
//
// Two entry points produce `@nats-io/transport-node` connection options:
//
//   - {@link loadContextOptions} — reads context files written by
//     `nats context add` / `nats context select` under `~/.config/nats`
//     (or $NATS_CONFIG_HOME / $XDG_CONFIG_HOME/nats).
//   - {@link parseNatsUrl} — parses a single NATS URL and extracts
//     credentials from `userinfo` if present (token, or user:pass).
//     The bare `@nats-io/transport-node` `connect({ servers })` does NOT
//     parse userinfo — it expects credentials as separate config fields —
//     but the `nats` CLI does, which causes a confusing UX gap. Use this
//     helper to bridge the two.
//
// Both return `NodeConnectionOptions` you can pass straight to `connect()`:
//
//     import { connect } from "@nats-io/transport-node";
//     import { Agents, loadContextOptions, parseNatsUrl } from "@synadia-ai/agents";
//
//     const opts = await loadContextOptions("prod");
//     // or:
//     const opts = parseNatsUrl("nats://TOKEN@nats.example.com:4222");
//
//     const nc = await connect(opts);
//     const agents = new Agents({ nc });
//
// Supported context fields: `url`, `creds` (path), `user_jwt`,
// `user`+`password`, `token`, `inbox_prefix`.
// Skipped: `nkey`, TLS cert/key/ca, `nsc` integration.
//
// Precedence inside a context: `creds` > `user_jwt` > `user`/`password`/`token`.
//
// `user_jwt` without an accompanying nkey seed leaves the CONNECT signature
// empty, so it only works against servers that do not require nonce signing.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { credsAuthenticator, jwtAuthenticator } from "@nats-io/nats-core";
import type { NodeConnectionOptions } from "@nats-io/transport-node";
import { NatsContextError } from "./errors.js";

/**
 * Resolve a NATS CLI context by name into `NodeConnectionOptions` ready to
 * pass to `connect()`. Pass `"current"` to resolve via `$NATS_CONTEXT` or
 * the `context.txt` selection file.
 */
export async function loadContextOptions(selector: string): Promise<NodeConnectionOptions> {
  const baseDir = resolveBaseDir();
  const name = selector === "current" ? await resolveCurrentName(baseDir) : selector;

  if (name.includes("/") || name.includes("\\") || name.includes("\0") || name === "..") {
    throw new NatsContextError(`invalid context name: "${name}"`);
  }
  const path = join(baseDir, "context", `${name}.json`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NatsContextError(`NATS context "${name}" not found at ${path}`);
    }
    throw err;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new NatsContextError(
      `NATS context "${name}" is not valid JSON: ${(err as Error).message}`,
    );
  }

  const url = str(parsed["url"]);
  if (!url) throw new NatsContextError(`NATS context "${name}" is missing \`url\``);
  const servers = url
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const opts: NodeConnectionOptions = { servers };

  const creds = str(parsed["creds"]);
  const userJwt = str(parsed["user_jwt"]);
  if (creds) {
    const credsPath = creds.startsWith("~/") ? join(homedir(), creds.slice(2)) : creds;
    const bytes = await readFile(credsPath);
    opts.authenticator = credsAuthenticator(
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
  } else if (userJwt) {
    opts.authenticator = jwtAuthenticator(userJwt);
  } else {
    const token = str(parsed["token"]);
    const user = str(parsed["user"]);
    const password = str(parsed["password"]);
    if (token) opts.token = token;
    if (user) opts.user = user;
    if (password) opts.pass = password;
  }

  const inboxPrefix = str(parsed["inbox_prefix"]);
  if (inboxPrefix) opts.inboxPrefix = inboxPrefix;

  return opts;
}

/**
 * Parse a NATS URL into `NodeConnectionOptions`, extracting credentials
 * from `userinfo` if present:
 *
 * - `nats://host:port`               → `{ servers: ["nats://host:port"] }`
 * - `nats://TOKEN@host:port`         → `{ servers: [...], token: "TOKEN" }`
 *   (single userinfo component is treated as a token, mirroring the
 *   `nats` CLI's behaviour)
 * - `nats://USER:PASS@host:port`     → `{ servers: [...], user: "USER", pass: "PASS" }`
 * - `tls://...`                      → same shapes, scheme preserved.
 *
 * Comma-separated multi-server URLs (`nats://a:4222,nats://b:4222`) are
 * split and userinfo is only honoured if it appears identically on every
 * server — otherwise this function throws (mixed credentials in a single
 * URL is almost certainly a bug; use a NATS context file for that case).
 *
 * Throws if the URL is unparseable, has no host, or uses a non-NATS scheme.
 *
 * @example
 *   import { connect } from "@nats-io/transport-node";
 *   import { parseNatsUrl } from "@synadia-ai/agents";
 *   const nc = await connect(parseNatsUrl("nats://abc123@nats.example.com:4222"));
 */
export function parseNatsUrl(url: string): NodeConnectionOptions {
  const parts = url
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new NatsContextError(`empty NATS URL: ${JSON.stringify(url)}`);
  }

  const parsedAll = parts.map((p) => parseSingleNatsUrl(p, url));

  // All servers must agree on userinfo (or all be bare). Mixed userinfo
  // across servers can't be expressed in a single ConnectionOptions.
  const first = parsedAll[0]!;
  for (const p of parsedAll.slice(1)) {
    if (
      p.token !== first.token ||
      p.user !== first.user ||
      p.pass !== first.pass
    ) {
      throw new NatsContextError(
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

interface ParsedNatsUrl {
  server: string; // protocol + host (no userinfo)
  token?: string;
  user?: string;
  pass?: string;
}

function parseSingleNatsUrl(part: string, original: string): ParsedNatsUrl {
  // Tolerate scheme-less entries (`host:port`) by prepending nats:// — this
  // mirrors what `@nats-io/transport-node` does internally for `servers`.
  const withScheme = /^[a-z]+:\/\//i.test(part) ? part : `nats://${part}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch (e) {
    throw new NatsContextError(
      `invalid NATS URL ${JSON.stringify(original)}: ${(e as Error).message}`,
    );
  }
  if (!/^(nats|tls|ws|wss):$/.test(parsed.protocol)) {
    throw new NatsContextError(
      `unsupported scheme "${parsed.protocol}" in NATS URL ${JSON.stringify(original)}`,
    );
  }
  if (!parsed.host) {
    throw new NatsContextError(
      `NATS URL ${JSON.stringify(original)} is missing a host`,
    );
  }

  const out: ParsedNatsUrl = { server: `${parsed.protocol}//${parsed.host}` };
  if (parsed.password !== "") {
    // user:password — both decoded
    out.user = decodeURIComponent(parsed.username);
    out.pass = decodeURIComponent(parsed.password);
  } else if (parsed.username !== "") {
    // Single userinfo component → token (matches `nats` CLI behaviour).
    out.token = decodeURIComponent(parsed.username);
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function resolveBaseDir(): string {
  const explicit = process.env["NATS_CONFIG_HOME"];
  if (explicit) {
    return explicit.startsWith("~/") ? join(homedir(), explicit.slice(2)) : explicit;
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg) return join(xdg, "nats");
  return join(homedir(), ".config", "nats");
}

async function resolveCurrentName(baseDir: string): Promise<string> {
  const envName = process.env["NATS_CONTEXT"];
  if (envName && envName.length > 0) return envName;
  const path = join(baseDir, "context.txt");
  try {
    const selected = (await readFile(path, "utf8")).trim();
    if (selected.length === 0) {
      throw new NatsContextError(`no NATS context is selected (empty ${path})`);
    }
    return selected;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NatsContextError(`no NATS context is selected ($NATS_CONTEXT unset, no ${path})`);
    }
    throw err;
  }
}
