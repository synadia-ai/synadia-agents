import { defineConfig } from "vitest/config";

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
      exclude: ["src/**/*.d.ts", "src/testing/**"],
    },
  },
});
