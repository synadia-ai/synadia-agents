// `nats` CLI context loader — pure helper.
//
// Reads context files written by `nats context add` / `nats context select`
// under `~/.config/nats` (or `$NATS_CONFIG_HOME` / `$XDG_CONFIG_HOME/nats`)
// and returns a {@link LoadedNatsContext} you can hand to `connect()` from
// `@nats-io/transport-node` (or `wsconnect` from `@nats-io/nats-core`):
//
// ```ts
// import { connect } from "@nats-io/transport-node";
// import { Agents, loadNatsContext } from "@synadia/agents";
//
// const { servers, connectionOptions } = await loadNatsContext("prod");
// const nc = await connect({ servers: [...servers], ...connectionOptions });
// const agents = new Agents({ nc });
// ```
//
// The SDK deliberately does NOT open, wrap, or own the connection — this is
// purely a function that turns a context file into options. Callers pass
// them through to the NATS transport they've chosen.
//
// Supports: `url`, `creds` (path), `user_jwt`, `user`+`password`, `token`,
// `inbox_prefix`, `description`.
// Skips: `nkey`, TLS cert/key/ca, `nsc` integration. Re-add inline or
// extend the parser if you need them.
//
// Precedence: `creds` > `user_jwt` > `user`/`password`/`token`.
//
// Note: `user_jwt` without an accompanying nkey seed leaves the CONNECT
// signature empty, so it only works against servers that do not require
// nonce signing. Standard operator-mode deployments need `nkey` support
// (see the "Skips" list above).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { credsAuthenticator, jwtAuthenticator } from "@nats-io/nats-core";
import type { NodeConnectionOptions } from "@nats-io/transport-node";

/** A resolved NATS CLI context ready to plug into a NATS client. */
export interface LoadedNatsContext {
  /** The context name that was loaded. */
  readonly name: string;
  /** Human-readable description, if the context file declared one. */
  readonly description?: string;
  /** Servers parsed from the context's `url` field (comma-split, trimmed). */
  readonly servers: ReadonlyArray<string>;
  /** Everything else, shaped for `@nats-io/transport-node`'s `connect()`. */
  readonly connectionOptions: Omit<NodeConnectionOptions, "servers">;
}

/**
 * Load a NATS CLI context by name, or `"current"` to resolve from
 * `$NATS_CONTEXT` (if set) or the `context.txt` selection file that
 * `nats context select` writes.
 *
 * @throws `Error` if the context file is missing, malformed, or has no `url`.
 */
export async function loadNatsContext(selector: string): Promise<LoadedNatsContext> {
  const baseDir = resolveBaseDir();
  const name = selector === "current" ? await resolveCurrentName(baseDir) : selector;

  const path = join(baseDir, "context", `${name}.json`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`NATS context "${name}" not found at ${path}`);
    }
    throw err;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`NATS context "${name}" is not valid JSON: ${(err as Error).message}`);
  }

  const url = str(parsed["url"]);
  if (!url) throw new Error(`NATS context "${name}" is missing \`url\``);
  const servers = url
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const opts: Omit<NodeConnectionOptions, "servers"> = {};

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

  const description = str(parsed["description"]);
  const result: LoadedNatsContext = {
    name,
    servers,
    connectionOptions: opts,
    ...(description ? { description } : {}),
  };
  return result;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function resolveBaseDir(): string {
  const explicit = process.env["NATS_CONFIG_HOME"];
  if (explicit) return explicit;
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
      throw new Error(`no NATS context is selected (empty ${path})`);
    }
    return selected;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no NATS context is selected ($NATS_CONTEXT unset, no ${path})`);
    }
    throw err;
  }
}
