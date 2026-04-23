<script setup lang="ts">
import { computed } from "vue";
import { piexecControllers } from "../../stores/agents.ts";
import { piexecState } from "../../stores/piexec.ts";

const options = computed(() => piexecControllers.value);

function onChange(e: Event): void {
  const sel = (e.target as HTMLSelectElement).value;
  piexecState.selectedControllerId = sel === "" ? null : sel;
}
</script>

<template>
  <div class="wrap">
    <label class="label mono">Controller</label>
    <select
      class="select mono"
      :value="piexecState.selectedControllerId ?? ''"
      :disabled="options.length === 0"
      @change="onChange"
    >
      <option v-if="options.length === 0" value="">no pi-headless controller discovered</option>
      <option v-for="c in options" :key="c.instanceId" :value="c.instanceId">
        {{ c.agent }} / {{ c.owner }} / {{ c.name }} — {{ c.instanceId.slice(0, 8) }}
      </option>
    </select>
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-primary);
  border-bottom: var(--border-subtle);
  flex-shrink: 0;
}
.label {
  font-size: var(--text-xs);
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.select {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 var(--space-sm);
  background: var(--bg-secondary);
  border: var(--border-subtle);
  border-radius: var(--border-radius);
  color: var(--text-primary);
  font-size: var(--text-xs);
}
.select:focus {
  outline: none;
  border-color: var(--accent-primary);
}
.select:disabled { opacity: 0.6; }
</style>
