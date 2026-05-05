// Public surface of `@synadia-ai/open-agent`.
//
// The Vercel-sandbox example (and any other host that wants to reuse the
// bridge logic with a different sandbox) imports `runBridge` from here
// and supplies its own `sandboxFactory`. The bridge owns NATS wiring; the
// caller owns the sandbox.

export { runBridge, type RunBridgeOptions, type SandboxBundle } from "./bridge.js";
export type {
  AgentFactory,
  AgentFactoryInput,
  AgentRun,
} from "./bridge.js";
export {
  gatewayModelFactory,
  openRouterModelFactory,
  type ModelFactory,
  type OpenRouterFactoryOptions,
} from "./model-factory.js";
export { translatePart, type UIPart } from "./chunk-translator.js";
export {
  connectFrom,
  resolveConnectionOptions,
  type ResolveNatsOptions,
} from "./nats-context.js";
export { connectLocalSandbox, type LocalSandboxState } from "../vendor/sandbox/local.js";
export {
  connectSandbox,
  type SandboxState,
  type ConnectOptions,
} from "../vendor/sandbox/factory.js";
export type { Sandbox, SandboxStats, ExecResult } from "../vendor/sandbox/interface.js";
