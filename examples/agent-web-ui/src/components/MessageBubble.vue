<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useMarkdown } from "../composables/useMarkdown.ts";
import type { Message } from "../stores/chat.ts";

const props = defineProps<{ message: Message }>();
const emit = defineEmits<{
  (e: "reply", message: Message, answer: string): void;
}>();

const { renderMarkdown } = useMarkdown();

const bubbleRef = ref<HTMLElement | null>(null);

const isUser = computed(() => props.message.role === "user");
const isAgent = computed(() => props.message.role === "agent");
const isQuery = computed(() => props.message.role === "query");
const isTool = computed(() => props.message.role === "tool");

const toolInputJson = computed(() => {
  const t = props.message.tool;
  if (!t) return "";
  try {
    return JSON.stringify(t.input, null, 2);
  } catch {
    return String(t.input);
  }
});

const toolStatusGlyph = computed(() => {
  const t = props.message.tool;
  if (!t) return "";
  if (t.isError) return "✗";
  if (t.result !== undefined) return "✓";
  return "…";
});

const formattedCost = computed(() => {
  const c = props.message.costUsd;
  if (c === undefined || c === null) return "";
  if (c < 0.0001) return "<$0.0001";
  return `$${c.toFixed(4)}`;
});

const freeText = ref("");

function sendReply(answer: string): void {
  if (props.message.replied) return;
  if (!answer) return;
  emit("reply", props.message, answer);
}

function sendFreeText(): void {
  const v = freeText.value.trim();
  if (!v) return;
  sendReply(v);
  freeText.value = "";
}

function onFreeTextKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    sendFreeText();
  }
}

const rendered = computed(() => renderMarkdown(props.message.content));
const showCursor = computed(() => isAgent.value && props.message.streaming);

const time = computed(() => {
  if (!props.message.timestamp) return "";
  return new Date(props.message.timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
});

function handleClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const btn = target?.closest?.(".md-code-copy") as HTMLButtonElement | null;
  if (!btn) return;
  event.stopPropagation();
  const encoded = btn.dataset["code"] ?? "";
  const code = decodeURIComponent(encoded);
  void navigator.clipboard.writeText(code).then(() => {
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("copied");
    }, 1500);
  });
}

onMounted(() => bubbleRef.value?.addEventListener("click", handleClick));
onBeforeUnmount(() => bubbleRef.value?.removeEventListener("click", handleClick));
</script>

<template>
  <div
    ref="bubbleRef"
    class="bubble"
    :class="{
      user: isUser,
      agent: isAgent,
      query: isQuery,
      tool: isTool,
      'tool-error': isTool && message.tool?.isError,
      streaming: message.streaming,
      errored: !!message.error,
    }"
  >
    <header v-if="isAgent" class="bubble-header">
      <span class="role">agent</span>
      <span v-if="message.streaming && !message.content" class="thinking">
        <span /><span /><span />
      </span>
      <span class="time mono">{{ time }}</span>
    </header>

    <header v-if="isQuery" class="bubble-header">
      <span class="role">agent asks</span>
      <span class="time mono">{{ time }}</span>
    </header>

    <div v-if="isTool && message.tool" class="tool-card">
      <header class="tool-header">
        <span class="tool-glyph mono">{{ toolStatusGlyph }}</span>
        <span class="tool-name mono">{{ message.tool.name }}</span>
        <span class="time mono">{{ time }}</span>
      </header>
      <details class="tool-section" open>
        <summary class="tool-summary mono">input</summary>
        <pre class="tool-pre mono">{{ toolInputJson }}</pre>
      </details>
      <details v-if="message.tool.result !== undefined" class="tool-section" :open="message.tool.isError">
        <summary class="tool-summary mono">{{ message.tool.isError ? "result (error)" : "result" }}</summary>
        <pre class="tool-pre mono">{{ message.tool.result }}</pre>
      </details>
      <div v-else class="tool-pending mono">running…</div>
    </div>

    <div v-if="isUser && message.attachments && message.attachments.length" class="attachments">
      <span v-for="a in message.attachments" :key="a.filename" class="attachment mono">📎 {{ a.filename }}</span>
    </div>

    <div
      v-if="message.content"
      class="content markdown-content"
      v-html="rendered"
    />

    <span v-if="showCursor && message.content" class="cursor">▍</span>

    <div v-if="isQuery" class="query-reply">
      <template v-if="message.replied">
        <div class="query-replied mono">replied: {{ message.replyValue }}</div>
      </template>
      <template v-else>
        <div class="query-buttons">
          <button type="button" class="btn-allow" @click="sendReply('yes')">Allow (yes)</button>
          <button type="button" class="btn-deny" @click="sendReply('no')">Deny (no)</button>
        </div>
        <div class="query-free">
          <textarea
            v-model="freeText"
            rows="1"
            placeholder="…or type a reply (Enter to send, Shift+Enter for newline)"
            class="query-input"
            @keydown="onFreeTextKeydown"
          />
          <button type="button" class="btn-send" :disabled="!freeText.trim()" @click="sendFreeText">Send</button>
        </div>
      </template>
    </div>

    <footer v-if="message.statusNote" class="status-note mono">{{ message.statusNote }}</footer>
    <footer v-if="formattedCost" class="cost-note mono">cost: {{ formattedCost }}</footer>
    <footer v-if="message.error" class="error mono">{{ message.error }}</footer>

    <footer v-if="isUser" class="user-time">
      <span class="time mono">{{ time }}</span>
    </footer>
  </div>
