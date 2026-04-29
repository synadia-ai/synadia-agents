<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import ConnectionBar from "./components/ConnectionBar.vue";
import AgentGrid from "./components/AgentGrid.vue";
import RightPanel from "./components/RightPanel.vue";
import { bridgeState } from "./stores/bridge.ts";
import {
  agentsState,
  ccexecControllers,
  piexecControllers,
} from "./stores/agents.ts";
import { mergeSummaries } from "./stores/piexec.ts";
import { mergeCcSummaries } from "./stores/ccexec.ts";
import { useBridge } from "./composables/useBridge.ts";
import type { CcExecSessionSummary, PiExecSessionSummary } from "./wire.ts";

const bridge = useBridge();
const error = ref<string | null>(null);

async function refreshAgents(): Promise<void> {
  if (agentsState.discovering) return;
  agentsState.discovering = true;
  error.value = null;
  try {
    await bridge.discover();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    agentsState.discovering = false;
  }
}

// Auto-discover on first connect and after any reconnect.
watch(
  () => bridgeState.status,
  (newStatus, oldStatus) => {
    if (newStatus === "open" && oldStatus !== "open") {
      void refreshAgents();
    }
  },
  { immediate: true },
);

// Poll every visible controller for session summaries every 5s. Without this,
// session cards in the grid would never receive lifetime / queue / cost data
// (those fields live in controller-side summaries, not the discovery record).
let summaryTimer: ReturnType<typeof setInterval> | null = null;
async function refreshSummaries(): Promise<void> {
  const piResults: PiExecSessionSummary[] = [];
  const ccResults: CcExecSessionSummary[] = [];
  await Promise.all([
    ...piexecControllers.value.map(async (c) => {
      try {
        const list = await bridge.piexecList(c.instanceId);
        piResults.push(...list);
      } catch {
        /* ignore — best-effort */
      }
    }),
    ...ccexecControllers.value.map(async (c) => {
      try {
        const list = await bridge.ccexecList(c.instanceId);
        ccResults.push(...list);
      } catch {
        /* ignore — best-effort */
      }
    }),
  ]);
  mergeSummaries(piResults);
  mergeCcSummaries(ccResults);
}

onMounted(() => {
  summaryTimer = setInterval(() => void refreshSummaries(), 5_000);
  void refreshSummaries();
});
onUnmounted(() => {
  if (summaryTimer) clearInterval(summaryTimer);
});
</script>

<template>
  <ConnectionBar @refresh="refreshAgents" />
  <div v-if="error" class="global-error mono">{{ error }}</div>
  <main class="shell">
    <AgentGrid />
    <RightPanel />
  </main>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 1fr 480px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.global-error {
  padding: var(--space-sm) var(--space-lg);
  font-size: var(--text-xs);
  color: var(--error);
  background: var(--error-dim);
  border-bottom: 1px solid rgba(248, 113, 113, 0.3);
}

@media (max-width: 1100px) {
  .shell {
    grid-template-columns: 1fr 380px;
  }
}
</style>
