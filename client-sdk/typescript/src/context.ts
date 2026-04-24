// `nats` CLI context loader.
//
// Reads context files written by `nats context add` / `nats context select`
// under `~/.config/nats` (or $NATS_CONFIG_HOME / $XDG_CONFIG_HOME/nats) and
// translates them into `@nats-io/transport-node` connection options ready to
// pass straight to `connect()`:
//
//     import { connect } from "@nats-io/transport-node";
//     import { Agents, loadContextOptions } from "@synadia/agents";
//
//     const opts = await loadContextOptions("prod");
//     const nc = await connect(opts);
//     const agents = new Agents({ nc });
//
// Supports: `url`, `creds` (path), `user_jwt`, `user`+`password`, `token`,
// `inbox_prefix`.
// Skips: `nkey`, TLS cert/key/ca, `nsc` integration.
//
// Precedence: `creds` > `user_jwt` > `user`/`password`/`token`.
//
// `user_jwt` without an accompanying nkey seed leaves the CONNECT signature
// empty, so it only works against servers that do not require nonce signing.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { credsAuthenticator, jwtAuthenticator } from "@nats-io/nats-core";
import type { NodeConnectionOptions } from "@nats-io/transport-node";
import { NatsAgentError } from "./errors.js";

/** Base error for context resolution failures. */
export class NatsContextError extends NatsAgentError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NatsContextError";
  }
}

/**
 * Resolve a NATS CLI context by name into `NodeConnectionOptions` ready to
 * pass to `connect()`. Pass `"current"` to resolve via `$NATS_CONTEXT` or
 * the `context.txt` selection file.
 */
export async function loadContextOptions(selector: string): Promise<NodeConnectionOptions> {
  const baseDir = resolveBaseDir();
  const name = selector === "current" ? await resolveCurrentName(baseDir) : selector;

  if (
    name.includes("/") ||
    name.includes("\\") ||
    name === ".." ||
    name.includes("../") ||
    name.includes("..\\")
  ) {
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
