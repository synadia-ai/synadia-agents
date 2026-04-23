<script setup lang="ts">
import { ref, computed } from "vue";
import { useBridge } from "../../composables/useBridge.ts";
import {
  onSpawned,
  piexecState,
  selectedController,
} from "../../stores/piexec.ts";
import type { PiExecSpawnDescriptor, PiExecSpawnSpec } from "../../wire.ts";

const emit = defineEmits<{
  spawned: [descriptor: PiExecSpawnDescriptor];
}>();

const bridge = useBridge();

const cwd = ref("");
const model = ref("");
const thinkingLevel = ref("");
const maxLifetime = ref("1800");
const sessionId = ref("");
const submitting = ref(false);

const disabled = computed(() => !selectedController.value);

const thinkingOptions = ["", "off", "minimal", "low", "medium", "high", "xhigh"];

async function onSubmit(e: Event): Promise<void> {
  e.preventDefault();
  if (disabled.value || submitting.value) return;
  const controller = selectedController.value!;

  const spec: PiExecSpawnSpec = { cwd: cwd.value.trim() };
  if (!spec.cwd) {
    piexecState.lastError = "cwd is required";
    return;
  }
  if (sessionId.value.trim()) spec.session_id = sessionId.value.trim();
  if (model.value.trim()) spec.model = model.value.trim();
  if (thinkingLevel.value) spec.thinking_level = thinkingLevel.value;
  const lifetime = Number(maxLifetime.value);
  if (Number.isFinite(lifetime) && lifetime >= 0) spec.max_lifetime_s = lifetime;

  submitting.value = true;
  piexecState.lastError = null;
  try {
    const descriptor = await bridge.piexecSpawn(controller.instanceId, spec);
    onSpawned(descriptor);
    emit("spawned", descriptor);
    // Reset just the dynamic fields; keep model / thinking / lifetime for next spawn.
    cwd.value = "";
    sessionId.value = "";
  } catch (err) {
    piexecState.lastError = `spawn failed: ${(err as Error).message}`;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form class="form" @submit="onSubmit">
    <h3 class="heading">Spawn session</h3>

    <label class="field">
      <span class="label mono">cwd *</span>
      <input v-model="cwd" class="input mono" placeholder="/abs/path" :disabled="disabled" />
    </label>

    <label class="field">
      <span class="label mono">session id</span>
      <input v-model="sessionId" class="input mono" placeholder="(auto-generated)" :disabled="disabled" />
    </label>

    <label class="field">
      <span class="label mono">model</span>
      <input
        v-model="model"
        class="input mono"
        placeholder="(controller default, e.g. anthropic/claude-sonnet-4-5)"
        :disabled="disabled"
      />
    </label>

    <label class="field">
      <span class="label mono">thinking level</span>
      <select v-model="thinkingLevel" class="input mono" :disabled="disabled">
        <option v-for="opt in thinkingOptions" :key="opt" :value="opt">
          {{ opt === "" ? "(default)" : opt }}
        </option>
      </select>
    </label>

    <label class="field">
      <span class="label mono">max lifetime (s)</span>
      <input
        v-model="maxLifetime"
        class="input mono"
        type="number"
        min="0"
        :disabled="disabled"
      />
    </label>

    <div class="footer">
      <span v-if="piexecState.lastError" class="error mono">{{ piexecState.lastError }}</span>
      <button
        type="submit"
        class="btn"
        :disabled="disabled || submitting || !cwd.trim()"
      >
        {{ submitting ? "spawning..." : "Spawn" }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  padding: var(--space-md);
  background: var(--bg-secondary);
  border: var(--border-subtle);
  border-radius: var(--border-radius);
}
.heading {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-dim);
  font-family: var(--font-mono);
  margin-bottom: var(--space-xs);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.label {
  font-size: var(--text-xs);
  color: var(--text-muted);
}
.input {
  height: 32px;
  padding: 0 var(--space-sm);
  background: var(--bg-primary);
  border: var(--border-subtle);
  border-radius: var(--border-radius);
  color: var(--text-primary);
  font-size: var(--text-xs);
}
.input:focus {
  outline: none;
  border-color: var(--accent-primary);
}
.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  margin-top: var(--space-xs);
}
.error {
  font-size: var(--text-xs);
  color: var(--error);
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.btn {
  height: 32px;
  padding: 0 var(--space-md);
  background: var(--accent-gradient);
  color: white;
  border: none;
  border-radius: var(--border-radius);
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn:hover:not(:disabled) { filter: brightness(1.1); }
</style>
