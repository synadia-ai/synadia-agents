// Headless Copilot session host for proving the INBOUND path without a TTY.
//
// `copilot -p` exits after one turn and `copilot --acp` does not load
// extensions, so this script hosts a long-lived session the same way the
// Copilot App does: through the CLI's bundled SDK, with extensions enabled
// (`setForegroundSessionId` only works in TUI+server mode, so its failure is
// ignored). The project extension in <cwd>/.github/extensions
// then joins, registers on NATS, and serves remote prompts until the timeout.
//
// Usage (Node 20+):
//   COPILOT_SDK=<cli pkg dir>/copilot-sdk/index.js \
//   COPILOT_BIN=<path to copilot executable> \
//   node demo/sdk-host.mjs <cwd> [seconds]
//
// Every permission request is DENIED unless its kind is listed in HOST_APPROVE
// (comma-separated, e.g. "custom-tool") — that stands in for a human clicking
// Approve in the UI. Remote prompts never get unattended tool access by default.

import { pathToFileURL } from "node:url";

const approveKinds = new Set((process.env.HOST_APPROVE ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const cwd = process.argv[2] ?? process.cwd();
const seconds = Number(process.argv[3] ?? 180);
const sdkPath = process.env.COPILOT_SDK;
if (!sdkPath) {
  console.error("set COPILOT_SDK to the CLI's copilot-sdk/index.js");
  process.exit(2);
}
const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(sdkPath).href);

const client = new CopilotClient({
  mode: "coding-agent",
  runtime: RuntimeConnection.forSpawnedStdio({
    ...(process.env.COPILOT_BIN ? { path: process.env.COPILOT_BIN } : {}),
    args: (process.env.COPILOT_ARGS ?? "").split(" ").filter(Boolean),
    workingDirectory: cwd,
  }),
});

const session = await client.createSession({
  workingDirectory: cwd,
  model: process.env.COPILOT_MODEL ?? "claude-haiku-4.5",
  enableConfigDiscovery: true,
  extensions: { enabled: true },
  filesystem: { trustWorkingDirectory: "session" },
  permissions: {
    onRequest: (req) => {
      const kind = req?.kind ?? "?";
      const detail = req?.toolName ?? req?.fullCommandText ?? "";
      if (approveKinds.has(kind)) {
        console.error(`[host] APPROVE permission ${kind} ${detail}`);
        return { kind: "approve-once" };
      }
      console.error(`[host] DENY permission ${kind} ${detail}`);
      return { kind: "reject", feedback: "headless demo host denies this permission" };
    },
  },
});
// Only meaningful in TUI+server mode; a plain headless server has no foreground.
await client.setForegroundSessionId(session.sessionId).catch(() => {});
console.error(`[host] session ${session.sessionId} in ${cwd}; open for ${seconds}s`);

session.on((ev) => {
  switch (ev.type) {
    case "user.message":
      console.error(`[host] user.message: ${JSON.stringify(ev.data?.content ?? "").slice(0, 200)}`);
      break;
    case "assistant.message":
      console.error(`[host] assistant.message: ${JSON.stringify(ev.data?.content ?? "").slice(0, 200)}`);
      break;
    case "session.idle":
    case "session.info":
    case "session.warning":
    case "session.error":
    case "tool.execution_start":
    case "tool.execution_complete":
      console.error(`[host] ${ev.type} ${JSON.stringify(ev.data ?? {}).slice(0, 240)}`);
      break;
    default:
      if (/extension/i.test(ev.type)) console.error(`[host] ${ev.type} ${JSON.stringify(ev.data ?? {}).slice(0, 240)}`);
  }
});

if (process.env.HOST_PROMPT) {
  await session.send({ prompt: process.env.HOST_PROMPT });
}

const shutdown = async () => {
  console.error("[host] closing");
  try {
    await session.disconnect?.();
  } catch {}
  await client.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
setTimeout(shutdown, seconds * 1000);
