import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "index.ts",
    "setup-entry": "setup-entry.ts",
  },
  format: ["esm"],
  outDir: "dist",
  target: "node20",
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: false,
  treeshake: true,
  // Keep peerDeps + npm-resolved deps external; bundle only local ./src/*.
  external: [
    "openclaw",
    /^openclaw\//,
    "@synadia-ai/agents",
    "@synadia-ai/agent-service",
    /^@nats-io\//,
    "@sinclair/typebox",
  ],
});
