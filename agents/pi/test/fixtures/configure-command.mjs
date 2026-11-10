// Runs one `/nats-configure` call of the channel extension and prints what
// it notified, as JSON. The extension keeps its config file under the home
// directory, so the caller points HOME at a throwaway directory and names
// it as the second argument; a home that was not redirected is refused
// before the extension is loaded, so a developer's own config is never
// written.
//
//   HOME=<dir> bun test/fixtures/configure-command.mjs "<args>" <dir>

import { homedir } from "node:os";

const [args = "", expectedHome] = process.argv.slice(2);
if (!expectedHome || homedir() !== expectedHome) {
  console.error(`home directory not redirected: ${homedir()}`);
  process.exit(3);
}

const { default: channelFactory } = await import(
  "../../extensions/nats-channel.ts"
);

const commands = new Map();
channelFactory({
  on() {},
  sendUserMessage() {},
  registerCommand: (name, spec) => commands.set(name, spec),
  registerTool() {},
});

const notified = [];
await commands.get("nats-configure").handler(args, {
  ui: {
    notify: (line, level) => notified.push({ line, level }),
    setStatus() {},
  },
});
console.log(JSON.stringify(notified));
process.exit(0);
