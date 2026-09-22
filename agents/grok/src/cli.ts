#!/usr/bin/env bun
// grok-agent — Grok Build on the NATS bus.
//
// A thin, grok-pinned front door to the generic ACP channel
// (`@synadia-ai/acp-nats-channel`): every command is delegated to the ACP
// channel's `runCli` with the grok preset and managed mode injected as
// defaults. All bridging logic — spawn, ACP session, chunk mapping, §7
// permission relay — lives in the ACP channel; this package pins identity
// and documents the grok-specific workflow.
import { runCli } from "@synadia-ai/acp-nats-channel";

/**
 * Build the delegated acp-agent argv: pin `--agent grok` and default
 * `--mode managed` (the ACP channel's own default is `fake`, which only
 * makes sense for its protocol smokes). User flags come after the injected
 * defaults, so an explicit `--mode fake` still wins — but the preset is
 * pinned: pass-through of `--agent` is rejected rather than silently
 * re-targeting a differently-named binary.
 */
export function buildGrokArgv(argv: readonly string[]): string[] {
  if (argv.includes("--agent")) {
    throw new Error(
      "grok-agent is pinned to the grok preset — use acp-agent from @synadia-ai/acp-nats-channel to bridge other agents",
    );
  }
  const [command = "help", ...rest] = argv;
  return [command, "--agent", "grok", "--mode", "managed", ...rest];
}

if (import.meta.main) {
  runCli(buildGrokArgv(process.argv.slice(2))).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
