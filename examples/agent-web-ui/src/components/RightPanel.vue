<script setup lang="ts">
import { computed } from "vue";
import ChatPanel from "./ChatPanel.vue";
import PiSpawnForm from "./piexec/SpawnForm.vue";
import PiFanoutPanel from "./piexec/FanoutPanel.vue";
import CcSpawnForm from "./ccexec/SpawnForm.vue";
import CcFanoutPanel from "./ccexec/FanoutPanel.vue";
import { selectedAgent } from "../stores/agents.ts";
import { selectAgent } from "../stores/agents.ts";
import { piexecState } from "../stores/piexec.ts";
import { ccexecState } from "../stores/ccexec.ts";
import type { PiExecSpawnDescriptor, CcExecSpawnDescriptor } from "../wire.ts";

type Tab = "spawn" | "fanout";

const agent = computed(() => selectedAgent.value);

const role = computed<"pi-controller" | "cc-controller" | "session" | "agent" | null>(() => {
  const a = agent.value;
  if (!a) return null;
  const meta = a.metadata?.["role"];
  if (a.agent === "pi-headless" && meta === "controller") return "pi-controller";
  if (a.agent === "cc-headless" && meta === "controller") return "cc-controller";
  if ((a.agent === "pi-headless" || a.agent === "cc-headless") && meta === "session") return "session";
  return "agent";
});

// Tab state per controller flavour — mirrored on each store so the
// chosen tab persists across selection changes and accidental remounts.
// PI and CC each get their own slot since they're distinct workspaces;
// switching from a PI controller to a CC controller shouldn't clobber
// the other's last-used tab.
const piActiveTab = computed<Tab>(() => piexecState.rightPanelTab);
const ccActiveTab = computed<Tab>(() => ccexecState.rightPanelTab);
function setPiTab(t: Tab): void {
  piexecState.rightPanelTab = t;
}
function setCcTab(t: Tab): void {
  ccexecState.rightPanelTab = t;
}

function focusSpawnedSession(d: PiExecSpawnDescriptor | CcExecSpawnDescriptor): void {
  selectAgent(d.instance_id);
}
</script>

<template>
  <aside class="right-panel">
    <!-- Empty state -->
    <div v-if="!agent" class="empty">
      <div class="empty-inner">
        <h2>Pick something</h2>
        <p>
          Click any agent in the grid to prompt it. Click a <span class="mono">pi-headless</span> or
          <span class="mono">claude-code-headless</span> controller to spawn a new session, or fan out a
          prompt across multiple working directories.
        </p>
      </div>
    </div>

    <!-- pi-headless controller: Spawn / Fan-out tabs -->
    <template v-else-if="role === 'pi-controller'">
      <header class="panel-head">
        <div class="head-title">
          <span class="agent-tag mono ctrl">pi-headless</span>
          <span class="head-owner mono">@{{ agent.owner }}</span>
        </div>
        <div class="head-sub mono">{{ agent.promptEndpoint.subject }}</div>
      </header>
      <nav class="tab-bar">
        <button
          type="button"
          class="tab"
          :class="{ active: piActiveTab === 'spawn' }"
          @click="setPiTab('spawn')"
        >New Session</button>
        <button
          type="button"
          class="tab"
          :class="{ active: piActiveTab === 'fanout' }"
          @click="setPiTab('fanout')"
        >Fan-out</button>
      </nav>
      <div class="tab-body">
        <div v-if="piActiveTab === 'spawn'" class="scroll-wrap">
          <PiSpawnForm @spawned="focusSpawnedSession" />
        </div>
        <PiFanoutPanel v-else />
      </div>
    </template>

    <!-- claude-code-headless controller: Spawn / Fan-out tabs (mirrors pi). -->
    <template v-else-if="role === 'cc-controller'">
      <header class="panel-head">
        <div class="head-title">
          <span class="agent-tag mono ctrl">cc-headless</span>
          <span class="head-owner mono">@{{ agent.owner }}</span>
        </div>
        <div class="head-sub mono">{{ agent.promptEndpoint.subject }}</div>
      </header>
      <nav class="tab-bar">
        <button
          type="button"
          class="tab"
          :class="{ active: ccActiveTab === 'spawn' }"
          @click="setCcTab('spawn')"
        >New Session</button>
        <button
          type="button"
          class="tab"
          :class="{ active: ccActiveTab === 'fanout' }"
          @click="setCcTab('fanout')"
        >Fan-out</button>
      </nav>
      <div class="tab-body">
        <div v-if="ccActiveTab === 'spawn'" class="scroll-wrap">
          <CcSpawnForm @spawned="focusSpawnedSession" />
        </div>
        <CcFanoutPanel v-else />
      </div>
    </template>

    <!-- session or regular agent: Chat -->
    <ChatPanel v-else :agent="agent" />
  </aside>
</template>

<style scoped>
.right-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-primary);
}

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-2xl);
}
.empty-inner {
  max-width: 360px;
  text-align: center;
  color: var(--text-muted);
}
.empty-inner h2 {
  color: var(--text-secondary);
  margin-bottom: var(--space-md);
}
.empty-inner p {
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
}
.empty-inner .mono { color: var(--accent-primary); }

.panel-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-md) var(--space-lg);
  background: var(--bg-primary);
  border-bottom: var(--border-subtle);
  flex-shrink: 0;
}
.head-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
}
.agent-tag {
  font-size: var(--text-xs);
  color: var(--accent-primary);
  background: var(--accent-glow);
  padding: 1px 6px;
  border-radius: var(--border-radius-sm);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.agent-tag.ctrl {
  /* Matches the per-bucket palette used by AgentCard's tag pill — both
     pi-headless and claude-code-headless controllers share the violet
     "headless" hue. */
  color: var(--bucket-headless);
  background: color-mix(in srgb, var(--bucket-headless) 14%, transparent);
}
.head-name {
  color: var(--text-primary);
  font-weight: 600;
}
.head-owner { color: var(--text-muted); font-size: var(--text-xs); }
.head-sub {
  color: var(--text-dim);
  font-size: var(--text-xs);
}

.tab-bar {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-secondary);
  border-bottom: var(--border-subtle);
  flex-shrink: 0;
}
.tab {
  font-size: var(--text-xs);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 6px 12px;
  border-radius: var(--border-radius-sm);
  color: var(--text-muted);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all var(--transition-fast);
}
.tab:hover {
  color: var(--text-secondary);
  background: var(--bg-hover);
}
.tab.active {
  color: var(--accent-primary);
  background: var(--accent-glow);
  box-shadow: inset 0 0 0 1px rgba(102, 126, 234, 0.3);
}

.tab-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.scroll-wrap {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-md);
}
</style>
