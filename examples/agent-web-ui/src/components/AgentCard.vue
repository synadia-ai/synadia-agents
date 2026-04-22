<script setup lang="ts">
import { computed } from "vue";
import AgentStatusDot from "./AgentStatusDot.vue";
import type { DiscoveredAgentDTO } from "../wire.ts";

const props = defineProps<{
  agent: DiscoveredAgentDTO;
  selected: boolean;
}>();

defineEmits<{ select: [instanceId: string] }>();

const subtitle = computed(() => props.agent.session ?? props.agent.name);

const humanPayload = computed(() => {
  const n = props.agent.promptEndpoint.maxPayloadBytes;
  if (!n) return null;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
});
</script>

<template>
  <button
    class="card"
    :class="{ selected }"
    type="button"
    @click="$emit('select', agent.instanceId)"
  >
    <AgentStatusDot class="status-led" :instance-id="agent.instanceId" />
    <div class="head">
      <span class="agent-tag mono">{{ agent.agent }}</span>
      <span class="name">{{ subtitle }}</span>
    </div>
    <div class="meta">
      <span class="owner mono">{{ agent.owner }}</span>
      <span v-if="agent.session && agent.session !== agent.name" class="sep">·</span>
      <span v-if="agent.session && agent.session !== agent.name" class="subtle mono">{{ agent.name }}</span>
    </div>
    <div class="badges">
      <span v-if="humanPayload" class="badge">{{ humanPayload }}</span>
      <span
        v-if="agent.promptEndpoint.attachmentsOk"
        class="badge attachments-ok"
        title="attachments_ok = true"
      >📎 attachments</span>
      <span v-if="agent.protocolVersion" class="badge subtle-badge">v{{ agent.protocolVersion }}</span>
    </div>
    <p v-if="agent.description" class="desc">{{ agent.description }}</p>
  </button>
</template>

<style scoped>
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  padding: var(--space-md);
  background: var(--bg-secondary);
  border: var(--border-subtle);
  border-radius: var(--border-radius);
  text-align: left;
  transition: all var(--transition-normal);
  cursor: pointer;
  width: 100%;
}
.status-led {
  position: absolute;
  top: var(--space-sm);
  right: var(--space-sm);
}
.card:hover {
  background: var(--bg-tertiary);
  border-color: rgba(255, 255, 255, 0.12);
  transform: translateY(-1px);
}
.card.selected {
  border-color: var(--accent-primary);
  background: linear-gradient(135deg, var(--bg-tertiary), var(--bg-secondary));
  box-shadow: var(--shadow-glow);
}

.head {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
}
.agent-tag {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--accent-primary);
  background: var(--accent-glow);
  padding: 1px 6px;
  border-radius: var(--border-radius-sm);
}
.name {
  font-weight: 600;
  color: var(--text-primary);
  font-size: var(--text-base);
}

.meta {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: var(--text-xs);
  color: var(--text-muted);
}
.owner { color: var(--text-secondary); }
.sep { color: var(--text-dim); }
.subtle { color: var(--text-muted); }

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  margin-top: var(--space-xs);
}
.badge {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: var(--border-radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  border: 1px solid rgba(255, 255, 255, 0.05);
}
.badge.attachments-ok {
  color: var(--accent-primary);
  border-color: var(--accent-glow-strong);
}
.badge.subtle-badge {
  color: var(--text-dim);
}

.desc {
  font-size: var(--text-xs);
  color: var(--text-muted);
  line-height: var(--leading-normal);
  margin-top: var(--space-xs);
}
</style>
