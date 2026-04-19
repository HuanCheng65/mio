<template>
  <div class="maintenance-pane">
    <div class="maintenance-grid">
      <k-card class="maintenance-card">
        <div class="panel-heading">
          <div>
            <p class="panel-eyebrow">Distillation</p>
            <h2>记忆蒸馏</h2>
          </div>
        </div>
        <p class="section-copy">蒸馏会将 Working Memory 中的记忆整合到长期记忆中，并更新关系印象。</p>
        <div class="button-row">
          <button class="action-button action-button--primary" type="button" @click="triggerDistillation" :disabled="!memoryEnabled || distilling">
            <Sparkles :size="16" />
            <span>{{ distilling ? "蒸馏中..." : "手动触发蒸馏" }}</span>
          </button>
          <button class="action-button action-button--ghost" type="button" @click="flushMemory" :disabled="!memoryEnabled || flushing">
            <DatabaseZap :size="16" />
            <span>{{ flushing ? "写入中..." : "立即写入 Working Memory" }}</span>
          </button>
        </div>
        <p v-if="!memoryEnabled" class="section-copy">记忆系统未启用</p>
        <div v-if="lastResult" class="result-box">
          <h3>操作结果</h3>
          <pre>{{ lastResult }}</pre>
        </div>
      </k-card>

      <k-card class="maintenance-card">
        <div class="panel-heading">
          <div>
            <p class="panel-eyebrow">Maintenance</p>
            <h2>数据库维护</h2>
          </div>
        </div>
        <p class="section-copy">清理和修复数据库中的历史数据。</p>
        <div class="button-row">
          <button class="action-button action-button--ghost" type="button" @click="migrateParticipants" :disabled="migrating">
            <Wrench :size="16" />
            <span>{{ migrating ? "迁移中..." : "修复 Participants 字段" }}</span>
          </button>
        </div>
        <p class="section-copy">将 episodic 记忆中的 participants 字段统一格式。</p>
        <div v-if="migrateResult" class="result-box result-box--warning">
          <h3>迁移结果</h3>
          <pre>{{ migrateResult }}</pre>
        </div>
      </k-card>
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
  gap: 16px;
}

.maintenance-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.maintenance-card {
  padding: 20px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: 18px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.07);
}

.panel-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}

.panel-eyebrow {
  margin: 0 0 8px;
  color: var(--accent-strong);
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 700;
}

.panel-heading h2,
.result-box h3 {
  margin: 0;
  font-family: "Fira Code", "JetBrains Mono", monospace;
}

.panel-heading h2 {
  font-size: 24px;
  line-height: 1.15;
}

.section-copy {
  margin: 0 0 14px;
  line-height: 1.7;
  color: var(--text-soft);
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.result-box {
  margin-top: 18px;
  padding: 16px;
  border-radius: 16px;
  background: rgba(248, 250, 252, 0.96);
  border: 1px solid rgba(15, 23, 42, 0.08);
}

.result-box--warning {
  background: var(--warning-soft);
  border-color: rgba(249, 115, 22, 0.16);
}

.result-box pre {
  margin: 10px 0 0;
  white-space: pre-wrap;
  color: var(--text-base);
}

.action-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-radius: 12px;
  border: none;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  transition: background-color 180ms ease, color 180ms ease, box-shadow 180ms ease, opacity 180ms ease;
}

.action-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.action-button--primary {
  background: var(--accent);
  color: #ffffff;
}

.action-button--primary:hover:not(:disabled),
.action-button--primary:focus-visible:not(:disabled) {
  background: var(--accent-strong);
  box-shadow: 0 8px 22px rgba(15, 118, 110, 0.2);
  outline: none;
}

.action-button--ghost {
  background: rgba(15, 23, 42, 0.06);
  color: var(--text-base);
}

.action-button--ghost:hover:not(:disabled),
.action-button--ghost:focus-visible:not(:disabled) {
  background: rgba(15, 118, 110, 0.12);
  color: var(--accent-strong);
  outline: none;
}

@media (max-width: 900px) {
  .maintenance-grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .action-button {
    transition: none;
  }
}
</style>
