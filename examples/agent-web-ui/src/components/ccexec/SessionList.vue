<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useBridge } from "../../composables/useBridge.ts";
import { agentsState, selectAgent } from "../../stores/agents.ts";
import {
  ccexecState,
  mergeCcSummaries,
  onCcStopped,
  selectedCcController,
  visibleCcSessions,
} from "../../stores/ccexec.ts";
import AgentStatusDot from "../AgentStatusDot.vue";
import type { DiscoveredAgentDTO, CcExecSessionSummary } from "../../wire.ts";

const bridge = useBridge();
const stoppingIds = ref<Set<string>>(new Set());
let tick: ReturnType<typeof setInterval> | null = null;

const rows = computed(() =>
  visibleCcSessions.value.map((agent) => {
    const summary = ccexecState.summaries.get(agent.name);
    return { agent, summary };
  }),
);

const selectedInstanceId = computed(() => agentsState.selectedInstanceId);

async function refresh(): Promise<void> {
  const controller = selectedCcController.value;
  if (!controller || ccexecState.refreshing) return;
  ccexecState.refreshing = true;
  try {
    const list = await bridge.ccexecList(controller.instanceId);
    mergeCcSummaries(list);
  } catch (err) {
    ccexecState.lastError = `list failed: ${(err as Error).message}`;
  } finally {
    ccexecState.refreshing = false;
  }
}

async function onStop(agent: DiscoveredAgentDTO): Promise<void> {
  const controller = selectedCcController.value;
  if (!controller) return;
  if (!confirm(`Stop session ${agent.name}? In-flight prompts will be cut off.`)) return;
  stoppingIds.value.add(agent.name);
  try {
    await bridge.ccexecStop(controller.instanceId, agent.name);
    onCcStopped(agent.name);
  } catch (err) {
    ccexecState.lastError = `stop failed: ${(err as Error).message}`;
  } finally {
    stoppingIds.value.delete(agent.name);
  }
}

onMounted(() => {
  tick = setInterval(() => void refresh(), 5_000);
  void refresh();
});

onUnmounted(() => {
  if (tick) clearInterval(tick);
});

function fmtRemaining(summary: CcExecSessionSummary | undefined): string {
  if (!summary) return "";
  if (summary.max_lifetime_s === 0) return "∞";
  const r = summary.remaining_lifetime_s;
  if (r <= 0) return "expired";
  if (r >= 3600) return `${Math.floor(r / 3600)}h ${Math.floor((r % 3600) / 60)}m`;
  if (r >= 60) return `${Math.floor(r / 60)}m ${r % 60}s`;
  return `${r}s`;
}

function lifetimePercent(summary: CcExecSessionSummary | undefined): number {
  if (!summary || summary.max_lifetime_s === 0) return 0;
  const used = summary.max_lifetime_s - summary.remaining_lifetime_s;
  return Math.max(0, Math.min(100, (used / summary.max_lifetime_s) * 100));
}

function fmtTools(summary: CcExecSessionSummary | undefined, agent: DiscoveredAgentDTO): string {
  const tools = summary?.allowed_tools ?? agent.metadata?.["allowed_tools"]?.split(",") ?? [];
  if (tools.length === 0) return "-";
  if (tools.length <= 3) return tools.join(",");
  return `${tools.slice(0, 3).join(",")}+${tools.length - 3}`;
}
</script>

