#!/usr/bin/env bun
// Installs the built extension as `<dir>/synadia-nats/extension.mjs`.
//
//   bun run install-extension -- --project <repo>   → <repo>/.github/extensions/synadia-nats/
//   bun run install-extension -- --global           → ~/.copilot/extensions/synadia-nats/
//
// --global loads it into EVERY Copilot CLI and Copilot App session of this
// user, so it is never the default.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "dist", "extension.mjs");
const args = process.argv.slice(2);

function usage(): never {
  console.error("usage: install.ts --project <repo-dir> | --global");
  process.exit(2);
}

let target: string;
const projectAt = args.indexOf("--project");
if (projectAt >= 0) {
  const dir = args[projectAt + 1];
  if (!dir) usage();
  target = join(resolve(dir), ".github", "extensions", "synadia-nats");
} else if (args.includes("--global")) {
  target = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "extensions", "synadia-nats");
} else {
  usage();
}

if (!existsSync(bundle)) {
  console.error(`${bundle} is missing — run \`bun run build\` first`);
  process.exit(1);
}
mkdirSync(target, { recursive: true });
copyFileSync(bundle, join(target, "extension.mjs"));
console.error(`installed ${join(target, "extension.mjs")}`);
console.error("Reload extensions in a running session (/clear, or restart copilot) to pick it up.");
