<script setup lang="ts">
import { computed, ref } from "vue";
import AgentStatusDot from "./AgentStatusDot.vue";
import type { DiscoveredAgentDTO } from "../wire.ts";
import { agentsState, bucketOf, BUCKETS, type Bucket } from "../stores/agents.ts";
import { onStopped, piexecState } from "../stores/piexec.ts";
import { ccexecState, onCcStopped } from "../stores/ccexec.ts";
import { useBridge } from "../composables/useBridge.ts";

const props = defineProps<{
  agent: DiscoveredAgentDTO;
  selected: boolean;
}>();

defineEmits<{ select: [instanceId: string] }>();

const bridge = useBridge();

const bucket = computed<Bucket>(() => bucketOf(props.agent));

const isPiSession = computed(() => bucket.value === BUCKETS.PI_EXEC_SESSION);
const isCcSession = computed(() => bucket.value === BUCKETS.CC_EXEC_SESSION);
const isController = computed(
  () =>
    bucket.value === BUCKETS.PI_EXEC_CONTROL ||
    bucket.value === BUCKETS.CC_EXEC_CONTROL,
);

const piSummary = computed(() =>
  isPiSession.value ? piexecState.summaries.get(props.agent.name) : undefined,
);
const ccSummary = computed(() =>
  isCcSession.value ? ccexecState.summaries.get(props.agent.name) : undefined,
);

const subtitle = computed(() => props.agent.session ?? props.agent.name);

const humanPayload = computed(() => {
  const n = props.agent.promptEndpoint.maxPayloadBytes;
  if (!n) return null;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
});

function fmtRemaining(maxS: number, remainingS: number): string {
  if (maxS === 0) return "∞";
  if (remainingS <= 0) return "expired";
  if (remainingS >= 3600)
    return `${Math.floor(remainingS / 3600)}h ${Math.floor((remainingS % 3600) / 60)}m`;
  if (remainingS >= 60) return `${Math.floor(remainingS / 60)}m ${remainingS % 60}s`;
  return `${remainingS}s`;
}

const lifetimeText = computed(() => {
  const s = piSummary.value ?? ccSummary.value;
  if (!s) return null;
  return fmtRemaining(s.max_lifetime_s, s.remaining_lifetime_s);
});

const lifetimePercent = computed(() => {
  const s = piSummary.value ?? ccSummary.value;
  if (!s || s.max_lifetime_s === 0) return null;
  const used = s.max_lifetime_s - s.remaining_lifetime_s;
  return Math.max(0, Math.min(100, (used / s.max_lifetime_s) * 100));
});

const cwd = computed(() => {
  const s = piSummary.value ?? ccSummary.value;
  return s?.cwd ?? props.agent.metadata?.["cwd"] ?? null;
});

const model = computed(() => {
  const s = piSummary.value ?? ccSummary.value;
  return s?.model ?? props.agent.metadata?.["model"] ?? null;
});

const ccCost = computed(() => {
  const s = ccSummary.value;
  if (!s || s.total_cost_usd <= 0) return null;
  if (s.total_cost_usd < 0.0001) return "<$0.0001";
  return `$${s.total_cost_usd.toFixed(4)}`;
});

const running = computed(() => {
  const s = piSummary.value ?? ccSummary.value;
  return s?.active_request === true;
});

const queued = computed(() => {
  const s = piSummary.value ?? ccSummary.value;
  return s && s.queued_requests > 0 ? s.queued_requests : null;
});

// Find the controller that spawned this session (matched by spawner role +
// owner). Returns null if the controller has vanished — in which case the
// stop button is shown disabled with a tooltip.
const parentController = computed(() => {
  if (!isPiSession.value && !isCcSession.value) return null;
  const role = isPiSession.value
    ? "pi-headless-controller"
    : "claude-code-headless-controller";
  return (
    agentsState.list.find(
      (a) => a.metadata?.["role"] === role && a.owner === props.agent.owner,
    ) ?? null
  );
});

const stopping = ref(false);
const stopError = ref<string | null>(null);

async function onStop(): Promise<void> {
  if (stopping.value) return;
  const controller = parentController.value;
  if (!controller) {
    stopError.value = "no controller";
    return;
  }
  if (!confirm(`Stop session ${props.agent.name}? In-flight prompts will be cut off.`)) return;
  stopping.value = true;
  stopError.value = null;
  try {
    if (isPiSession.value) {
      await bridge.piexecStop(controller.instanceId, props.agent.name);
      onStopped(props.agent.name);
    } else {
      await bridge.ccexecStop(controller.instanceId, props.agent.name);
      onCcStopped(props.agent.name);
    }
    // The agent record will disappear from the grid on the next discover /
    // agent-removed push; nothing to do locally.
  } catch (e) {
    stopError.value = (e as Error).message;
  } finally {
    stopping.value = false;
  }
}
</script>

