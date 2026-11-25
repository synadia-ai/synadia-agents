#!/usr/bin/env bun
// Bundles src/extension.ts and both Synadia SDKs into one ESM file for Node:
// the CLI loads `extension.mjs` with no node_modules beside it. Only
// `@github/copilot-sdk`, which the CLI injects, stays external.

import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, "dist");
mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src", "extension.ts")],
  outdir,
  target: "node",
  format: "esm",
  minify: false,
  external: ["@github/copilot-sdk", "@github/copilot-sdk/*", "@microsoft/copilot-sdk", "@microsoft/copilot-sdk/*"],
  naming: "extension.[ext]",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("bundle build failed");
}
renameSync(join(outdir, "extension.js"), join(outdir, "extension.mjs"));
console.error(`built ${join(outdir, "extension.mjs")}`);
