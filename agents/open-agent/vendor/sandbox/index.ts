// Barrel for `@open-agents/sandbox`. The `tsconfig.json` `paths`
// rewrite makes every `import ... from "@open-agents/sandbox"` in the
// vendored agent code resolve here. We re-export the verbatim
// interface + type symbols (matching upstream exports the vendored
// code uses) plus our custom factory + LocalSandbox.

export type {
  ExecResult,
  Sandbox,
  SandboxHook,
  SandboxHooks,
  SandboxStats,
  SandboxType,
  SnapshotResult,
} from "./interface.js";

export type { Source, FileEntry, SandboxStatus } from "./types.js";

export {
  connectSandbox,
  type SandboxState,
  type ConnectOptions,
  type SandboxConnectConfig,
} from "./factory.js";

export { connectLocalSandbox, type LocalSandboxState } from "./local.js";
