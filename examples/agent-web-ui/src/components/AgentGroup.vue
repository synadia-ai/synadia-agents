<script setup lang="ts">
import AgentCard from "./AgentCard.vue";
import type { DiscoveredAgentDTO } from "../wire.ts";
import { agentsState, selectAgent } from "../stores/agents.ts";

defineProps<{
  label: string;
  agents: DiscoveredAgentDTO[];
}>();
</script>

<template>
  <section class="group">
    <header class="group-head">
      <h2 class="group-title">{{ label }}</h2>
      <span class="group-count mono">{{ agents.length }}</span>
    </header>
    <div class="group-grid">
      <AgentCard
        v-for="a in agents"
        :key="a.instanceId"
        :agent="a"
        :selected="a.instanceId === agentsState.selectedInstanceId"
        @select="selectAgent"
      />
    </div>
  </section>
</template>

<style scoped>
.group {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}
.group-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
  padding-bottom: var(--space-xs);
  border-bottom: var(--border-subtle);
}
.group-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0;
}
.group-count {
  font-size: var(--text-xs);
  color: var(--text-muted);
  background: var(--bg-secondary);
  border: var(--border-subtle);
  padding: 1px 8px;
  border-radius: 999px;
}
.group-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--space-md);
}
</style>
