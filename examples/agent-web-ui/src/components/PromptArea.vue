<script setup lang="ts">
import { ref, watch, nextTick, computed } from "vue";
import AttachmentChips from "./AttachmentChips.vue";

const props = defineProps<{
  busy: boolean;
  disabled: boolean;
  attachmentsOk: boolean;
  maxPayloadBytes?: number | undefined;
}>();

const emit = defineEmits<{
  submit: [text: string, files: File[]];
  stop: [];
}>();

const text = ref("");
const files = ref<File[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);

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
    void submit();
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

function submit(): void {
  const t = text.value.trim();
  if (!t || props.busy || props.disabled) return;
  emit("submit", t, [...files.value]);
  text.value = "";
  files.value = [];
  void nextTick(autoResize);
}

function stop(): void {
  emit("stop");
}

const payloadHint = computed(() => {
  if (!files.value.length) return null;
  const total = files.value.reduce((acc, f) => acc + f.size, 0);
  // rough overhead for base64 + JSON envelope
  const est = Math.ceil(total * 1.37) + 256;
  if (est >= 1024 * 1024) return `~${(est / (1024 * 1024)).toFixed(2)} MB`;
  if (est >= 1024) return `~${(est / 1024).toFixed(1)} KB`;
  return `~${est} B`;
});

const overLimit = computed(() => {
  if (!props.maxPayloadBytes || !files.value.length) return false;
  const total = files.value.reduce((acc, f) => acc + f.size, 0);
  return Math.ceil(total * 1.37) + 256 > props.maxPayloadBytes;
});
</script>

<template>
  <div class="wrap" :class="{ disabled }">
    <div v-if="files.length" class="chips-row">
      <AttachmentChips :files="files" @remove="removeFile" />
      <span
        v-if="payloadHint"
        class="payload-hint mono"
        :class="{ 'over-limit': overLimit }"
      >
        envelope {{ payloadHint }}
        <template v-if="overLimit"> — exceeds agent's max_payload</template>
      </span>
    </div>

    <div v-if="files.length > 0 && !attachmentsOk" class="warn mono">
      agent declared attachments_ok = false; send will be rejected locally by the SDK
    </div>

    <div class="row">
      <button
        type="button"
        class="attach-btn"
        :disabled="disabled || !attachmentsOk"
        :title="attachmentsOk ? 'Attach files' : 'Agent does not accept attachments'"
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
        :placeholder="disabled ? 'Select an agent to start prompting...' : 'Type a prompt — Enter to send'"
        :disabled="disabled"
        @keydown="onKey"
      />

      <button
        v-if="busy"
        type="button"
        class="btn stop"
        @click="stop"
      >Stop</button>
      <button
        v-else
        type="button"
        class="btn send"
        :disabled="!text.trim() || disabled"
        @click="submit"
      >Send</button>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  padding: var(--space-md);
  background: var(--bg-secondary);
  border-top: var(--border-subtle);
  flex-shrink: 0;
}
.wrap.disabled { opacity: 0.7; }

.chips-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-sm);
}
.payload-hint {
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.payload-hint.over-limit { color: var(--error); }

.warn {
  font-size: var(--text-xs);
  color: var(--warning);
  background: var(--warning-dim);
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
.textarea:disabled { opacity: 0.6; cursor: not-allowed; }

.attach-btn {
  height: 38px;
  width: 38px;
  border: var(--border-subtle);
  background: var(--bg-primary);
  border-radius: var(--border-radius);
  color: var(--text-secondary);
  transition: all var(--transition-fast);
  font-size: 1.1em;
}
.attach-btn:hover:not(:disabled) {
  color: var(--accent-primary);
  border-color: var(--accent-primary);
}
.attach-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.btn {
  height: 38px;
  padding: 0 var(--space-lg);
  border-radius: var(--border-radius);
  font-size: var(--text-sm);
  font-weight: 600;
  transition: all var(--transition-fast);
}
.btn.send {
  background: var(--accent-gradient);
  color: white;
  border: none;
}
.btn.send:hover:not(:disabled) { filter: brightness(1.1); }
.btn.send:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.stop {
  background: var(--error-dim);
  color: var(--error);
  border: 1px solid var(--error);
}
.btn.stop:hover { background: var(--error); color: white; }
</style>
