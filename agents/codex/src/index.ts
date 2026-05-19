export { runBridge, AGENT_TOKEN, type RunBridgeOptions, type BridgeHandle } from "./bridge.js";
export {
  startAcpClient,
  buildChildEnv,
  defaultLaunchCommand,
  type AcpClient,
  type AcpLaunchOptions,
} from "./acp-client.js";
export { translateSessionUpdate } from "./chunk-translator.js";
export {
  connectFrom,
  resolveConnectionOptions,
  loadChannelConfig,
  CONFIG_FILE,
  CONFIG_DIR,
  type ChannelConfig,
  type ResolveNatsOptions,
} from "./nats-context.js";