</template>

<style scoped>
.bubble {
  max-width: 92%;
  padding: var(--space-md) var(--space-lg);
  border-radius: var(--border-radius-lg);
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  animation: slideUp var(--transition-slow) ease;
}
.bubble.user {
  align-self: flex-end;
  background: var(--accent-primary);
  color: white;
  border-bottom-right-radius: var(--border-radius-sm);
  max-width: 80%;
}
.bubble.user .content { color: white; }
.bubble.agent {
  align-self: flex-start;
  background: var(--bg-secondary);
  border: var(--border-subtle);
  border-bottom-left-radius: var(--border-radius-sm);
}
.bubble.errored { border-color: var(--error); }

.bubble.query {
  align-self: stretch;
  max-width: 92%;
  background: var(--accent-glow);
  border: 1px solid var(--accent-primary);
  border-radius: var(--border-radius-lg);
}

.bubble.tool {
  align-self: flex-start;
  max-width: 92%;
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-primary);
  border: var(--border-subtle);
  border-radius: var(--border-radius);
}
.bubble.tool-error {
  border-color: var(--error);
}

.tool-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}
.tool-header {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-size: var(--text-xs);
  color: var(--text-secondary);
}
.tool-glyph {
  font-weight: 700;
  color: var(--accent-primary);
}
.bubble.tool-error .tool-glyph { color: var(--error); }
.tool-name {
  font-weight: 600;
  color: var(--text-primary);
}
.tool-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tool-summary {
  font-size: 10px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  cursor: pointer;
  user-select: none;
}
.tool-summary:hover { color: var(--text-secondary); }
.tool-pre {
  margin: 2px 0 0 0;
  padding: 6px 8px;
  background: var(--bg-deep);
  border: var(--border-subtle);
  border-radius: var(--border-radius-sm);
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-secondary);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}
.tool-pending {
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-style: italic;
}

.query-reply {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  margin-top: var(--space-sm);
}
.query-buttons {
  display: flex;
  gap: var(--space-sm);
}
.query-buttons button {
  flex: 0 0 auto;
  padding: 6px 14px;
  font-size: var(--text-sm);
  font-weight: 600;
  border-radius: var(--border-radius-sm);
  border: 1px solid transparent;
  cursor: pointer;
}
.btn-allow {
  background: #16a34a;
  color: white;
}
.btn-allow:hover { background: #15803d; }
.btn-deny {
  background: transparent;
  color: var(--error);
  border-color: var(--error);
}
.btn-deny:hover { background: rgba(248, 113, 113, 0.12); }
.query-free {
  display: flex;
  gap: var(--space-sm);
  align-items: stretch;
}
.query-input {
  flex: 1;
  min-height: 32px;
  resize: vertical;
  padding: 6px 8px;
  font-size: var(--text-sm);
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-primary);
  border: var(--border-subtle);
  border-radius: var(--border-radius-sm);
}
.btn-send {
  padding: 6px 14px;
  font-size: var(--text-sm);
  font-weight: 600;
  background: var(--accent-primary);
  color: white;
  border: none;
  border-radius: var(--border-radius-sm);
  cursor: pointer;
}
.btn-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.query-replied {
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-style: italic;
}

.bubble-header {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-dim);
  font-family: var(--font-mono);
}
.role { font-weight: 600; }
.time { margin-left: auto; color: var(--text-dim); font-size: 10px; }

.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.attachment {
  font-size: var(--text-xs);
  background: rgba(255, 255, 255, 0.18);
  color: white;
  padding: 2px 8px;
  border-radius: var(--border-radius-sm);
}

.thinking { display: inline-flex; gap: 3px; align-items: center; }
.thinking span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent-primary);
  animation: thinkpulse 1.4s ease-in-out infinite;
}
.thinking span:nth-child(2) { animation-delay: 0.15s; }
.thinking span:nth-child(3) { animation-delay: 0.3s; }
@keyframes thinkpulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.7); }
  40% { opacity: 1; transform: scale(1); }
}

.content {
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--text-primary);
  word-wrap: break-word;
}
.bubble.user .content { color: white; }

.cursor {
  display: inline-block;
  margin-left: 1px;
  color: var(--accent-primary);
  animation: blink 0.8s infinite;
  font-weight: 600;
}
.bubble.user .cursor { color: rgba(255,255,255,0.8); }
@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

.status-note {
  font-size: var(--text-xs);
  color: var(--text-muted);
  font-style: italic;
}
.cost-note {
  font-size: 10px;
  color: var(--text-dim);
  letter-spacing: 0.04em;
}
.error {
  font-size: var(--text-xs);
  color: var(--error);
  padding-top: var(--space-xs);
  border-top: 1px solid rgba(248, 113, 113, 0.3);
  word-break: break-word;
}
.user-time {
  display: flex;
  justify-content: flex-end;
}
.bubble.user .time { color: rgba(255, 255, 255, 0.7); }
</style>
