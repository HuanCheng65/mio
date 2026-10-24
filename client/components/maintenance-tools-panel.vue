<template>
  <div class="maintenance-pane">
    <div class="tool-grid">
      <div class="tool-card">
        <h2 class="tool-card__title">记忆蒸馏</h2>
        <p class="tool-card__desc">将 Working Memory 中的记忆整合到长期记忆，并更新关系印象。</p>
        <div class="tool-actions">
          <button class="btn btn--primary" type="button" @click="triggerDistillation" :disabled="!memoryEnabled || distilling">
            <Sparkles :size="14" />
            <span>{{ distilling ? "蒸馏中..." : "手动触发蒸馏" }}</span>
          </button>
          <button class="btn btn--ghost" type="button" @click="flushMemory" :disabled="!memoryEnabled || flushing">
            <DatabaseZap :size="14" />
            <span>{{ flushing ? "写入中..." : "写入 Working Memory" }}</span>
          </button>
        </div>
        <p v-if="!memoryEnabled" class="tool-card__note">记忆系统未启用</p>
        <div v-if="lastResult" class="result-box">
          <h3>操作结果</h3>
          <pre>{{ lastResult }}</pre>
        </div>
      </div>

      <div class="tool-card">
        <h2 class="tool-card__title">数据库维护</h2>
        <p class="tool-card__desc">清理和修复数据库中的历史数据。</p>
        <div class="tool-actions">
          <button class="btn btn--ghost" type="button" @click="migrateParticipants" :disabled="migrating">
            <Wrench :size="14" />
            <span>{{ migrating ? "迁移中..." : "修复 Participants 字段" }}</span>
          </button>
        </div>
        <p class="tool-card__note">将 episodic 记忆中的 participants 字段统一格式。</p>
        <div v-if="migrateResult" class="result-box result-box--warning">
          <h3>迁移结果</h3>
          <pre>{{ migrateResult }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { DatabaseZap, Sparkles, Wrench } from "lucide-vue-next";
import type { RuntimeConsoleController } from "../composables/use-runtime-console";

const props = defineProps<{
  runtime: RuntimeConsoleController;
}>();

const {
  distilling,
  flushing,
  migrating,
  memoryEnabled,
  lastResult,
  migrateResult,
  triggerDistillation,
  flushMemory,
  migrateParticipants,
} = props.runtime;
</script>

<style scoped>
.maintenance-pane {
  display: flex;
  flex-direction: column;
}

.tool-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  max-width: 960px;
}

.tool-card {
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: 16px;
}

.tool-card__title {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text);
}

.tool-card__desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--c-text-3);
}

.tool-card__note {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--c-text-4);
}

.tool-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.result-box {
  margin-top: 12px;
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--c-bg-soft);
  border: 1px solid var(--c-border-light);
}

.result-box--warning {
  background: var(--c-warning-soft);
  border-color: rgba(245, 158, 11, 0.15);
}

.result-box h3 {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-2);
}

.result-box pre {
  margin: 0;
  white-space: pre-wrap;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--c-text);
}

@media (max-width: 820px) {
  .tool-grid {
    grid-template-columns: 1fr;
  }
}
</style>
