<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import MessageBubble from "./MessageBubble.vue";
import PromptArea from "./PromptArea.vue";
import { fileToAttachment, useBridge } from "../composables/useBridge.ts";
import { startVirtualTurn } from "../composables/virtualPromptStreaming.ts";
import { agentsState } from "../stores/agents.ts";
import { getSession } from "../stores/chat.ts";
import {
  activePromptIdsOf,
  isVirtualSessionActive,
  type VirtualSession,
} from "../stores/virtualSessions.ts";

const props = defineProps<{ session: VirtualSession }>();

const bridge = useBridge();
const error = ref<string | null>(null);
const lastReport = ref<{ ok: number; busy: number; offline: number } | null>(null);
let reportTimer: ReturnType<typeof setTimeout> | null = null;

const messages = computed(() => props.session.messages);

const targetCount = computed(() => props.session.targets.length);

const onlineTargets = computed(() =>
  props.session.targets.filter((id) =>
    agentsState.list.some((a) => a.instanceId === id),
  ),
);

const sendableTargets = computed(() =>
  onlineTargets.value.filter(
    (id) => getSession(id).activePromptId === null,
  ),
);

const sendableCount = computed(() => sendableTargets.value.length);

// Busy here = at least one of the locked targets is mid-prompt for this
// virtual session; the Stop button cancels every per-source stream of any
// active turn.
const busy = computed(() => isVirtualSessionActive(props.session.id));

// Auto-scroll: the message list itself manages its scroll position; we
// just need to nudge it after each new bubble.
const listRef = ref<HTMLElement | null>(null);
function scrollToBottom(): void {
  const el = listRef.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}
watch(
  () => messages.value.length,
  () => void nextTick(scrollToBottom),
);
watch(
  () =>
    messages.value.length > 0
      ? messages.value[messages.value.length - 1]?.content
      : "",
  () => {
    const el = listRef.value;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      void nextTick(scrollToBottom);
    }
  },
);

// Per-bubble source-header rule: render a header before any sourced
// bubble whose previous sibling has a different source (or none).
// Avoids repeating "@derek · CLAUDE-CODE" before every consecutive
// agent / tool bubble from the same source.
function showSourceHeader(i: number): boolean {
  const m = messages.value[i];
  if (!m || !m.sourceInstanceId) return false;
  const prev = messages.value[i - 1];
  if (!prev) return true;
  return prev.sourceInstanceId !== m.sourceInstanceId;
}

async function onSubmit(text: string, files: File[]): Promise<void> {
  let attachments: Awaited<ReturnType<typeof fileToAttachment>>[] | undefined;
  if (files.length > 0) {
    try {
      attachments = await Promise.all(files.map(fileToAttachment));
    } catch (e) {
      error.value = `failed to read file: ${(e as Error).message}`;
      return;
    }
  }
  error.value = null;
  const report = startVirtualTurn(props.session.id, text, attachments);
  if (reportTimer !== null) clearTimeout(reportTimer);
  lastReport.value = { ok: report.ok, busy: report.busy, offline: report.offline };
  reportTimer = setTimeout(() => {
    lastReport.value = null;
    reportTimer = null;
  }, 5_000);
}

function onStop(): void {
  for (const promptId of activePromptIdsOf(props.session.id)) {
    bridge.cancel(promptId);
  }
}

// Clear the inline-report timer if the user navigates away mid-countdown
// (e.g. opens a different session or deletes this one) — otherwise the
// callback fires into an orphaned ref and emits an unhandled warning.
onUnmounted(() => {
  if (reportTimer !== null) clearTimeout(reportTimer);
});
</script>

<template>
  <section class="chat-pane">
    <header class="chat-head">
      <div class="chat-title">
        <span class="chat-tag mono">VIRTUAL</span>
        <span class="chat-name">{{ session.label }}</span>
      </div>
      <div class="chat-sub mono">
        Fans out to {{ onlineTargets.length }} of {{ targetCount }} target{{ targetCount === 1 ? "" : "s" }}
        <template v-if="lastReport">
          · last send: {{ lastReport.ok }}<template v-if="lastReport.busy + lastReport.offline > 0">
            ({{ lastReport.busy }} busy, {{ lastReport.offline }} offline)</template>
        </template>
      </div>
    </header>

    <div v-if="error" class="error mono">{{ error }}</div>

    <div ref="listRef" class="list">
      <div v-if="messages.length === 0" class="empty">
        <p>No messages yet.</p>
        <p class="hint">
          Type a prompt below — it will fan out to all {{ targetCount }} target{{ targetCount === 1 ? "" : "s" }} and
          stream every response into this transcript.
        </p>
      </div>
      <template v-for="(m, i) in messages" :key="m.id">
        <div v-if="showSourceHeader(i)" class="source-header">
          <span class="source-label mono">{{ m.sourceLabel }}</span>
        </div>
        <MessageBubble :message="m" />
      </template>
    </div>

    <PromptArea
      :busy="busy"
      :disabled="sendableCount === 0 && !busy"
      :attachments-ok="true"
      @submit="onSubmit"
      @stop="onStop"
    />
  </section>
</template>

<style scoped>
.chat-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--bg-deep);
}
.chat-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-md) var(--space-lg);
  background: var(--bg-primary);
  border-bottom: var(--border-subtle);
  flex-shrink: 0;
}
.chat-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
}
.chat-tag {
  font-size: var(--text-xs);
  color: var(--bucket-virtual);
  background: color-mix(in srgb, var(--bucket-virtual) 14%, transparent);
  padding: 1px 6px;
  border-radius: var(--border-radius-sm);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.chat-name {
  color: var(--text-primary);
  font-weight: 600;
}
.chat-sub {
  color: var(--text-dim);
  font-size: var(--text-xs);
}
.error {
  padding: var(--space-sm) var(--space-lg);
  font-size: var(--text-xs);
  color: var(--error);
  background: var(--error-dim);
  border-bottom: 1px solid rgba(248, 113, 113, 0.3);
}

.list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-lg);
  overflow-y: auto;
  background: var(--bg-deep);
}
.empty {
  margin: auto;
  text-align: center;
  color: var(--text-muted);
  font-size: var(--text-sm);
  max-width: 420px;
}
.hint {
  color: var(--text-dim);
  font-size: var(--text-xs);
  margin-top: var(--space-xs);
  line-height: var(--leading-relaxed);
}

/* Per-source headers split the linear transcript into one labelled block
   per agent per turn. The label is the only visual marker that bubbles
   below it came from a specific source (ToolBubble + AgentBubble can
   both follow without a repeated header). */
.source-header {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin: var(--space-md) 0 calc(var(--space-md) * -1 + var(--space-xs));
  padding: 0 var(--space-xs);
}
.source-header::before,
.source-header::after {
  content: "";
  flex: 1;
  height: 1px;
  background: color-mix(in srgb, var(--bucket-virtual) 18%, transparent);
}
.source-label {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--bucket-virtual);
  padding: 2px 8px;
  border-radius: var(--border-radius-sm);
  background: color-mix(in srgb, var(--bucket-virtual) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--bucket-virtual) 20%, transparent);
}
</style>
