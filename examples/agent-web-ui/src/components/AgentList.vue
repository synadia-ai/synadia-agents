<script setup lang="ts">
import { computed } from "vue";
import { agentsState, selectAgent, sortAgents } from "../stores/agents.ts";
import AgentCard from "./AgentCard.vue";

const sorted = computed(() => sortAgents(agentsState.list));
</script>

<template>
  <aside class="panel">
    <h2 class="heading">Agents</h2>
    <div v-if="agentsState.discovering && sorted.length === 0" class="hint">discovering...</div>
    <div v-else-if="sorted.length === 0" class="empty">
      <p>No agents found.</p>
      <p class="hint">
        Start an agent (e.g. <code>pi</code> with the <code>nats-pi-channel</code> extension) and hit Refresh.
      </p>
    </div>
    <div v-else class="list">
      <AgentCard
        v-for="agent in sorted"
        :key="agent.instanceId"
        :agent="agent"
        :selected="agent.instanceId === agentsState.selectedInstanceId"
        @select="selectAgent"
      />
    </div>
  </aside>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-lg);
  background: var(--bg-primary);
  border-right: var(--border-subtle);
  overflow-y: auto;
  min-width: 0;
}
.heading {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-weight: 500;
  margin-bottom: var(--space-xs);
}
.list {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}
.empty {
  padding: var(--space-lg);
  border: 1px dashed rgba(255, 255, 255, 0.08);
  border-radius: var(--border-radius);
  color: var(--text-muted);
  font-size: var(--text-sm);
}
.empty p { color: inherit; }
.empty p + p { margin-top: var(--space-xs); }
.hint {
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.hint code {
  font-family: var(--font-mono);
  color: var(--accent-primary);
  background: transparent;
  padding: 0;
}
</style>
