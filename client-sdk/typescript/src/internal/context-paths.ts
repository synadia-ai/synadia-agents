// Pure: resolve the directory layout used by `nats context` (from `natscli`).
//
// Priority for the base directory, matching the `nats` CLI:
//   1. `$NATS_CONFIG_HOME`
//   2. `$XDG_CONFIG_HOME/nats`
//   3. `$HOME/.config/nats`                (Unix / macOS)
//   4. `%APPDATA%/nats`                    (Windows — best-effort; untested in CI)

import { join as joinPath } from "node:path";

export interface ContextPaths {
  readonly baseDir: string;
  readonly contextDir: string;
  readonly selectionFile: string;
}

export interface ContextPathsEnv {
  readonly NATS_CONFIG_HOME?: string | undefined;
  readonly XDG_CONFIG_HOME?: string | undefined;
  readonly HOME?: string | undefined;
  readonly APPDATA?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

export class UnresolvedContextDirError extends Error {
  constructor() {
    super(
      "cannot resolve NATS config directory: set $NATS_CONFIG_HOME, $XDG_CONFIG_HOME, $HOME, or %APPDATA%",
    );
    this.name = "UnresolvedContextDirError";
  }
}

export function resolveContextPaths(env: ContextPathsEnv = {}): ContextPaths {
  const baseDir = resolveBaseDir(env);
  return Object.freeze({
    baseDir,
    contextDir: joinPath(baseDir, "context"),
    selectionFile: joinPath(baseDir, "context.txt"),
  });
}

function resolveBaseDir(env: ContextPathsEnv): string {
  if (env.NATS_CONFIG_HOME && env.NATS_CONFIG_HOME.length > 0) return env.NATS_CONFIG_HOME;
  if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0) {
    return joinPath(env.XDG_CONFIG_HOME, "nats");
  }
  if (env.HOME && env.HOME.length > 0) return joinPath(env.HOME, ".config", "nats");
  if (env.platform === "win32" && env.APPDATA && env.APPDATA.length > 0) {
    return joinPath(env.APPDATA, "nats");
  }
  throw new UnresolvedContextDirError();
}

/**
 * Expand a leading `~` or `~/...` in a user-provided path to an absolute
 * path, using `home`. Non-`~` paths and `~user/...` forms are returned
 * unchanged (we don't support other users).
 */
export function expandTilde(p: string, home?: string): string {
  if (!p || !p.startsWith("~")) return p;
  if (!home) return p;
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return joinPath(home, p.slice(2));
  return p;
}
