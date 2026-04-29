<script setup lang="ts">
import { computed, ref } from "vue";
import AgentStatusDot from "./AgentStatusDot.vue";
import type { DiscoveredAgentDTO } from "../wire.ts";
import {
  agentsState,
  bucketOf,
  BUCKETS,
  removeAgent,
  type Bucket,
} from "../stores/agents.ts";
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

// Human label for the agent-tag pill. The wire `agent` token (e.g. "cc",
// "claude-code") is short and ambiguous in the UI — map known tokens to
// their full display names. Headless-controller buckets get a hardcoded
// label that names the role rather than the wire token, since "PI" /
// "CC" alone don't tell operators that the card is the controller and
// not a session.
const tagLabel = computed<string>(() => {
  if (bucket.value === BUCKETS.PI_EXEC_CONTROL) return "PI HEADLESS";
  if (bucket.value === BUCKETS.CC_EXEC_CONTROL) return "CC HEADLESS";
  const a = props.agent.agent;
  if (a === "claude-code" || a === "cc" || a === "ccc") return "CLAUDE CODE";
  if (a === "openclaw" || a === "oc") return "OPENCLAW";
  if (a === "pi") return "PI";
  if (a === "hermes") return "HERMES";
  return a.toUpperCase();
});

// Per-bucket agent-tag color, mirroring the old nats-agent-dashboard's
// AgentBadge palette. Only the agent-tag pill tints — no other shape /
// layout changes per family.
const tagColor = computed<string>(() => {
  switch (bucket.value) {
    case BUCKETS.PI_AGENT:
    case BUCKETS.PI_EXEC_SESSION:
      return "var(--bucket-pi)";
    case BUCKETS.CC_AGENT:
    case BUCKETS.CC_EXEC_SESSION:
      return "var(--bucket-cc)";
    case BUCKETS.PI_EXEC_CONTROL:
    case BUCKETS.CC_EXEC_CONTROL:
      return "var(--bucket-headless)";
    case BUCKETS.OPENCLAW:
      return "var(--bucket-openclaw)";
    case BUCKETS.HERMES:
      return "var(--bucket-hermes)";
    default:
      return "var(--bucket-other)";
  }
});

const piSummary = computed(() =>
  isPiSession.value ? piexecState.summaries.get(props.agent.name) : undefined,
);
const ccSummary = computed(() =>
  isCcSession.value ? ccexecState.summaries.get(props.agent.name) : undefined,
);

// Card title (second line). For sessions / regular agents this is
// `session` if present, else the registered service name. Headless
// controllers return null so the title row is omitted entirely — the
// badge already says "PI HEADLESS" / "CC HEADLESS", and the
// wire-internal service name (often "exec" or similar) just adds noise.
const subtitle = computed<string | null>(() => {
  if (
    bucket.value === BUCKETS.PI_EXEC_CONTROL ||
    bucket.value === BUCKETS.CC_EXEC_CONTROL
  ) {
    return null;
  }
  return props.agent.session ?? props.agent.name;
});

const humanPayload = computed(() => {
  const n = props.agent.promptEndpoint.maxPayloadBytes;
  if (!n) return null;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
});

function fmtRemaining(maxS: number, remainingS: number): string {
  if (maxS === 0) return "∞";
  // 0s instead of "expired" so the lifetime row doesn't double-up with
  // the "expired" meta tag. The tag carries the semantic; the lifetime
  // row stays as a plain numeric value to keep card height constant.
  if (remainingS <= 0) return "0s";
  if (remainingS >= 3600)
    return `${Math.floor(remainingS / 3600)}h ${Math.floor((remainingS % 3600) / 60)}m`;
  if (remainingS >= 60) return `${Math.floor(remainingS / 60)}m ${remainingS % 60}s`;
  return `${remainingS}s`;
}

const lifetimeText = computed<string | null>(() => {
  if (!isPiSession.value && !isCcSession.value) return null;
  const s = piSummary.value ?? ccSummary.value;
  // Session card with no summary (controller cleaned it up, or just-stopped
  // before the bridge caught up). Show "0s" so the row stays in the card —
  // the trash button is absolute-positioned and follows the card's bottom
  // edge, so a vanishing row would push it outside.
  if (!s) return "0s";
  return fmtRemaining(s.max_lifetime_s, s.remaining_lifetime_s);
});

