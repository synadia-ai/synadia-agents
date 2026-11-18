/**
 * GitHub Copilot CLI extension: joins the foreground session to the
 * Synadia Agent Protocol for NATS fleet.
 *
 * - Outbound (default on): the agent tools (`discover_agents`,
 *   `prompt_agent`, …) so Copilot can call any fleet agent.
 * - Inbound (default OFF): registers the session as agent `copilot` and
 *   serves fleet prompts in it, streaming the reply back.
 *
 * stdout carries the CLI's JSON-RPC: nothing here may write to it.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Before anything else can log: keep stray console output off stdout.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.debug = () => undefined;

import type { joinSession as JoinSession } from "@github/copilot-sdk/extension";

import { REQUESTED_ENV_VARS, findConfigFile, loadConfigFile, resolveSettings, type Settings } from "./config.js";
import { joinOptions, withRemoteProvenance, type SdkFlavor } from "./host.js";
import { EXTENSION_NAME, ExtensionRuntime, type Log, type PermissionRequestLike } from "./runtime.js";

const extensionDir = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
})();

// The host injects the SDK under a name that differs by build (see host.ts);
// the specifiers are variables so the bundler leaves them external.
const SDK_SPECIFIERS: ReadonlyArray<[string, SdkFlavor]> = [
  ["@microsoft/copilot-sdk/extension", "modern"],
  ["@github/copilot-sdk/extension", "legacy"],
];

async function loadJoinSession(): Promise<{ joinSession: typeof JoinSession; flavor: SdkFlavor }> {
  const failures: string[] = [];
  for (const [specifier, flavor] of SDK_SPECIFIERS) {
    try {
      const sdk = (await import(specifier)) as { joinSession?: typeof JoinSession };
      if (typeof sdk.joinSession === "function") return { joinSession: sdk.joinSession, flavor };
      failures.push(`${specifier}: no joinSession export`);
    } catch (error) {
      failures.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Copilot extension SDK not found (${failures.join("; ")})`);
}

function settingsFromEnvironment(): Settings {
  const file = findConfigFile(process.env, extensionDir);
  return resolveSettings(loadConfigFile(file), process.env, file);
}

async function main(): Promise<void> {
  const { joinSession, flavor } = await loadJoinSession();
  const join = (options: Parameters<typeof joinOptions>[1]) =>
    joinSession(joinOptions(flavor, options) as Parameters<typeof JoinSession>[0]);
  let settings: Settings;
  let configError: string | undefined;
  try {
    settings = settingsFromEnvironment();
  } catch (error) {
    // A broken config still joins (so the user sees why), but offers nothing.
    configError = error instanceof Error ? error.message : String(error);
    const session = await join({});
    await session.log(`${EXTENSION_NAME}: disabled — ${configError}`, { level: "error" });
    return;
  }
  if (settings.disabled) {
    await join({});
    return;
  }

  // The tool set and the permission handler must be known at join time;
  // they depend only on non-sensitive settings.
  let runtime = new ExtensionRuntime({ settings, log: () => undefined });
  let deferredRuntime: ExtensionRuntime | undefined;
  const route = () => deferredRuntime ?? runtime;
  const tools = runtime.extensionTools().map((tool) => ({
    ...tool,
    handler: (args: unknown, invocation: { toolCallId?: string }) =>
      route().executeTool(tool.name.slice(settings.toolPrefix.length) as never, args, invocation.toolCallId),
  }));

  const session = await join({
    tools,
    requestedEnvironmentVariables: REQUESTED_ENV_VARS,
    ...(settings.inbound.enabled && settings.inbound.permissions === "query"
      ? { onPermissionRequest: (request: unknown) => route().decidePermission(request as PermissionRequestLike) }
      : {}),
  });

  const log: Log = (message, level = "info") => {
    void session.log(message, { level, ephemeral: level === "info" }).catch(() => undefined);
    if (level !== "info") console.error(message);
  };

  // Granted variables (e.g. NATS_CREDS) are in process.env only now.
  try {
    settings = settingsFromEnvironment();
  } catch (error) {
    log(`${EXTENSION_NAME}: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  runtime = new ExtensionRuntime({ settings, log });
  deferredRuntime = runtime;

  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    await runtime.stop().catch(() => undefined);
    process.exit(code);
  };
  process.on("SIGTERM", () => void stop(0));
  process.on("SIGINT", () => void stop(0));
  session.on("session.shutdown", () => void runtime.stop());

  // Retry with backoff: NATS may come up after the session does.
  let delayMs = 5_000;
  const tryStart = async (): Promise<void> => {
    if (stopping) return;
    try {
      await runtime.start(
        withRemoteProvenance(session, (error) =>
          console.error(
            `${EXTENSION_NAME}: host rejected message source (${error instanceof Error ? error.message : String(error)}); sending untagged`,
          ),
        ) as never,
      );
    } catch (error) {
      const message =
        `${EXTENSION_NAME}: could not start (${settings.connectionLabel}): ` +
        `${error instanceof Error ? error.message : String(error)}; retrying in the background`;
      if (delayMs === 5_000) log(message, "warning");
      else console.error(message);
      const timer = setTimeout(() => void tryStart(), delayMs);
      timer.unref?.();
      delayMs = Math.min(delayMs * 2, 60_000);
    }
  };
  await tryStart();
}

main().catch((error: unknown) => {
  console.error(`${EXTENSION_NAME}: fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
