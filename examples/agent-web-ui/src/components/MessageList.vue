<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import MessageBubble from "./MessageBubble.vue";
import type { Message } from "../stores/chat.ts";

const props = defineProps<{
  messages: Message[];
}>();

defineEmits<{
  (e: "reply", message: Message, answer: string): void;
}>();

const root = ref<HTMLElement | null>(null);

function isAtBottom(): boolean {
  const el = root.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function scrollToBottom(): void {
  const el = root.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

watch(
  () => props.messages.length,
  () => void nextTick(scrollToBottom),
);

watch(
  () => (props.messages.length > 0 ? props.messages[props.messages.length - 1]?.content : ""),
  () => {
    if (isAtBottom()) void nextTick(scrollToBottom);
  },
);
</script>

<template>
  <div ref="root" class="list">
    <div v-if="messages.length === 0" class="empty">
      <p>No messages yet.</p>
      <p class="hint">Type a prompt below to start streaming a response.</p>
    </div>
    <MessageBubble
      v-for="m in messages"
      :key="m.id"
      :message="m"
      @reply="(msg, answer) => $emit('reply', msg, answer)"
    />
  </div>
</template>

<style scoped>
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
}
.hint {
  color: var(--text-dim);
  font-size: var(--text-xs);
  margin-top: var(--space-xs);
}
</style>