<template>
  <section class="panel">
    <div class="head">
      <h3 class="heading">Sessions</h3>
      <button
        type="button"
        class="refresh-btn mono"
        :disabled="ccexecState.refreshing || !selectedCcController"
        @click="refresh"
      >{{ ccexecState.refreshing ? '…' : '↻' }}</button>
    </div>
    <div v-if="!selectedCcController" class="empty mono">select a controller</div>
    <div v-else-if="rows.length === 0" class="empty">No sessions. Spawn one to get started.</div>
    <ul v-else class="list">
      <li
        v-for="{ agent, summary } in rows"
        :key="agent.instanceId"
        class="row"
        :class="{ selected: selectedInstanceId === agent.instanceId }"
      >
        <button
          type="button"
          class="row-body"
          @click="selectAgent(agent.instanceId)"
        >
          <div class="title">
            <AgentStatusDot class="dot" :instance-id="agent.instanceId" />
            <span class="sid mono">{{ agent.name }}</span>
            <span v-if="summary?.active_request" class="running-tag">running</span>
          </div>
          <div class="cwd mono">{{ summary?.cwd ?? agent.metadata?.['cwd'] ?? '?' }}</div>
          <div class="meta">
            <span class="meta-key mono">model</span>
            <span class="meta-val mono">{{ summary?.model ?? agent.metadata?.['model'] ?? '-' }}</span>
            <span class="meta-key mono">perm</span>
            <span class="meta-val mono">{{ summary?.permission_mode ?? agent.metadata?.['permission_mode'] ?? '-' }}</span>
            <span class="meta-key mono">tools</span>
            <span class="meta-val mono">{{ fmtTools(summary, agent) }}</span>
            <span class="meta-key mono">ttl</span>
            <span class="meta-val mono">{{ fmtRemaining(summary) }}</span>
            <span v-if="summary && summary.queued_requests > 0" class="meta-key mono">queue</span>
            <span v-if="summary && summary.queued_requests > 0" class="meta-val mono">{{ summary.queued_requests }}</span>
          </div>
          <div v-if="summary && summary.max_lifetime_s > 0" class="progress">
            <div class="progress-fill" :style="{ width: `${lifetimePercent(summary)}%` }" />
          </div>
        </button>
        <button
          type="button"
          class="stop-btn"
          :disabled="stoppingIds.has(agent.name)"
          title="Stop session"
          @click="onStop(agent)"
        >✕</button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  min-height: 0;
  flex: 1;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.heading {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-dim);
  font-family: var(--font-mono);
}
.refresh-btn {
  height: 24px;
  width: 28px;
  border: var(--border-subtle);
  background: var(--bg-secondary);
  border-radius: var(--border-radius-sm);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
.refresh-btn:disabled { opacity: 0.4; }
.refresh-btn:hover:not(:disabled) {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
}
.empty {
  padding: var(--space-md);
  font-size: var(--text-xs);
  color: var(--text-muted);
  border: 1px dashed rgba(255, 255, 255, 0.08);
  border-radius: var(--border-radius);
}

.list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  overflow-y: auto;
  min-height: 0;
  padding-right: 2px;
}
.row {
  display: flex;
  align-items: stretch;
  gap: var(--space-xs);
  background: var(--bg-secondary);
  border: var(--border-subtle);
  border-radius: var(--border-radius);
  overflow: hidden;
  transition: border-color var(--transition-fast);
}
.row.selected {
  border-color: var(--accent-primary);
  box-shadow: var(--shadow-glow);
}
.row:hover { border-color: rgba(255, 255, 255, 0.15); }

.row-body {
  flex: 1;
  min-width: 0;
  padding: var(--space-sm) var(--space-md);
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.title {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}
.dot { width: 8px; height: 8px; }
.sid {
  font-weight: 600;
  color: var(--text-primary);
  font-size: var(--text-xs);
}
.running-tag {
  font-family: var(--font-mono);
  font-size: 9px;
  padding: 1px 5px;
  border-radius: var(--border-radius-sm);
  background: var(--accent-glow);
  color: var(--accent-primary);
}
.cwd {
  font-size: var(--text-xs);
  color: var(--text-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px var(--space-xs);
  margin-top: 2px;
  font-size: 10px;
  line-height: 1.3;
}
.meta-key { color: var(--text-dim); text-transform: uppercase; }
.meta-val { color: var(--text-secondary); }

.progress {
  margin-top: var(--space-xs);
  height: 2px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 1px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--accent-gradient);
  transition: width 1s linear;
}

.stop-btn {
  padding: 0 var(--space-sm);
  background: transparent;
  border: none;
  color: var(--text-dim);
  font-size: var(--text-base);
  cursor: pointer;
  flex-shrink: 0;
}
.stop-btn:hover:not(:disabled) {
  background: var(--error-dim);
  color: var(--error);
}
.stop-btn:disabled { opacity: 0.4; cursor: wait; }
</style>
