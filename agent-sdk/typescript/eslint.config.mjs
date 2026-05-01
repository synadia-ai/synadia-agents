import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Pure-core files must NOT import from @nats-io/* — keeps the host SDK's
// wire-shape/encoder logic transport-agnostic so a future browser/WS
// build is additive, not a rewrite. Mirrors the rule on the caller side.
const PURE_CORE_FILES = ["src/heartbeat/payload.ts", "src/stream/chunk-encoder.ts"];

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "test/_evidence/**",
      "eslint.config.mjs",
      "*.config.ts",
      "*.config.mts",
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    files: PURE_CORE_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@nats-io/*"],
              message:
                "Pure-core modules must not import @nats-io/*. Move NATS-dependent logic to the shell layer.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["test/**/*.ts", "examples/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  prettier,
);
