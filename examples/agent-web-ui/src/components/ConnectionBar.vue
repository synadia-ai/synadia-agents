<script setup lang="ts">
import { computed } from "vue";
import { bridgeState } from "../stores/bridge.ts";
import { agentsState } from "../stores/agents.ts";

const emit = defineEmits<{ refresh: [] }>();

// Build version — Vite-`define`d at build time from package.json so
// `bun run build` always picks up the current value without a runtime
// fetch. No longer rendered visibly in the bar; surfaced on the brand
// title's hover tooltip alongside the SDK protocol version.
const appVersion = __APP_VERSION__;

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
      <span
        v-if="bridgeState.natsServer"
        class="nats-server mono"
        :title="`NATS server ${bridgeState.natsServer}`"
      >
        <span class="dim">›</span>{{ bridgeState.natsServer }}
      </span>
    </div>

    <div class="brand">
      <span
        class="brand-title"
        :title="`Build v${appVersion}` + (bridgeState.sdkProtocolVersion ? ` · protocol v${bridgeState.sdkProtocolVersion}` : '')"
      >NATS Agent Console</span>
    </div>

    <div class="right">
      <slot name="actions" />
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
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: var(--space-sm);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
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

.nats-server {
  font-size: var(--text-xs);
  color: var(--text-muted);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 28ch;
}
.nats-server .dim {
  color: var(--accent-primary);
  opacity: 0.6;
  margin-right: 4px;
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
