<script setup lang="ts">
import { computed } from "vue";
import AgentGroup from "./AgentGroup.vue";
import { agentsState, agentsByBucket } from "../stores/agents.ts";

const groups = computed(() => agentsByBucket.value);
const isEmpty = computed(() => groups.value.length === 0);
</script>

<template>
  <main class="grid-pane">
    <header class="grid-head">
      <div>
        <h1 class="grid-title">Agent Network</h1>
        <p class="grid-sub">
          Live view of every AI agent on the connected NATS cluster. Click any agent to chat, or a controller to spawn a new session.
        </p>
      </div>
    </header>

    <div class="grid-body">
      <div v-if="isEmpty && agentsState.discovering" class="placeholder mono">discovering…</div>
      <div v-else-if="isEmpty" class="placeholder">
        <h2>No agents found</h2>
        <p>
          Spin up an agent (e.g. <code class="mono">pi</code> with the
          <code class="mono">nats-pi-channel</code> extension, or
          <code class="mono">examples/pi-headless</code> /
          <code class="mono">examples/claude-code-headless</code>) and hit Refresh.
        </p>
      </div>
      <div v-else class="groups">
        <AgentGroup
          v-for="g in groups"
          :key="g.bucket"
          :label="g.label"
          :agents="g.agents"
        />
      </div>
    </div>
  </main>
</template>

<style scoped>
.grid-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-primary);
  border-right: var(--border-subtle);
}
.grid-head {
  padding: var(--space-lg) var(--space-xl) var(--space-md);
  border-bottom: var(--border-subtle);
  flex-shrink: 0;
}
.grid-title {
  font-size: var(--text-xl);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}
.grid-sub {
  font-size: var(--text-sm);
  color: var(--text-muted);
  margin: 4px 0 0;
}
.grid-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-lg) var(--space-xl);
}
.groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-2xl);
}
.placeholder {
  padding: var(--space-2xl);
  text-align: center;
  color: var(--text-muted);
}
.placeholder h2 {
  color: var(--text-secondary);
  margin-bottom: var(--space-md);
}
.placeholder p {
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  max-width: 480px;
  margin: 0 auto;
}
.placeholder code {
  color: var(--accent-primary);
  background: transparent;
  padding: 0;
}
</style>
