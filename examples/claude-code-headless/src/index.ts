// claude-code-headless entry point.
//
// Loads config, connects to NATS (via `nats context` when available),
// starts the ClaudeSessionManager and Controller, and wires graceful
// shutdown on SIGINT/SIGTERM.

import { accessSync, constants as fsc, existsSync } from "node:fs";
import { delimiter as pathDelimiter, join as joinPath } from "node:path";
import process from "node:process";

import type { NatsConnection } from "@nats-io/nats-core";
import type { NodeConnectionOptions } from "@nats-io/transport-node";
import { connect as natsConnect } from "@nats-io/transport-node";
import { loadContextOptions, parseNatsUrl } from "@synadia-ai/agents";

import { ClaudeSessionManager } from "./claude-session-manager.js";
import { Controller } from "./controller.js";
import { loadConfig, parseCliOverrides } from "./config.js";
import { resolveControllerName } from "./subjects.js";

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

async function resolveNatsOptions(
  context: string | undefined,
  natsUrl: string | undefined,
): Promise<NodeConnectionOptions> {
  if (context) {
    return { ...(await loadContextOptions(context)), name: "claude-code-headless" };
  }
  if (natsUrl) {
    // `parseNatsUrl` extracts userinfo (token / user:password) — without it
    // `nats://TOKEN@host:port` would silently drop the token.
    return { ...parseNatsUrl(natsUrl), name: "claude-code-headless" };
  }

  throw new Error("no NATS target configured (context / NATS_URL / --url)");
}

async function main(): Promise<void> {
  const cli = parseCliOverrides(process.argv.slice(2));
  const config = loadConfig(cli);

  // Surface a startup hint when ANTHROPIC_API_KEY isn't set so misconfig
  // shows up at boot rather than as a confusing SDK error on first spawn.
  if (!process.env["ANTHROPIC_API_KEY"]) {
    log(
      "claude-code-headless: ANTHROPIC_API_KEY is not set in env. See the README for the recommended auth setup.",
    );
  }

  // Resolve the `claude` binary path. Configured > auto-detected (via
  // `which`-equivalent on PATH) > undefined (let the SDK try its bundled
  // native binary, which can fail when the installed musl/glibc variant
  // doesn't match this machine).
  const claudeCodePath = await resolveClaudeCodePath(config.claudeCodePath);
  if (claudeCodePath) {
    log(`claude-code-headless: using claude binary at ${claudeCodePath}`);
  } else {
    log(
      "claude-code-headless: no claude binary found on PATH; SDK will use its bundled native binary (may fail if the installed variant doesn't match this platform — set --claude-code-path to override).",
    );
  }

  const connOpts = await resolveNatsOptions(config.context, config.natsUrl);
  log(
    `claude-code-headless: connecting (${config.context ? `context=${config.context}` : `url=${config.natsUrl}`})`,
  );
  const nc: NatsConnection = await natsConnect(connOpts);
  log(`claude-code-headless: connected`);

  const manager = new ClaudeSessionManager({
    nc,
    owner: config.owner,
    defaultModel: config.defaultModel,
    defaultPermissionMode: config.defaultPermissionMode,
    defaultAllowedTools: config.defaultAllowedTools,
    defaultMaxTurns: config.defaultMaxTurns,
    defaultMaxLifetimeS: config.defaultMaxLifetimeS,
    ...(claudeCodePath ? { claudeCodePath } : {}),
  });
  await manager.start();

  // Probe for an unclaimed controller name. With the default `control`,
  // a second claude-code-headless on the same NATS lands on `control-2`,
  // a third on `control-3`, and so on.
  const resolvedName = await resolveControllerName(nc, config.name, config.owner);
  if (resolvedName !== config.name) {
    log(`claude-code-headless: name "${config.name}" is taken; using "${resolvedName}"`);
  }

  const controller = new Controller({
    nc,
    owner: config.owner,
    name: resolvedName,
    manager,
  });
  await controller.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(
      `claude-code-headless: received ${signal}, shutting down (${manager.count()} sessions)`,
    );
    // Force-exit guard — NATS close can occasionally hang.
    const forceTimer = setTimeout(() => {
      log("claude-code-headless: forced exit");
      process.exit(1);
    }, 5_000);
    forceTimer.unref?.();
    try {
      await controller.stop();
    } catch (e) {
      log(`claude-code-headless: controller.stop error: ${(e as Error).message}`);
    }
    try {
      await manager.stop();
    } catch (e) {
      log(`claude-code-headless: manager.stop error: ${(e as Error).message}`);
    }
    try {
      await nc.drain();
    } catch {
      /* noop */
    }
    clearTimeout(forceTimer);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("unhandledRejection", (err) => {
    log(`claude-code-headless: unhandledRejection: ${err}`);
  });
  process.on("uncaughtException", (err) => {
    log(`claude-code-headless: uncaughtException: ${err}`);
  });

  // Background: NATS connection status logging.
  void (async () => {
    try {
      for await (const s of nc.status()) {
        if (s.type === "disconnect") log(`claude-code-headless: NATS disconnected`);
        else if (s.type === "reconnect") log(`claude-code-headless: NATS reconnected`);
        else if (s.type === "error") log(`claude-code-headless: NATS error`);
      }
    } catch {
      /* status iterator ended */
    }
  })();
}

/**
 * `which` for the current process's PATH. Returns the absolute path of an
 * executable named `name` if one is reachable, or `null` otherwise. Works
 * under both Node (via `npx` / `npm install -g`) and Bun (via `bun run`).
 */
function whichSync(name: string): string | null {
  const pathEnv = process.env["PATH"] ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  for (const dir of pathEnv.split(pathDelimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = joinPath(dir, name + ext);
      try {
        accessSync(candidate, fsc.X_OK);
        return candidate;
      } catch {
        /* not here, try next */
      }
    }
  }
  return null;
}

async function resolveClaudeCodePath(configured: string | undefined): Promise<string | undefined> {
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(
        `claude-code-headless: configured claudeCodePath does not exist: ${configured}`,
      );
    }
    return configured;
  }
  // Walk PATH ourselves — runtime-portable across Node and Bun.
  return whichSync("claude") ?? undefined;
}

main().catch((err) => {
  log(`claude-code-headless: fatal: ${(err as Error).message}`);
  process.exit(1);
});
