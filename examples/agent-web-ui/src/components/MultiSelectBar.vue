<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import AttachmentChips from "./AttachmentChips.vue";
import { agentsState, selectAgent } from "../stores/agents.ts";
import { clearSelection, selectionState } from "../stores/selection.ts";
import { getSession } from "../stores/chat.ts";
import { fileToAttachment } from "../composables/useBridge.ts";
import { startPromptStream } from "../composables/promptStreaming.ts";
import { startVirtualTurn } from "../composables/virtualPromptStreaming.ts";
import { createVirtualSession } from "../stores/virtualSessions.ts";

const text = ref("");
const files = ref<File[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);
const sending = ref(false);
const virtualMode = ref(false);

// "Last send report" — sticky inline near the Send button so the user can
// see how many fired vs. how many were skipped (busy). Cleared on next send
// or 5s after the last send finishes.
const lastReport = ref<{ ok: number; busy: number } | null>(null);
let reportTimer: ReturnType<typeof setTimeout> | null = null;

const selectedAgents = computed(() =>
  agentsState.list.filter((a) => selectionState.ids.has(a.instanceId)),
);

const selectedCount = computed(() => selectedAgents.value.length);

const busyCount = computed(() => {
  let n = 0;
  for (const a of selectedAgents.value) {
    if (getSession(a.instanceId).activePromptId !== null) n++;
  }
  return n;
});

const sendableCount = computed(() => selectedCount.value - busyCount.value);

// In plain fan-out mode we need at least one non-busy target. In virtual
// mode the selection is locked into the new session and busy targets
// just get a "(busy — skipped)" placeholder — the user can retry later
// from inside the virtual chat — so we allow Send as long as something
// is selected.
const canSend = computed(() => {
  if (sending.value || text.value.trim().length === 0) return false;
  if (virtualMode.value) return selectedCount.value > 0;
  return sendableCount.value > 0;
});

function autoResize(): void {
  const el = textarea.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

watch(text, () => void nextTick(autoResize));

function onKey(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

function pickFiles(): void {
  fileInput.value?.click();
}

function onFiles(e: Event): void {
  const input = e.target as HTMLInputElement;
  if (!input.files) return;
  files.value = [...files.value, ...Array.from(input.files)];
  input.value = "";
}

function removeFile(i: number): void {
  files.value = files.value.filter((_, j) => j !== i);
}

const fileError = ref<string | null>(null);

async function send(): Promise<void> {
  const t = text.value.trim();
  if (!t || sending.value) return;

  sending.value = true;
  fileError.value = null;

  let attachments: Awaited<ReturnType<typeof fileToAttachment>>[] | undefined;
  if (files.value.length > 0) {
    try {
      attachments = await Promise.all(files.value.map(fileToAttachment));
    } catch (e) {
      fileError.value = `failed to read file: ${(e as Error).message}`;
      sending.value = false;
      return;
    }
  }

  // Snapshot the targets at send time so a card removed mid-loop doesn't
  // shift indices, and so the inline report counts what we attempted.
  let okN = 0;
  let busyN = 0;

  if (virtualMode.value) {
    // Phase 2: spin up a virtual session locked to the current selection,
    // route the right panel to it, and let the virtual transcript host
    // every future prompt against this same target list. The first turn
    // also fires immediately so the user sees streaming responses without
    // a second click.
    const targetIds = selectedAgents.value.map((a) => a.instanceId);
    const virtualId = createVirtualSession(targetIds);
    const report = startVirtualTurn(virtualId, t, attachments);
    okN = report.ok;
    busyN = report.busy;
    selectAgent(virtualId);
    // Drop the multi-selection — the virtual session is now the surface
    // for further prompting against this group.
    clearSelection();
    // Reset the toggle so the next selection starts in plain fan-out mode.
    virtualMode.value = false;
  } else {
    for (const agent of selectedAgents.value) {
      if (getSession(agent.instanceId).activePromptId !== null) {
        busyN++;
        continue;
      }
      startPromptStream(agent, t, attachments);
      okN++;
    }
  }

  if (reportTimer !== null) clearTimeout(reportTimer);
  lastReport.value = { ok: okN, busy: busyN };
  reportTimer = setTimeout(() => {
    lastReport.value = null;
    reportTimer = null;
  }, 5_000);

  text.value = "";
  files.value = [];
  sending.value = false;
}

// Esc clears multi-selection. Close-on-Esc is a stronger expectation than
// "Esc clears textarea content first" — if the user has unsent text, they
// can copy it out before pressing Esc.
function onDocKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && selectionState.ids.size > 0) {
    clearSelection();
  }
}

onMounted(() => {
  document.addEventListener("keydown", onDocKey);
});
onUnmounted(() => {
  document.removeEventListener("keydown", onDocKey);
  if (reportTimer !== null) clearTimeout(reportTimer);
});
</script>

