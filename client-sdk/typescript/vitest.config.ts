import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve `@synadia-ai/agent-service` to the sibling host package's
// source during tests. The integration tests use `ReferenceAgent` from
// the host package as a counterparty for the caller-side discover /
// prompt / heartbeat scenarios. Aliasing the source avoids a build
// step in the host package on every caller-side edit.
const HOST_SRC = resolve(__dirname, "../../agent-sdk/typescript/src");

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests share a single nats-server process and rely on
    // per-test subject prefixes for isolation. Running files serially
    // keeps the evidence recorder output predictable.
    fileParallelism: false,
    globalSetup: ["test/harness/global-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
    },
  },
  resolve: {
    alias: {
      "@synadia-ai/agent-service/testing": `${HOST_SRC}/testing/index.ts`,
      "@synadia-ai/agent-service": `${HOST_SRC}/index.ts`,
    },
  },
});
