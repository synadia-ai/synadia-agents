<script setup lang="ts">
import { ref, computed } from "vue";
import { useBridge } from "../../composables/useBridge.ts";
import {
  ccexecState,
  onCcSpawned,
  selectedCcController,
} from "../../stores/ccexec.ts";
import type { CcExecSpawnDescriptor, CcExecSpawnSpec } from "../../wire.ts";

const emit = defineEmits<{
  spawned: [descriptor: CcExecSpawnDescriptor];
}>();

const bridge = useBridge();

const cwd = ref("");
const sessionId = ref("");
const model = ref("");
const allowedTools = ref("");
const permissionMode = ref("");
const maxTurns = ref("");
const maxLifetime = ref("1800");
const submitting = ref(false);

const disabled = computed(() => !selectedCcController.value);

// Mirrors the SDK's PermissionMode enum. Empty string = use controller default.
const permissionOptions = ["", "default", "dontAsk", "acceptEdits", "bypassPermissions", "plan", "auto"];

async function onSubmit(e: Event): Promise<void> {
  e.preventDefault();
  if (disabled.value || submitting.value) return;
  const controller = selectedCcController.value!;

  const spec: CcExecSpawnSpec = { cwd: cwd.value.trim() };
  if (!spec.cwd) {
    ccexecState.lastError = "cwd is required";
    return;
  }
  if (sessionId.value.trim()) spec.session_id = sessionId.value.trim();
  if (model.value.trim()) spec.model = model.value.trim();
  const tools = allowedTools.value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tools.length > 0) spec.allowed_tools = tools;
  if (permissionMode.value) spec.permission_mode = permissionMode.value;
  if (maxTurns.value.trim()) {
    const n = Number(maxTurns.value);
    if (Number.isInteger(n) && n > 0) spec.max_turns = n;
  }
  const lifetime = Number(maxLifetime.value);
  if (Number.isFinite(lifetime) && lifetime >= 0) spec.max_lifetime_s = lifetime;

  submitting.value = true;
  ccexecState.lastError = null;
  try {
    const descriptor = await bridge.ccexecSpawn(controller.instanceId, spec);
    onCcSpawned(descriptor);
    emit("spawned", descriptor);
    // Reset just the dynamic fields; keep model / tools / mode / turns / lifetime for next spawn.
    cwd.value = "";
    sessionId.value = "";
  } catch (err) {
    ccexecState.lastError = `spawn failed: ${(err as Error).message}`;
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
        placeholder="(controller default, e.g. claude-sonnet-4-6)"
        :disabled="disabled"
      />
    </label>

    <label class="field">
      <span class="label mono">allowed tools</span>
      <input
        v-model="allowedTools"
        class="input mono"
        placeholder="(controller default, e.g. Read,Glob,Grep,Edit)"
        :disabled="disabled"
      />
    </label>

    <label class="field">
      <span class="label mono">permission mode</span>
      <select v-model="permissionMode" class="input mono" :disabled="disabled">
        <option v-for="opt in permissionOptions" :key="opt" :value="opt">
          {{ opt === "" ? "(controller default)" : opt }}
        </option>
      </select>
    </label>

    <label class="field">
      <span class="label mono">max turns</span>
      <input
        v-model="maxTurns"
        class="input mono"
        type="number"
        min="1"
        placeholder="(controller default)"
        :disabled="disabled"
      />
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
      <span v-if="ccexecState.lastError" class="error mono">{{ ccexecState.lastError }}</span>
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