<template>
  <div class="bar" role="region" aria-label="Multi-select prompt">
    <div class="bar-head">
      <span class="count mono">
        <strong>{{ selectedCount }}</strong> selected
        <span v-if="busyCount > 0" class="busy-hint mono">
          · {{ busyCount }} busy
        </span>
      </span>

      <span v-if="lastReport" class="report mono">
        Sent to {{ lastReport.ok }} of {{ lastReport.ok + lastReport.busy }}<template
          v-if="lastReport.busy > 0"> ({{ lastReport.busy }} busy)</template>
      </span>

      <span class="bar-spacer" />

      <!-- When ticked, Send creates a new persistent virtual session
           locked to the current selection, fires the first turn against
           every target, and switches the right panel to the aggregate
           transcript. The virtual session keeps the same target list
           for every subsequent prompt typed into it. -->
      <label
        class="virtual-toggle mono"
        :class="{ active: virtualMode }"
        title="Create a new virtual session that fans every future prompt out to these N agents"
      >
        <input type="checkbox" v-model="virtualMode" />
        <span>Stream all to a virtual session</span>
      </label>

      <button
        type="button"
        class="clear-btn"
        title="Clear selection (Esc)"
        @click="clearSelection"
      >×</button>
    </div>

    <div v-if="files.length" class="chips-row">
      <AttachmentChips :files="files" @remove="removeFile" />
    </div>
    <div v-if="fileError" class="warn mono">{{ fileError }}</div>

    <div class="row">
      <button
        type="button"
        class="attach-btn"
        title="Attach files"
        @click="pickFiles"
      >📎</button>
      <input
        ref="fileInput"
        type="file"
        multiple
        style="display: none"
        @change="onFiles"
      />

      <textarea
        ref="textarea"
        v-model="text"
        class="textarea"
        rows="1"
        :placeholder="
          virtualMode
            ? `Type a prompt — creates a virtual session of ${selectedCount} agent${selectedCount === 1 ? '' : 's'}`
            : sendableCount === 0
              ? 'All selected agents are busy — wait for them to finish or pick others'
              : `Type a prompt — Enter to send to ${sendableCount} agent${sendableCount === 1 ? '' : 's'}`
        "
        @keydown="onKey"
      />

      <button
        type="button"
        class="btn send"
        :class="{ 'is-virtual': virtualMode }"
        :disabled="!canSend"
        @click="send"
      >
        <template v-if="virtualMode">Create virtual + send</template>
        <template v-else>Send to {{ sendableCount }}</template>
      </button>
    </div>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  padding: var(--space-sm) var(--space-md) var(--space-md);
  background: var(--bg-secondary);
  border-top: 1px solid color-mix(in srgb, var(--accent-primary) 35%, transparent);
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.35);
  flex-shrink: 0;
  /* Faint top accent to mark the bar as a layered overlay rather than a
     pane edge. The sibling `.grid-body` shrinks when this appears, which
     is the visible "make room for the bar" behaviour the user expects. */
}

.bar-head {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  font-size: var(--text-xs);
}
.count {
  color: var(--text-secondary);
  background: var(--accent-glow);
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--accent-primary) 35%, transparent);
}
.count strong {
  color: var(--accent-primary);
  font-weight: 700;
}
.busy-hint { color: var(--warning); }
.report {
  color: var(--text-muted);
  font-size: 11px;
}
.bar-spacer { flex: 1; }

.virtual-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  user-select: none;
  padding: 3px 8px;
  border-radius: var(--border-radius-sm);
  border: 1px solid transparent;
  transition: all var(--transition-fast);
}
.virtual-toggle:hover {
  color: var(--text-secondary);
}
.virtual-toggle.active {
  color: var(--bucket-virtual);
  background: color-mix(in srgb, var(--bucket-virtual) 10%, transparent);
  border-color: color-mix(in srgb, var(--bucket-virtual) 35%, transparent);
}
.virtual-toggle input { cursor: pointer; accent-color: var(--bucket-virtual); }

.clear-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 50%;
  background: transparent;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  transition: all var(--transition-fast);
}
.clear-btn:hover {
  color: var(--error);
  border-color: var(--error);
  background: var(--error-dim);
}

.chips-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-sm);
}

.warn {
  font-size: var(--text-xs);
  color: var(--error);
  background: var(--error-dim);
  padding: 4px 8px;
  border-radius: var(--border-radius-sm);
}

.row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-sm);
}

.textarea {
  flex: 1;
  min-height: 38px;
  max-height: 200px;
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-primary);
  border: var(--border-subtle);
  border-radius: var(--border-radius);
  font-family: inherit;
  font-size: var(--text-sm);
  color: var(--text-primary);
  resize: none;
  line-height: var(--leading-normal);
  overflow-y: auto;
}
.textarea:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

.attach-btn {
  height: 38px;
  width: 38px;
  border: var(--border-subtle);
  background: var(--bg-primary);
  border-radius: var(--border-radius);
  color: var(--text-secondary);
  transition: all var(--transition-fast);
  font-size: 1.1em;
  cursor: pointer;
}
.attach-btn:hover {
  color: var(--accent-primary);
  border-color: var(--accent-primary);
}

.btn {
  height: 38px;
  padding: 0 var(--space-lg);
  border-radius: var(--border-radius);
  font-size: var(--text-sm);
  font-weight: 600;
  transition: all var(--transition-fast);
  cursor: pointer;
}
.btn.send {
  background: var(--accent-gradient);
  color: white;
  border: none;
}
.btn.send:hover:not(:disabled) { filter: brightness(1.1); }
.btn.send:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.send.is-virtual {
  background: linear-gradient(135deg, var(--bucket-virtual), #c026d3);
}
</style>