const lifetimePercent = computed<number | null>(() => {
  if (!isPiSession.value && !isCcSession.value) return null;
  const s = piSummary.value ?? ccSummary.value;
  // No summary → render an empty bar (100% used). Same idea: keep the row
  // visible and at the same height as a live session.
  if (!s) return 100;
  if (s.max_lifetime_s === 0) return null; // ∞ — no bar
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

const ccCost = computed<string | null>(() => {
  // Only cc-headless sessions have a `cost` row at all; pi sessions don't.
  // For cc cards, always return a string so the row renders even when no
  // prompts have run yet — keeps the cc card height stable across "fresh"
  // (no cost data) and "prompted" (with cost) states.
  if (!isCcSession.value) return null;
  const s = ccSummary.value;
  if (!s || s.total_cost_usd <= 0) return "$0.0000";
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

/**
 * Lifecycle state for a session card. Survives both transition modes:
 *
 *  - `summary present + remaining > 0`     → "alive"   — running normally
 *  - `summary present + remaining <= 0`    → "expired" — controller still
 *      tracks it but the TTL hit zero
 *  - `summary absent`                      → "expired" — controller cleaned
 *      it up, or user clicked stop, but the bridge hasn't yet emitted
 *      `agent-removed` so the agent record is still in the grid
 *
 * Without this, an expired session briefly shows "expired" in the lifetime
 * row, then loses it once the next `list` poll wipes the summary out of
 * the local map — leaving a half-empty zombie card. Tracking the state
 * here keeps the "expired" indicator + trash button consistent through
 * both phases.
 */
const sessionState = computed<"alive" | "expired">(() => {
  if (!isPiSession.value && !isCcSession.value) return "alive";
  const s = piSummary.value ?? ccSummary.value;
  if (!s) return "expired";
  if (s.remaining_lifetime_s <= 0) return "expired";
  return "alive";
});
const isExpired = computed(() => sessionState.value === "expired");

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
    // Optimistic local cleanup: the bridge emits `agent-removed` only when
    // it notices the service vanished from NATS, which can take several
    // seconds. Removing the record here makes the card disappear the
    // instant the controller acks the stop; redundant pushes from the
    // bridge later are no-ops because `removeAgent` is idempotent.
    removeAgent(props.agent.instanceId);
  } catch (e) {
    stopError.value = (e as Error).message;
  } finally {
    stopping.value = false;
  }
}

/**
 * Remove an expired / cleaned-up session card from the grid. Local-only —
 * the controller has already finished with this session, there's nothing
 * to ask it to do. Used as the click handler for the trash icon that
 * replaces ✕ once `sessionState === "expired"`.
 */
function onTrash(): void {
  removeAgent(props.agent.instanceId);
}
</script>

<template>
  <div class="card-wrap" :style="{ '--tag-color': tagColor }">
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
        <span class="agent-tag mono">{{ tagLabel }}</span>
        <AgentStatusDot class="status-led" :instance-id="agent.instanceId" />
      </header>

      <h3 v-if="subtitle" class="card-title">{{ subtitle }}</h3>

      <div class="meta">
        <span class="owner mono">@{{ agent.owner }}</span>
        <span v-if="isExpired" class="expired-tag mono">expired</span>
        <span v-else-if="running" class="running-tag">running</span>
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
      :class="{ 'is-trash': isExpired }"
      :disabled="!isExpired && (stopping || !parentController)"
      :title="
        stopError
          ? `stop failed: ${stopError}`
          : isExpired
            ? 'remove from list'
            : !parentController
              ? 'no controller online — cannot stop from UI'
              : 'stop session'
      "
      @click.stop="isExpired ? onTrash() : onStop()"
    >
      <!-- ✕ when alive (stop the running session via the controller).
           🗑 when expired/cleaned-up (remove the lingering local card). -->
      <svg
        v-if="isExpired"
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
      <span v-else aria-hidden="true">×</span>
    </button>
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
.stop-btn .icon {
  /* SVG trash icon shown when sessionState === 'expired'. Sized to match
     the ✕ glyph (~12px optical size) and tinted via currentColor. */
  width: 11px;
  height: 11px;
  display: block;
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
  /* Default border = a faint wash of the per-bucket tag colour. This
     ties each card's outline to its agent family without competing with
     the selection accent — selected cards still take over with
     `--accent-primary` below. */
  border: 1px solid color-mix(in srgb, var(--tag-color, var(--text-muted)) 22%, transparent);
  border-radius: var(--border-radius);
  text-align: left;
  transition: all var(--transition-normal);
  cursor: pointer;
  width: 100%;
  overflow: hidden;
}
.card:hover {
  background: var(--bg-tertiary);
  border-color: color-mix(in srgb, var(--tag-color, var(--text-muted)) 45%, transparent);
  transform: translateY(-1px);
}
.card.selected {
  border-color: var(--accent-primary);
  background: linear-gradient(135deg, var(--bg-tertiary), var(--bg-secondary));
  box-shadow: var(--shadow-glow);
}
.card.is-controller {
  /* Controllers keep their distinctive violet vertical wash — the
     border is already violet-tinted via `--tag-color = --bucket-headless`,
     so we don't override it here. */
  background: linear-gradient(
    180deg,
    var(--bg-secondary) 0%,
    rgba(167, 139, 250, 0.05) 100%
  );
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
  /* `--tag-color` is set per-card on `.card-wrap` (see script). The
     fallback keeps the pill legible if a future bucket forgets to map
     a colour. `color-mix()` produces a soft tinted background that
     reads cleanly on the dark theme. */
  color: var(--tag-color, var(--accent-primary));
  background: color-mix(in srgb, var(--tag-color, var(--accent-primary)) 14%, transparent);
  padding: 1px 6px;
  border-radius: var(--border-radius-sm);
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
.expired-tag {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: var(--border-radius-sm);
  background: var(--error-dim);
  color: var(--error);
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
