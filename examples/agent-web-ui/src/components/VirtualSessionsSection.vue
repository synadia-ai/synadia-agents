<script setup lang="ts">
import VirtualSessionCard from "./VirtualSessionCard.vue";
import { virtualSessionsList } from "../stores/virtualSessions.ts";
</script>

<template>
  <section v-if="virtualSessionsList.length > 0" class="group">
    <header class="group-head">
      <h2 class="group-title">Virtual Sessions</h2>
      <span class="group-count mono">{{ virtualSessionsList.length }}</span>
    </header>
    <div class="group-grid">
      <VirtualSessionCard
        v-for="vs in virtualSessionsList"
        :key="vs.id"
        :session="vs"
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
  color: var(--bucket-virtual);
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
