// NATS context loading per spec §10.2.
//
// Reads the config files `nats context` writes under `~/.config/nats/`,
// translates them into `@nats-io/transport-node` connection options, and
// exposes a typed `NatsContext` record the caller can pass to `connect()`.
//
// Scope for v0.1: `url`, `creds`, `token`, `user`/`password`, `user_jwt`,
// `inbox_prefix`, `description`. `nkey`, `cert`/`key`/`ca` (TLS), and
// `nsc` subprocess integration are tracked in `TODO.md` as follow-ups.

import { readFile } from "node:fs/promises";
import { platform as osPlatform } from "node:os";
import { join as joinPath } from "node:path";
import {
  type Authenticator,
  type ConnectionOptions,
  credsAuthenticator,
  jwtAuthenticator,
} from "@nats-io/nats-core";
import type { NodeConnectionOptions } from "@nats-io/transport-node";
import {
  NatsContextInvalidError,
  NatsContextNotFoundError,
  NatsContextNotSelectedError,
} from "./errors.js";
import {
  assertValidContextName,
  ContextParseError,
  parseContextFile,
  splitUrls,
} from "./internal/context-parse.js";
import {
  type ContextPathsEnv,
  expandTilde,
  resolveContextPaths,
} from "./internal/context-paths.js";

/** A fully-resolved NATS context ready to pass to `connect()`. */
export interface NatsContext {
  /** Context name (e.g. `"prod"`). */
  readonly name: string;
  /** Human-readable description, if the context file declared one. */
  readonly description?: string;
  /** Servers parsed from the context's `url` field. */
  readonly servers: ReadonlyArray<string>;
  /** Everything else the context supplied, shaped for `@nats-io/transport-node`. */
  readonly connectionOptions: Omit<NodeConnectionOptions, "servers">;
}

/**
 * Which context to load:
 *   - a string name (e.g. `"prod"`): loads `<baseDir>/context/<name>.json`.
 *   - the literal string `"current"` or the boolean `true`: uses
 *     `$NATS_CONTEXT` if set, else reads the selection stored in
 *     `<baseDir>/context.txt` (written by `nats context select`).
 *
 * Note: a context literally named `current` is ambiguous with the magic
 * string; if you have one, pass it via `env.NATS_CONTEXT = "current"` and
 * call with selector `true`, or rename the context.
 */
export type ContextSelector = string | true;

/**
 * Load a NATS context by name or selection.
 *
 * @throws {@link NatsContextNotFoundError}     the context file is absent.
 * @throws {@link NatsContextNotSelectedError}  `"current"` / `true` requested but nothing is selected.
 * @throws {@link NatsContextInvalidError}      file exists but is malformed or missing `url`.
 */
export async function loadNatsContext(
  selector: ContextSelector,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NatsContext> {
  const pathsEnv = toPathsEnv(env);
  const paths = resolveContextPaths(pathsEnv);

  const name = await resolveContextName(selector, paths.selectionFile, env);
  try {
    assertValidContextName(name);
  } catch (err) {
    throw new NatsContextInvalidError(name, (err as Error).message);
  }

  const contextPath = joinPath(paths.contextDir, `${name}.json`);
  const parsed = await readAndParse(name, contextPath);

  if (!parsed.url || parsed.url.length === 0) {
    throw new NatsContextInvalidError(name, "`url` field is required but missing/empty");
  }
  const servers = splitUrls(parsed.url);
  if (servers.length === 0) {
    throw new NatsContextInvalidError(name, "`url` field resolved to zero servers");
  }

  const connectionOptions = await buildConnectionOptions(name, parsed, env);

  const result: NatsContext = {
    name,
    servers: Object.freeze([...servers]),
    connectionOptions: Object.freeze(connectionOptions),
    ...(parsed.description ? { description: parsed.description } : {}),
  };
  return Object.freeze(result);
}

async function resolveContextName(
  selector: ContextSelector,
  selectionFile: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (selector !== "current" && selector !== true) {
    return selector;
  }
  // `current` / `true`: env var wins, then selection file.
  const envName = env["NATS_CONTEXT"];
  if (envName && envName.length > 0) return envName;
  try {
    const selected = (await readFile(selectionFile, "utf8")).trim();
    if (selected.length === 0) {
      throw new NatsContextNotSelectedError(selectionFile);
    }
    return selected;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NatsContextNotSelectedError(selectionFile);
    }
    throw err;
  }
}

async function readAndParse(
  name: string,
  path: string,
): Promise<ReturnType<typeof parseContextFile>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NatsContextNotFoundError(name, path);
    }
    throw err;
  }
  try {
    return parseContextFile(raw);
  } catch (err) {
    if (err instanceof ContextParseError) {
      throw new NatsContextInvalidError(name, err.message);
    }
    throw err;
  }
}

async function buildConnectionOptions(
  name: string,
  parsed: ReturnType<typeof parseContextFile>,
  env: NodeJS.ProcessEnv,
): Promise<Omit<NodeConnectionOptions, "servers">> {
  const opts: ConnectionOptions = {};
  const home = env["HOME"];

  // Authentication: creds supersedes user_jwt; both preferred over user/pass/token.
  const authenticator = await buildAuthenticator(name, parsed, home);
  if (authenticator) opts.authenticator = authenticator;

  if (!authenticator) {
    if (parsed.token && parsed.token.length > 0) opts.token = parsed.token;
    if (parsed.user && parsed.user.length > 0) opts.user = parsed.user;
    if (parsed.password && parsed.password.length > 0) opts.pass = parsed.password;
  }

  if (parsed.inbox_prefix && parsed.inbox_prefix.length > 0) {
    opts.inboxPrefix = parsed.inbox_prefix;
  }

  return opts;
}

async function buildAuthenticator(
  name: string,
  parsed: ReturnType<typeof parseContextFile>,
  home: string | undefined,
): Promise<Authenticator | undefined> {
  if (parsed.creds && parsed.creds.length > 0) {
    const credsPath = expandTilde(parsed.creds, home);
    let bytes: Uint8Array;
    try {
      const buf = await readFile(credsPath);
      bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new NatsContextInvalidError(name, `creds file not found: ${credsPath}`);
      }
      throw err;
    }
    return credsAuthenticator(bytes);
  }
  if (parsed.user_jwt && parsed.user_jwt.length > 0) {
    return jwtAuthenticator(parsed.user_jwt);
  }
  return undefined;
}

function toPathsEnv(env: NodeJS.ProcessEnv): ContextPathsEnv {
  return {
    platform: osPlatform(),
    ...(env["NATS_CONFIG_HOME"] !== undefined && { NATS_CONFIG_HOME: env["NATS_CONFIG_HOME"] }),
    ...(env["XDG_CONFIG_HOME"] !== undefined && { XDG_CONFIG_HOME: env["XDG_CONFIG_HOME"] }),
    ...(env["HOME"] !== undefined && { HOME: env["HOME"] }),
    ...(env["APPDATA"] !== undefined && { APPDATA: env["APPDATA"] }),
  };
}
