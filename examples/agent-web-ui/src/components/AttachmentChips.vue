<script setup lang="ts">
defineProps<{
  files: File[];
}>();

const emit = defineEmits<{ remove: [index: number] }>();

function formatSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
</script>

<template>
  <div v-if="files.length" class="chips">
    <div v-for="(file, i) in files" :key="i" class="chip">
      <span class="name mono">{{ file.name }}</span>
      <span class="size mono">{{ formatSize(file.size) }}</span>
      <button type="button" class="remove" @click="emit('remove', i)" title="remove">×</button>
    </div>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  padding-bottom: var(--space-xs);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  padding: 4px 4px 4px 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: var(--bg-tertiary);
  border-radius: 999px;
  font-size: var(--text-xs);
}
.name { color: var(--text-primary); }
.size { color: var(--text-dim); }
.remove {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all var(--transition-fast);
}
.remove:hover {
  background: var(--error-dim);
  color: var(--error);
}
</style>
