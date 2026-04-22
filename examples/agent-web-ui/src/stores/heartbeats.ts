// Tracks the arrival time of the most recent heartbeat per agent instanceId.
//
// The browser clock is used (Date.now()) rather than the heartbeat payload's
// own `ts` — we want a monotonic "did one just arrive?" tick for the LED
// flash animation, not a wall-clock timestamp.

import { reactive } from "vue";

export const heartbeatsState = reactive<{
  byInstanceId: Record<string, number>;
}>({
  byInstanceId: {},
});

export function recordHeartbeat(instanceId: string): void {
  heartbeatsState.byInstanceId[instanceId] = Date.now();
}
