<script setup lang="ts">
import { computed } from "vue";
import { bridgeState } from "../stores/bridge.ts";
import { agentsState } from "../stores/agents.ts";

const emit = defineEmits<{ refresh: [] }>();

const statusLabel = computed(() => {
  switch (bridgeState.status) {
    case "connecting":
      return "connecting...";
    case "open":
      return "connected";
    case "closed":
      return "reconnecting...";
    case "error":
      return "error";
    default:
      return bridgeState.status;
  }
});
</script>

<template>
  <header class="bar">
    <div class="left">
      <span class="dot" :data-status="bridgeState.status" />
      <span class="label mono">{{ statusLabel }}</span>
      <span v-if="bridgeState.sdkProtocolVersion" class="proto mono">
        protocol {{ bridgeState.sdkProtocolVersion }}
      </span>
    </div>

    <div class="brand">
      <span class="brand-title">nats-ai-testui</span>
    </div>

    <div class="right">
      <span class="agents-count mono">
        {{ agentsState.list.length }} agent{{ agentsState.list.length === 1 ? "" : "s" }}
      </span>
      <button
        class="refresh-btn"
        :disabled="bridgeState.status !== 'open' || agentsState.discovering"
        @click="emit('refresh')"
      >
        {{ agentsState.discovering ? "..." : "Refresh" }}
      </button>
    </div>
  </header>
</template>

<style scoped>
.bar {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  height: var(--topbar-height);
  padding: 0 var(--space-lg);
  background: var(--bg-primary);
  border-bottom: var(--border-subtle);
  flex-shrink: 0;
}

.left {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.right {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  justify-content: flex-end;
}

.brand {
  text-align: center;
}

.brand-title {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--text-secondary);
  letter-spacing: 0.04em;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-dim);
  box-shadow: 0 0 0 0 transparent;
  transition: background var(--transition-normal), box-shadow var(--transition-normal);
}
.dot[data-status="connecting"] { background: var(--warning); animation: pulse 1.4s infinite; }
.dot[data-status="open"] { background: var(--success); box-shadow: 0 0 0 3px var(--success-dim); }
.dot[data-status="closed"] { background: var(--warning); animation: pulse 1.4s infinite; }
.dot[data-status="error"] { background: var(--error); box-shadow: 0 0 0 3px var(--error-dim); }

.label {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.proto {
  font-size: var(--text-xs);
  color: var(--text-dim);
  margin-left: var(--space-xs);
}

.agents-count {
  font-size: var(--text-xs);
  color: var(--text-muted);
  letter-spacing: 0.04em;
}

.refresh-btn {
  padding: 4px 12px;
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: var(--border-subtle);
  border-radius: var(--border-radius-sm);
  transition: all var(--transition-fast);
}
.refresh-btn:hover:not(:disabled) {
  color: var(--accent-primary);
  border-color: var(--accent-primary);
  background: var(--accent-glow);
}
</style>
