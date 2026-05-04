<script setup lang="ts">
import { computed } from "vue";
import AgentGroup from "./AgentGroup.vue";
import MultiSelectBar from "./MultiSelectBar.vue";
import VirtualSessionsSection from "./VirtualSessionsSection.vue";
import { agentsState, agentSections } from "../stores/agents.ts";
import { selectionState } from "../stores/selection.ts";
import { virtualSessionsList } from "../stores/virtualSessions.ts";

const groups = computed(() => agentSections.value);
// Empty state for the placeholder card only fires when there are no real
// agents AND no virtual sessions; a fresh page with virtual sessions
// alone still needs the grid header chrome.
const isEmpty = computed(
  () => groups.value.length === 0 && virtualSessionsList.value.length === 0,
);
const hasSelection = computed(() => selectionState.ids.size > 0);
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
        <VirtualSessionsSection />
        <AgentGroup
          v-for="g in groups"
          :key="g.id"
          :label="g.label"
          :agents="g.agents"
        />
      </div>
    </div>

    <Transition name="bar">
      <MultiSelectBar v-if="hasSelection" />
    </Transition>
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

/* Slide the multi-select action bar up from below the grid pane.
   Transform-only animation so the layout reflow (grid-body shrinking to
   make room for the bar) is the only DOM resize — the bar itself just
   slides into the space that opens up. */
.bar-enter-active,
.bar-leave-active {
  transition: transform 0.22s ease, opacity 0.18s ease;
}
.bar-enter-from,
.bar-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
.bar-enter-to,
.bar-leave-from {
  transform: translateY(0);
  opacity: 1;
}
</style>
