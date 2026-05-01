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

// Self-alias `@synadia-ai/agents` to its own source. The caller's tests
// don't import from the package by name (they use relative paths), but
// the host source pulled in via `@synadia-ai/agent-service/testing`
// does — `reference-agent.ts` imports `AgentSubject` and friends from
// `@synadia-ai/agents`. Without this alias, vitest tries to resolve
// through the package.json's `main: "./dist/index.cjs"`, which requires
// a fresh build before every CI run.
const CALLER_SRC = resolve(__dirname, "src");

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
      "@synadia-ai/agents/errors": `${CALLER_SRC}/errors.ts`,
      "@synadia-ai/agents": `${CALLER_SRC}/index.ts`,
    },
  },
});
