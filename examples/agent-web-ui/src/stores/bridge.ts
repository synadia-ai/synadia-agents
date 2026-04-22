import { reactive } from "vue";

export type BridgeStatus = "connecting" | "open" | "closed" | "error";

export const bridgeState = reactive<{
  status: BridgeStatus;
  sdkProtocolVersion: string | null;
  lastError: string | null;
}>({
  status: "connecting",
  sdkProtocolVersion: null,
  lastError: null,
});
