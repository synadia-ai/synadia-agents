<script setup lang="ts">
import { computed } from "vue";
import { heartbeatsState } from "../stores/heartbeats.ts";

const props = defineProps<{
  instanceId: string;
}>();

const lastHeartbeatAt = computed<number | null>(
  () => heartbeatsState.byInstanceId[props.instanceId] ?? null,
);

// "Connected" as long as we've ever seen a heartbeat in this session — the
// server unsubscribes vanished agents on the next discover, so stale entries
// are already pruned at the list level.
const online = computed(() => lastHeartbeatAt.value !== null);

const title = computed(() =>
  lastHeartbeatAt.value
    ? `last heartbeat ${new Date(lastHeartbeatAt.value).toLocaleTimeString()}`
    : "no heartbeat received yet",
);
</script>

<template>
  <span class="led" :class="{ online }" :title="title" aria-hidden="true">
    <span v-if="lastHeartbeatAt" :key="lastHeartbeatAt" class="flash" />
  </span>
</template>

<style scoped>
.led {
  position: relative;
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--text-dim, #555);
  box-shadow: inset 0 0 2px rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}
.led.online {
  background: var(--success);
  box-shadow: 0 0 6px var(--success), inset 0 0 1px rgba(255, 255, 255, 0.3);
}
.flash {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  animation: led-flash 600ms ease-out;
}
@keyframes led-flash {
  0% {
    box-shadow:
      0 0 4px 1px var(--success),
      0 0 10px 3px var(--success);
    background: #fff;
    transform: scale(1);
    opacity: 1;
  }
  40% {
    background: var(--success);
    opacity: 1;
  }
  100% {
    box-shadow: 0 0 0 0 var(--success);
    background: transparent;
    transform: scale(2.2);
    opacity: 0;
  }
}
</style>
