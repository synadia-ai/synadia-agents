// Starts the channel extension as one PI session and keeps it on the bus
// until it is told to stop (SIGTERM, or the end of stdin). The extension
// reads its config file from the home directory, so the caller points HOME
// at a throwaway directory that holds the config it wants read, and names
// it as the argument; a home that was not redirected is refused before the
// extension is loaded.
//
//   HOME=<dir> NATS_URL=<url> bun test/fixtures/session-from-home.mjs <dir>
//
// Every notification is printed as one JSON line.

import { homedir } from "node:os";

const [expectedHome] = process.argv.slice(2);
if (!expectedHome || homedir() !== expectedHome) {
  process.stderr.write(`home directory not redirected: ${homedir()}\n`);
  process.exit(3);
}

const { default: channelFactory } = await import(
  "../../extensions/nats-channel.ts"
);

const listeners = new Map();
const ctx = {
  cwd: process.cwd(),
  isIdle: () => true,
  ui: {
    notify: (line, level) =>
      process.stdout.write(`${JSON.stringify({ line, level })}\n`),
    setStatus() {},
  },
};
const emit = (event, ...args) =>
  Promise.all((listeners.get(event) ?? []).map((cb) => cb(...args, ctx)));

channelFactory({
  on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(cb);
  },
  sendUserMessage() {},
  registerCommand() {},
  registerTool() {},
});
await emit("session_start", {});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await emit("session_shutdown", {});
  process.exit(0);
}
process.on("SIGTERM", stop);
process.stdin.on("end", stop);
process.stdin.resume();
