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
// Supported context fields: `url`, `creds` (path), `nkey` (path),
// `user_jwt` (+ optional `user_seed` for nonce signing), `user`+`password`,
// `token`, `inbox_prefix`, plus the TLS file triple `cert`/`key`/`ca` and
// `tls_first`.
// Skipped: `nsc` integration.
//
// File-path fields (`creds`, `nkey`, and the TLS triple) expand a leading
// `~/` to the home directory; any other relative path resolves against the
// process working directory (as the `nats` CLI does), not the context
// file's directory.
//
// Precedence inside a context: `creds` > `nkey` > `user_jwt` (+`user_seed`
// when present) > `user`/`password` > `token`.
//
// `user_jwt` without an accompanying nkey seed leaves the CONNECT signature
// empty, so it only works against servers that do not require nonce signing.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { credsAuthenticator, jwtAuthenticator, nkeyAuthenticator } from "@nats-io/nats-core";
import type { NodeConnectionOptions } from "@nats-io/transport-node";
import { NatsContextError } from "./errors.js";

/** A NATS CLI context file, read but not yet turned into connection options. */
export interface NatsContextFile {
  /** The resolved context name (after `"current"` resolution). */
  readonly name: string;
  /** Absolute path of the context JSON file. */
  readonly path: string;
  /** The parsed JSON object, verbatim. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * Auth material selected from one context-file read. Internal contract for
 * `resolveNatsConnectionBundle`; raw bytes are never exported from the
 * package root or included in logs/errors.
 *
 * @internal
 */
export type ContextAuthSnapshot =
  | { readonly kind: "creds"; readonly bytes: Uint8Array }
  | { readonly kind: "nkey"; readonly bytes: Uint8Array }
  | { readonly kind: "jwt-seed"; readonly jwt: string; readonly seed: Uint8Array }
  | { readonly kind: "jwt" }
  | { readonly kind: "user-password" }
  | { readonly kind: "token" }
  | { readonly kind: "none" };

/**
 * Connection options plus the exact auth snapshot used to build their
 * authenticator. Internal so the connection-bundle helper can derive a
 * signer without re-reading a context or credential file.
 *
 * @internal
 */
export interface ContextConnectionSnapshot {
  readonly name: string;
  readonly connectionOptions: NodeConnectionOptions;
  readonly auth: ContextAuthSnapshot;
  /** Zero retained auth bytes. Call only after the connection is closed. */
  wipe(): void;
}

/**
 * Read a NATS CLI context by name. Pass `"current"` to resolve via
 * `$NATS_CONTEXT` or the `context.txt` selection file. This is the
 * *reading* half of {@link loadContextOptions}; `signerFromContext` in the
 * identity module reuses it to find the seed / creds path without
 * building connection options.
 */
export async function readContextFile(selector: string): Promise<NatsContextFile> {
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new NatsContextError(
      `NATS context "${name}" is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NatsContextError(`NATS context "${name}" is not a JSON object`);
  }
  return { name, path, fields: parsed as Record<string, unknown> };
}

/**
 * Resolve a NATS CLI context by name into `NodeConnectionOptions` ready to
 * pass to `connect()`. Pass `"current"` to resolve via `$NATS_CONTEXT` or
 * the `context.txt` selection file.
 */
export async function loadContextOptions(selector: string): Promise<NodeConnectionOptions> {
  return (await loadContextConnectionSnapshot(selector)).connectionOptions;
}

/**
 * Resolve a context once, retaining the selected auth bytes long enough for
 * both the NATS authenticator and an optional sender signer to consume the
 * same snapshot. Not exported from the package root.
 *
 * @internal
 */
export async function loadContextConnectionSnapshot(
  selector: string,
): Promise<ContextConnectionSnapshot> {
  const { name, fields: parsed } = await readContextFile(selector);

  const url = str(parsed["url"]);
  if (!url) throw new NatsContextError(`NATS context "${name}" is missing \`url\``);
  // Parse userinfo just as direct URL mode does. Explicit context auth below
  // wins and removes these fields, so a context can never retain two
  // competing connection credential sources.
  const opts = parseNatsUrl(url);
  let auth: ContextAuthSnapshot =
    opts.user !== undefined || opts.pass !== undefined
      ? { kind: "user-password" }
      : opts.token !== undefined
        ? { kind: "token" }
        : { kind: "none" };

  const creds = str(parsed["creds"]);
  const nkey = str(parsed["nkey"]);
  const userJwt = str(parsed["user_jwt"]);
  const userSeed = str(parsed["user_seed"]);
  if (creds) {
    clearBasicAuth(opts);
    const bytes = await readAuthFile("creds", expandHome(creds));
    const snapshot = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    opts.authenticator = credsAuthenticator(snapshot);
    auth = { kind: "creds", bytes: snapshot };
  } else if (nkey) {
    clearBasicAuth(opts);
    // `nats context add` writes `nkey` as a path to a file containing the
    // raw seed. Read it once and pass through `nkeyAuthenticator`, which
    // signs the server nonce on each CONNECT.
    const bytes = await readAuthFile("nkey", expandHome(nkey));
    const snapshot = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    opts.authenticator = nkeyAuthenticator(snapshot);
    auth = { kind: "nkey", bytes: snapshot };
  } else if (userJwt) {
    clearBasicAuth(opts);
    // Inline JWT + optional inline seed. When `user_seed` is present
    // alongside `user_jwt` (the typical "decentralised auth without a
    // .creds file" shape), pass the seed bytes so nonce signing works.
    if (userSeed) {
      const snapshot = new TextEncoder().encode(userSeed);
      opts.authenticator = jwtAuthenticator(userJwt, snapshot);
      auth = { kind: "jwt-seed", jwt: userJwt, seed: snapshot };
    } else {
      opts.authenticator = jwtAuthenticator(userJwt);
      auth = { kind: "jwt" };
    }
  } else {
    const token = str(parsed["token"]);
    const user = str(parsed["user"]);
    const password = str(parsed["password"]);
    if (token || user || password) {
      clearBasicAuth(opts);
      if (token) opts.token = token;
      if (user) opts.user = user;
      if (password) opts.pass = password;
      auth = user || password ? { kind: "user-password" } : { kind: "token" };
    }
  }

  try {
    // Optional TLS triple. `nats context add --tlscert/--tlskey/--tlsca`
    // writes file paths; load them into standard node:tls options.
    const cert = str(parsed["cert"]);
    const key = str(parsed["key"]);
    const ca = str(parsed["ca"]);
    const tlsFirst = parsed["tls_first"];
    if (cert || key || ca || tlsFirst === true) {
      const tls: NonNullable<NodeConnectionOptions["tls"]> = {};
      if (cert) tls.cert = await readTlsFile("cert", expandHome(cert));
      if (key) tls.key = await readTlsFile("key", expandHome(key));
      if (ca) tls.ca = await readTlsFile("ca", expandHome(ca));
      if (tlsFirst === true) tls.handshakeFirst = true;
      opts.tls = tls;
    }
  } catch (error) {
    wipeContextAuth(auth);
    throw error;
  }

  const inboxPrefix = str(parsed["inbox_prefix"]);
  if (inboxPrefix) opts.inboxPrefix = inboxPrefix;

  let wiped = false;
  return {
    name,
    connectionOptions: opts,
    auth,
    wipe() {
      if (wiped) return;
      wiped = true;
      wipeContextAuth(auth);
    },
  };
}

function clearBasicAuth(options: NodeConnectionOptions): void {
  delete options.token;
  delete options.user;
  delete options.pass;
}

function wipeContextAuth(auth: ContextAuthSnapshot): void {
  if (auth.kind === "creds" || auth.kind === "nkey") auth.bytes.fill(0);
  if (auth.kind === "jwt-seed") auth.seed.fill(0);
}

/** Expand a leading `~/` to `$HOME/`. */
export function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

async function readTlsFile(field: string, path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new NatsContextError(`failed to read TLS ${field} file ${path}`, {
      cause: error,
    });
  }
}

