import { reactive } from "vue";

export type BridgeStatus = "connecting" | "open" | "closed" | "error";

export const bridgeState = reactive<{
  status: BridgeStatus;
  sdkProtocolVersion: string | null;
  natsServer: string | null;
  lastError: string | null;
}>({
  status: "connecting",
  sdkProtocolVersion: null,
  natsServer: null,
  lastError: null,
});
