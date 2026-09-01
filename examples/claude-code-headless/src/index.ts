// claude-code-headless entry point.
//
// Loads config, connects to NATS (via `nats context` when available),
// starts the ClaudeSessionManager and Controller, and wires graceful
// shutdown on SIGINT/SIGTERM.

import { accessSync, constants as fsc, existsSync } from "node:fs";
import { delimiter as pathDelimiter, join as joinPath } from "node:path";
import process from "node:process";

import type { NatsConnection } from "@nats-io/nats-core";
import { connect as natsConnect } from "@nats-io/transport-node";
import {
  IdentityError,
  NatsContextError,
  resolveNatsConnectionBundle,
  withAgentReconnectDefaults,
} from "@synadia-ai/agents";

import { ClaudeSessionManager } from "./claude-session-manager.js";
import { Controller } from "./controller.js";
import { loadConfig, parseCliOverrides } from "./config.js";
import { resolveControllerName } from "./subjects.js";

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

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

  const bundle = await resolveNatsConnectionBundle(
    config.connectionSource,
    { identity: config.senderIdentity },
  );
  bundle.connectionOptions.name = "claude-code-headless";
  log(
    `claude-code-headless: connecting (${config.connectionLabel}, senderIdentity=${config.senderIdentity}, minSenderTrust=${config.minSenderTrust})`,
  );

  let nc: NatsConnection | undefined;
  let manager: ClaudeSessionManager | undefined;
  let controller: Controller | undefined;
  try {
    nc = await natsConnect(withAgentReconnectDefaults(bundle.connectionOptions));
    log(`claude-code-headless: connected`);

    manager = new ClaudeSessionManager({
      nc,
      owner: config.owner,
      defaultModel: config.defaultModel,
      defaultPermissionMode: config.defaultPermissionMode,
      defaultAllowedTools: config.defaultAllowedTools,
      defaultMaxTurns: config.defaultMaxTurns,
      defaultMaxLifetimeS: config.defaultMaxLifetimeS,
      minSenderTrust: config.minSenderTrust,
      ...(config.senderIdentity === "signed" ? { signer: bundle.signer! } : {}),
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

    controller = new Controller({
      nc,
      owner: config.owner,
      name: resolvedName,
      manager,
      minSenderTrust: config.minSenderTrust,
      ...(config.senderIdentity === "signed" ? { signer: bundle.signer! } : {}),
    });
    await controller.start();
  } catch (error) {
    await controller?.stop().catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    if (nc) await nc.close();
    bundle.wipe();
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(
      `claude-code-headless: received ${signal}, shutting down (${manager!.count()} sessions)`,
    );
    // Force-exit guard — NATS close can occasionally hang.
    const forceTimer = setTimeout(() => {
      log("claude-code-headless: forced exit");
      process.exit(1);
    }, 5_000);
    forceTimer.unref?.();
    try {
      await controller!.stop();
    } catch (e) {
      log(
        `claude-code-headless: controller.stop error (${e instanceof Error ? e.name : "unknown error"})`,
      );
    }
    try {
      await manager!.stop();
    } catch (e) {
      log(
        `claude-code-headless: manager.stop error (${e instanceof Error ? e.name : "unknown error"})`,
      );
    }
    try {
      try {
        await nc!.drain();
      } catch {
        // A failed drain is not proof that reconnect stopped. Force close and
        // keep the bundle intact if close also fails so shutdown can retry.
        await nc!.close();
      }
      bundle.wipe();
    } finally {
      clearTimeout(forceTimer);
    }
    process.exit(0);
  };

  const requestShutdown = (signal: string): void => {
    void shutdown(signal).catch((error: unknown) => {
      shuttingDown = false;
      log(`claude-code-headless: connection shutdown failed (${error instanceof Error ? error.name : "unknown error"})`);
    });
  };
  process.on("SIGINT", () => requestShutdown("SIGINT"));
  process.on("SIGTERM", () => requestShutdown("SIGTERM"));

  process.on("unhandledRejection", (err) => {
    log(
      `claude-code-headless: unhandled rejection (${err instanceof Error ? err.name : "unknown"})`,
    );
  });
  process.on("uncaughtException", (err) => {
    log(`claude-code-headless: uncaught exception (${err.name})`);
  });

  // Background: NATS connection status logging.
  void (async () => {
    try {
      for await (const s of nc!.status()) {
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
  log(`claude-code-headless: ${startupDescription(err)}`);
  process.exit(1);
});

function startupDescription(error: unknown): string {
  if (error instanceof IdentityError || error instanceof NatsContextError) return error.message;
  if (error instanceof Error && error.message.startsWith("claude-code-headless:")) {
    return error.message.slice("claude-code-headless: ".length);
  }
  return `startup failed (${error instanceof Error ? error.name : "unknown error"})`;
}