/** Read a credentials / seed file, wrapping filesystem errors in `NatsContextError`. */
export async function readAuthFile(field: string, path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    throw new NatsContextError(`failed to read ${field} file ${path}`, {
      cause: error,
    });
  }
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
 * split and userinfo is only honored if it appears identically on every
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
    throw new NatsContextError("empty NATS URL");
  }

  const parsedAll = parts.map((p) => parseSingleNatsUrl(p, url));

  // All servers must agree on userinfo (or all be bare). Mixed userinfo
  // across servers can't be expressed in a single ConnectionOptions.
  const first = parsedAll[0]!;
  for (const p of parsedAll.slice(1)) {
    if (p.token !== first.token || p.user !== first.user || p.pass !== first.pass) {
      throw new NatsContextError(
        `NATS URL has mixed credentials across server entries: ${redactNatsUrl(url)}`,
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
  server: string; // protocol + host, plus WebSocket path/query (no userinfo)
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
  } catch {
    throw new NatsContextError(`invalid NATS URL ${redactNatsUrl(original)}`);
  }
  if (!/^(nats|tls|ws|wss):$/.test(parsed.protocol)) {
    throw new NatsContextError(
      `unsupported scheme "${parsed.protocol}" in NATS URL ${redactNatsUrl(original)}`,
    );
  }
  if (!parsed.host) {
    throw new NatsContextError(`NATS URL ${redactNatsUrl(original)} is missing a host`);
  }

  const websocketSuffix =
    parsed.protocol === "ws:" || parsed.protocol === "wss:"
      ? `${explicitUrlSuffix(withScheme) ? parsed.pathname : ""}${parsed.search}`
      : "";
  const out: ParsedNatsUrl = {
    server: `${parsed.protocol}//${parsed.host}${websocketSuffix}`,
  };

  // WHATWG `URL` squashes both `nats://user@host` and `nats://user:@host`
  // into `password === ""`, losing the distinction between "no separator"
  // (single-component userinfo → token) and "explicit colon, empty
  // password" (user:password form, even if password is empty). Sniff the
  // raw userinfo for a colon to recover the original intent — Python's
  // `urllib.parse.urlparse` distinguishes the two natively (`password is
  // None` vs `password == ""`), but in JS we have to look at the input.
  const userinfoMatch = withScheme.match(/^[a-z]+:\/\/([^/@]*)@/i);
  const hasColonSeparator = (userinfoMatch?.[1] ?? "").includes(":");

  if (hasColonSeparator) {
    // user:password form (decoded; password may be empty if URL was
    // `nats://alice:@host`, but that's still structurally user:password).
    out.user = decodeURIComponent(parsed.username);
    out.pass = decodeURIComponent(parsed.password);
  } else if (parsed.username !== "") {
    // Single userinfo component → token (matches `nats` CLI behaviour).
    out.token = decodeURIComponent(parsed.username);
  }
  return out;
}

/** Whether the raw URL explicitly contained a path or query. */
function explicitUrlSuffix(url: string): boolean {
  const authorityStart = url.indexOf("://") + 3;
  return /[/?]/.test(url.slice(authorityStart));
}

/** Preserve schemes/hosts in diagnostics while replacing every URL userinfo. */
function redactNatsUrl(url: string): string {
  return JSON.stringify(
    url
      .split(",")
      .map((entry) => {
        const trimmed = entry.trim();
        const scheme = trimmed.match(/^[a-z]+:\/\//i)?.[0];
        const authorityStart = scheme?.length ?? 0;
        // Redact through the final `@` even when malformed userinfo contains
        // a literal slash. This may over-redact an `@` in a WebSocket path,
        // which is preferable to leaking credentials from an error path.
        const at = trimmed.lastIndexOf("@");
        return at >= authorityStart
          ? `${trimmed.slice(0, authorityStart)}[redacted]@${trimmed.slice(at + 1)}`
          : trimmed;
      })
      .join(","),
  );
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
