<script setup lang="ts">
import { computed } from "vue";
import { useMarkdown } from "../../composables/useMarkdown.ts";
import type { FanoutRun } from "../../stores/piexec.ts";

const props = defineProps<{
  run: FanoutRun;
}>();

defineEmits<{
  cancel: [id: string];
}>();

const md = useMarkdown();
const html = computed(() => md.renderMarkdown(props.run.content));

const statusLabel = computed(() => {
  switch (props.run.status) {
    case "pending":
      return "queued";
    case "spawning":
      return "spawning…";
    case "running":
      return "running";
    case "done":
      return "done";
    case "error":
      return "error";
    case "stopped":
      return "stopped";
    default:
      return props.run.status;
  }
});
</script>

<template>
  <article class="card" :class="['status-' + run.status]">
    <header class="head">
      <span class="dot" />
      <span class="cwd mono">{{ run.cwd }}</span>
      <span class="status mono">{{ statusLabel }}</span>
      <button
        v-if="run.status === 'running' || run.status === 'spawning'"
        class="cancel"
        type="button"
        @click="$emit('cancel', run.id)"
      >stop</button>
    </header>
    <div v-if="run.error" class="error mono">{{ run.error }}</div>
    <div v-if="run.content" class="content markdown" v-html="html" />
    <div v-else-if="run.status === 'pending' || run.status === 'spawning'" class="hint mono">…</div>
  </article>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-secondary);
  border: var(--border-subtle);
  border-left: 3px solid var(--text-dim);
  border-radius: var(--border-radius);
  min-height: 120px;
}
.card.status-running { border-left-color: var(--accent-primary); }
.card.status-done    { border-left-color: var(--success, #4ade80); }
.card.status-error   { border-left-color: var(--error); }
.card.status-stopped { border-left-color: var(--warning, #f59e0b); }

.head {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  flex-wrap: wrap;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-dim);
  flex-shrink: 0;
}
.status-running .dot { background: var(--accent-primary); animation: pulse 1.5s infinite; }
.status-done .dot    { background: var(--success, #4ade80); }
.status-error .dot   { background: var(--error); }
.status-stopped .dot { background: var(--warning, #f59e0b); }

.cwd {
  flex: 1;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-dim);
}
.cancel {
  height: 22px;
  padding: 0 var(--space-sm);
  font-size: 10px;
  background: transparent;
  border: 1px solid var(--error);
  color: var(--error);
  border-radius: var(--border-radius-sm);
}
.cancel:hover { background: var(--error-dim); }

.error {
  font-size: var(--text-xs);
  color: var(--error);
  padding: var(--space-xs);
  background: var(--error-dim);
  border-radius: var(--border-radius-sm);
}

.content {
  font-size: var(--text-sm);
  color: var(--text-primary);
  line-height: var(--leading-relaxed);
  max-height: 400px;
  overflow-y: auto;
}
.hint {
  font-size: var(--text-xs);
  color: var(--text-dim);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
