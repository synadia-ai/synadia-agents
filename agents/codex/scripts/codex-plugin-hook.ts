#!/usr/bin/env bun
import { emitCodexPluginNotification, type CodexPluginNotification } from "../src/plugin-registrar.js";

interface Args {
  readonly registrarUrl: string;
  readonly token: string;
  readonly event: string;
  readonly endpoint?: string;
  readonly threadId?: string;
  readonly source?: string;
}

const args = parseArgs(process.argv.slice(2));
const event: CodexPluginNotification = {
  event: args.event,
  ...(args.endpoint ? { endpoint: args.endpoint } : {}),
  ...(args.threadId ? { threadId: args.threadId } : {}),
  source: args.source ?? "codex-plugin-hook",
  timestamp: Date.now(),
};

const result = await emitCodexPluginNotification({ registrarUrl: args.registrarUrl, token: args.token, event });
if (result.status < 200 || result.status >= 300) {
  console.error(`codex plugin notification failed with HTTP ${result.status}`);
  process.exit(1);
}
console.log(result.body);

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag?.startsWith("--")) throw new Error(`unexpected argument ${flag ?? ""}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
  }
  const registrarUrl = values.get("--registrar-url") ?? process.env.SYNADIA_CODEX_PLUGIN_REGISTRAR_URL;
  const token = values.get("--token") ?? process.env.SYNADIA_CODEX_PLUGIN_REGISTRAR_TOKEN;
  const event = values.get("--event") ?? process.env.SYNADIA_CODEX_PLUGIN_EVENT ?? "SessionStart";
  if (!registrarUrl) throw new Error("--registrar-url or SYNADIA_CODEX_PLUGIN_REGISTRAR_URL is required");
  if (!token) throw new Error("--token or SYNADIA_CODEX_PLUGIN_REGISTRAR_TOKEN is required");
  return {
    registrarUrl,
    token,
    event,
    ...(values.get("--endpoint") ? { endpoint: values.get("--endpoint")! } : {}),
    ...(values.get("--thread-id") ? { threadId: values.get("--thread-id")! } : {}),
    ...(values.get("--source") ? { source: values.get("--source")! } : {}),
  };
}