<template>
  <div class="card-wrap">
    <button
      class="card"
      :class="{
        selected,
        'is-controller': isController,
        'is-session': isPiSession || isCcSession,
      }"
      type="button"
      @click="$emit('select', agent.instanceId)"
    >
      <header class="card-head">
        <span class="agent-tag mono">{{ agent.agent }}</span>
        <AgentStatusDot class="status-led" :instance-id="agent.instanceId" />
      </header>

      <h3 class="card-title">{{ subtitle }}</h3>

      <div class="meta">
        <span class="owner mono">@{{ agent.owner }}</span>
        <span v-if="running" class="running-tag">running</span>
        <span v-if="queued" class="queued-tag mono">+{{ queued }} queued</span>
      </div>

      <p v-if="cwd" class="cwd mono" :title="cwd">{{ cwd }}</p>

      <p
        v-if="agent.promptEndpoint.subject && !cwd"
        class="subject mono"
        :title="agent.promptEndpoint.subject"
      ><span class="dim">›</span>{{ agent.promptEndpoint.subject }}</p>

      <dl v-if="isPiSession || isCcSession" class="stats">
        <div v-if="model" class="stat">
          <dt>model</dt><dd class="mono">{{ model }}</dd>
        </div>
        <div v-if="lifetimeText" class="stat">
          <dt>lifetime</dt>
          <dd>
            <span class="mono">{{ lifetimeText }}</span>
            <span v-if="lifetimePercent !== null" class="lifetime-bar">
              <span class="lifetime-fill" :style="{ width: 100 - lifetimePercent + '%' }" />
            </span>
          </dd>
        </div>
        <div v-if="ccCost" class="stat">
          <dt>cost</dt><dd class="mono">{{ ccCost }}</dd>
        </div>
      </dl>

      <div v-if="!isPiSession && !isCcSession" class="badges">
        <span v-if="humanPayload" class="badge">{{ humanPayload }}</span>
        <span
          v-if="agent.promptEndpoint.attachmentsOk"
          class="badge attachments-ok"
          title="attachments_ok = true"
        >📎 attachments</span>
        <span v-if="agent.protocolVersion" class="badge subtle-badge">v{{ agent.protocolVersion }}</span>
      </div>

      <p v-if="isController" class="hint">click to spawn or fan out</p>
    </button>

    <button
      v-if="isPiSession || isCcSession"
      type="button"
      class="stop-btn"
      :disabled="stopping || !parentController"
      :title="
        stopError
          ? `stop failed: ${stopError}`
          : !parentController
            ? 'no controller online — cannot stop from UI'
            : 'stop session'
      "
      @click.stop="onStop"
    >×</button>
  </div>
</template>

<style scoped>
.card-wrap {
  position: relative;
  display: block;
  width: 100%;
}

.stop-btn {
  position: absolute;
  /* Sit on the same baseline as the last stat row of content (lifetime for
     pi, cost for cc). `bottom` matches the card's bottom padding so the
     button is flush with the inner-content edge; `right` is slightly tighter
     than the inner padding so the ✕ visually anchors to the card's edge. */
  bottom: var(--space-md);
  right: var(--space-sm);
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 50%;
  background: rgba(248, 113, 113, 0.08);
  border: 1px solid rgba(248, 113, 113, 0.25);
  color: var(--error);
  font-size: 12px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all var(--transition-fast);
  z-index: 1;
}
.stop-btn:hover:not(:disabled) {
  background: var(--error-dim);
  border-color: var(--error);
  transform: scale(1.08);
}
.stop-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
/* Keep the stop button aligned with the card while the card is hover-lifted. */
.card-wrap:hover .stop-btn { transform: translateY(-1px); }
.card-wrap:hover .stop-btn:hover:not(:disabled) {
  transform: translateY(-1px) scale(1.08);
}

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
  overflow: hidden;
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
.card.is-controller {
  background: linear-gradient(
    180deg,
    var(--bg-secondary) 0%,
    rgba(167, 139, 250, 0.05) 100%
  );
  border-color: rgba(167, 139, 250, 0.18);
}
.card.is-controller:hover {
  border-color: rgba(167, 139, 250, 0.5);
}
.card.is-controller.selected {
  border-color: var(--memory-preference);
  box-shadow:
    0 0 0 1px var(--memory-preference),
    0 0 18px rgba(167, 139, 250, 0.25);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}
.status-led { flex-shrink: 0; }

.agent-tag {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--accent-primary);
  background: var(--accent-glow);
  padding: 1px 6px;
  border-radius: var(--border-radius-sm);
}
.is-controller .agent-tag {
  color: var(--memory-preference);
  background: rgba(167, 139, 250, 0.12);
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
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: var(--text-xs);
  color: var(--text-muted);
  flex-wrap: wrap;
}
.owner { color: var(--text-secondary); }

.running-tag {
  font-family: var(--font-mono);
  font-size: 9px;
  padding: 1px 5px;
  border-radius: var(--border-radius-sm);
  background: var(--accent-glow);
  color: var(--accent-primary);
}
.queued-tag {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: var(--border-radius-sm);
  background: var(--warning-dim);
  color: var(--warning);
}

.cwd {
  font-size: var(--text-xs);
  color: var(--text-muted);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.subject {
  font-size: 11px;
  color: var(--text-dim);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.subject .dim {
  color: var(--accent-primary);
  opacity: 0.6;
  margin-right: 4px;
}

.stats {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: var(--text-xs);
  margin: var(--space-xs) 0 0;
}
.stat {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.stat dt {
  width: 56px;
  text-transform: uppercase;
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--text-dim);
}
.stat dd {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  color: var(--text-secondary);
  margin: 0;
  min-width: 0;
}
.lifetime-bar {
  flex: 1;
  height: 4px;
  background: var(--bg-elevated);
  border-radius: 2px;
  overflow: hidden;
  max-width: 80px;
}
.lifetime-fill {
  display: block;
  height: 100%;
  background: var(--accent-gradient);
  transition: width var(--transition-normal);
}

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

.hint {
  margin: var(--space-xs) 0 0;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-dim);
}
.is-controller.selected .hint { color: var(--memory-preference); }

.dim { color: var(--text-dim); }
</style>
