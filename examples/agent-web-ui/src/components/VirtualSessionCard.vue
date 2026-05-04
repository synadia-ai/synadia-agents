<script setup lang="ts">
import { computed } from "vue";
import { agentsState, selectAgent } from "../stores/agents.ts";
import {
  deleteVirtualSession,
  isVirtualSessionActive,
  virtualTargetLabel,
  type VirtualSession,
} from "../stores/virtualSessions.ts";
import { useBridge } from "../composables/useBridge.ts";

const props = defineProps<{ session: VirtualSession }>();

const bridge = useBridge();

const selected = computed(
  () => agentsState.selectedInstanceId === props.session.id,
);

const targetLabels = computed(() =>
  props.session.targets.map((id) => {
    const agent = agentsState.list.find((a) => a.instanceId === id);
    if (!agent) return { label: `${id.slice(0, 8)}…`, online: false };
    return { label: virtualTargetLabel(agent), online: true };
  }),
);

const onlineCount = computed(() => targetLabels.value.filter((t) => t.online).length);

const running = computed(() => isVirtualSessionActive(props.session.id));

function onTrash(e: Event): void {
  e.stopPropagation();
  if (!confirm(`Delete ${props.session.label}?`)) return;
  // Cancel any in-flight per-source streams so nothing keeps writing into
  // a session we're about to drop. Snapshot the values first so a future
  // bridge.cancel that synchronously mutates the map (it doesn't today)
  // wouldn't break the iteration mid-loop.
  for (const promptId of [...props.session.activePromptIds.values()]) {
    bridge.cancel(promptId);
  }
  deleteVirtualSession(props.session.id);
}
</script>

<template>
  <div class="card-wrap">
    <div
      class="card"
      :class="{ selected }"
      role="button"
      tabindex="0"
      @click="selectAgent(session.id)"
      @keydown.enter.prevent="selectAgent(session.id)"
      @keydown.space.prevent="selectAgent(session.id)"
    >
      <header class="card-head">
        <div class="head-tags">
          <span class="agent-tag mono">VIRTUAL</span>
          <span v-if="running" class="running-tag mono" title="At least one target is mid-stream">running</span>
        </div>
      </header>

      <h3 class="card-title">{{ session.label }}</h3>

      <p class="meta mono">
        <span>{{ onlineCount }} of {{ session.targets.length }} online</span>
      </p>

      <div class="grow-spacer" aria-hidden="true" />

      <ul class="targets">
        <li
          v-for="(t, i) in targetLabels"
          :key="i"
          class="target mono"
          :class="{ offline: !t.online }"
          :title="t.label"
        >{{ t.label }}</li>
      </ul>
    </div>

    <button
      type="button"
      class="trash-btn"
      title="Delete virtual session"
      @click.stop="onTrash"
    >
      <svg
        class="icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 6h18" />
        <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.card-wrap {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
}
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  flex: 1;
  padding: var(--space-md);
  background: var(--bg-secondary);
  border: 1px solid color-mix(in srgb, var(--bucket-virtual) 30%, transparent);
  border-radius: var(--border-radius);
  text-align: left;
  cursor: pointer;
  transition: all var(--transition-normal);
  width: 100%;
  overflow: hidden;
  /* Subtle vertical wash that distinguishes virtual cards from agent
     cards at a glance — same affordance pattern as the controller card's
     violet wash. */
  background: linear-gradient(
    180deg,
    var(--bg-secondary) 0%,
    color-mix(in srgb, var(--bucket-virtual) 6%, var(--bg-secondary)) 100%
  );
}
.card:hover {
  background: var(--bg-tertiary);
  border-color: color-mix(in srgb, var(--bucket-virtual) 55%, transparent);
  transform: translateY(-1px);
}
.card:focus-visible {
  outline: 2px solid var(--bucket-virtual);
  outline-offset: 2px;
}
.card.selected {
  border-color: var(--bucket-virtual);
  box-shadow:
    0 0 0 1px var(--bucket-virtual),
    0 0 18px color-mix(in srgb, var(--bucket-virtual) 30%, transparent);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}
.head-tags {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}
.agent-tag {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--bucket-virtual);
  background: color-mix(in srgb, var(--bucket-virtual) 14%, transparent);
  padding: 1px 6px;
  border-radius: var(--border-radius-sm);
}
.running-tag {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: var(--border-radius-sm);
  background: var(--accent-glow);
  color: var(--accent-primary);
}

.card-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  font-size: var(--text-xs);
  color: var(--text-muted);
  margin: 0;
}

.grow-spacer { flex: 1; min-height: 0; }

.targets {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.target {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: var(--border-radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  border: 1px solid rgba(255, 255, 255, 0.04);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.target.offline {
  color: var(--text-dim);
  text-decoration: line-through;
}

.trash-btn {
  position: absolute;
  bottom: var(--space-md);
  right: var(--space-sm);
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 50%;
  background: rgba(248, 113, 113, 0.08);
  border: 1px solid rgba(248, 113, 113, 0.25);
  color: var(--error);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all var(--transition-fast);
  z-index: 1;
}
.trash-btn:hover {
  background: var(--error-dim);
  border-color: var(--error);
  transform: scale(1.08);
}
.trash-btn .icon { width: 11px; height: 11px; display: block; }
.card-wrap:hover .trash-btn { transform: translateY(-1px); }
.card-wrap:hover .trash-btn:hover { transform: translateY(-1px) scale(1.08); }
</style>
