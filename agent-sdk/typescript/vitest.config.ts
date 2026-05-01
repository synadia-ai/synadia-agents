import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve `@synadia-ai/agents` to the sibling caller package's source
// during tests. Avoids requiring a fresh `bun run build` in the caller
// after every caller-side edit. Production builds (tsup) treat the
// caller as an external — see tsup.config.ts.
const CALLER_SRC = resolve(__dirname, "../../client-sdk/typescript/src");

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    globalSetup: ["test/harness/global-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/testing/**"],
    },
  },
  resolve: {
    alias: {
      "@synadia-ai/agents/errors": `${CALLER_SRC}/errors.ts`,
      "@synadia-ai/agents/testing": `${CALLER_SRC}/testing/index.ts`,
      "@synadia-ai/agents": `${CALLER_SRC}/index.ts`,
    },
  },
});
