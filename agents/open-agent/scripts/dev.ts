#!/usr/bin/env bun
// Dev helper — launches the CLI with sane defaults so `bun run scripts/dev.ts`
// is a one-shot way to bring the bridge up against a local nats-server.

import { spawnSync } from "node:child_process";

const result = spawnSync("bun", ["run", "src/cli.ts", ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: new URL("..", import.meta.url).pathname,
});

process.exit(result.status ?? 0);
