<template>
  <div class="runtime-pane">
    <div class="runtime-pane__actions">
      <button class="action-button action-button--ghost" type="button" @click="refreshAll">
        <RefreshCw :size="16" />
        <span>刷新运行数据</span>
      </button>
      <button class="action-button action-button--danger" type="button" @click="resetTokenStats">
        <RotateCcw :size="16" />
        <span>重置 Token 统计</span>
      </button>
    </div>

    <div class="runtime-grid runtime-grid--two">
      <k-card class="runtime-card">
        <div class="panel-heading">
          <div>
            <p class="panel-eyebrow">Memory</p>
            <h2>记忆统计</h2>
          </div>
        </div>
        <div v-if="stats" class="runtime-stack">
          <p><strong>Episodic 记忆:</strong> {{ stats.episodic.active }} 条活跃 / {{ stats.episodic.archived }} 条已归档</p>
          <p><strong>Relational 记录:</strong> {{ stats.relational }} 条</p>
          <p><strong>Semantic Facts:</strong> {{ stats.semantic }} 条</p>
        </div>
        <div v-else class="empty-state empty-state--compact">加载中...</div>
      </k-card>

      <k-card class="runtime-card">
        <div class="panel-heading">
          <div>
            <p class="panel-eyebrow">Tokens</p>
            <h2>Token 用量</h2>
          </div>
        </div>
        <div v-if="tokenStats" class="runtime-stack">
          <div class="token-grid">
            <article class="token-card">
              <strong>{{ formatNumber(tokenStats.totalPromptTokens + tokenStats.totalCompletionTokens) }}</strong>
              <span>总 Tokens</span>
            </article>
            <article class="token-card">
              <strong>{{ tokenStats.totalCalls }}</strong>
              <span>总调用次数</span>
            </article>
            <article class="token-card">
              <strong>{{ todayTokens }}</strong>
              <span>今日 Tokens</span>
            </article>
            <article class="token-card">
              <strong>{{ formatNumber(tokenStats.totalCachedTokens) }}</strong>
              <span>缓存命中</span>
            </article>
          </div>
        </div>
        <div v-else class="empty-state empty-state--compact">加载中...</div>
      </k-card>
    </div>

    <div v-if="tokenStats" class="runtime-grid runtime-grid--three">
      <k-card class="runtime-card">
        <div class="panel-heading">
          <div>
            <p class="panel-eyebrow">By Model</p>
            <h2>按模型</h2>
          </div>
        </div>
        <table class="runtime-table">
          <thead>
            <tr>
              <th class="align-left">模型</th>
              <th>Prompt</th>
              <th>Cached</th>
              <th>Completion</th>
              <th>调用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="[model, usage] in byModelEntries" :key="model">
              <td class="align-left word-break">{{ model }}</td>
              <td>{{ formatNumber(usage.promptTokens) }}</td>
              <td class="accent-cell">{{ formatNumber(usage.cachedTokens) }}</td>
              <td>{{ formatNumber(usage.completionTokens) }}</td>
              <td>{{ usage.calls }}</td>
            </tr>
          </tbody>
        </table>
      </k-card>

      <k-card class="runtime-card">
        <div class="panel-heading">
          <div>
            <p class="panel-eyebrow">By Purpose</p>
            <h2>按用途</h2>
          </div>
        </div>
        <table class="runtime-table">
          <thead>
            <tr>
              <th class="align-left">用途</th>
              <th>Prompt</th>
              <th>Cached</th>
              <th>Completion</th>
              <th>调用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="[purpose, usage] in sortedByPurpose" :key="purpose">
              <td class="align-left word-break">{{ purpose }}</td>
              <td>{{ formatNumber(usage.promptTokens) }}</td>
              <td class="accent-cell">{{ formatNumber(usage.cachedTokens) }}</td>
              <td>{{ formatNumber(usage.completionTokens) }}</td>
              <td>{{ usage.calls }}</td>
            </tr>
          </tbody>
        </table>
      </k-card>

      <k-card class="runtime-card">
        <div class="panel-heading">
          <div>
            <p class="panel-eyebrow">By Date</p>
            <h2>按日期</h2>
          </div>
        </div>
        <table class="runtime-table">
          <thead>
            <tr>
              <th class="align-left">日期</th>
              <th>Tokens</th>
              <th>调用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="[date, usage] in sortedByDate" :key="date">
              <td class="align-left">{{ date }}</td>
              <td>{{ formatNumber(usage.promptTokens + usage.completionTokens) }}</td>
              <td>{{ usage.calls }}</td>
            </tr>
          </tbody>
        </table>
      </k-card>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { RefreshCw, RotateCcw } from "lucide-vue-next";
import type { RuntimeConsoleController } from "../composables/use-runtime-console";

const props = defineProps<{
  runtime: RuntimeConsoleController;
}>();

const {
  stats,
  tokenStats,
  byModelEntries,
  sortedByDate,
  sortedByPurpose,
  todayTokens,
  formatNumber,
  refreshAll,
  resetTokenStats,
} = props.runtime;
</script>

<style scoped>
.runtime-pane {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.runtime-pane__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.runtime-grid {
  display: grid;
  gap: 16px;
}

.runtime-grid--two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.runtime-grid--three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.runtime-card {
  padding: 18px;
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

.panel-heading h2 {
  margin: 0;
  font-family: "Fira Code", "JetBrains Mono", monospace;
  font-size: 24px;
  line-height: 1.15;
}

.runtime-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--text-base);
}

.token-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.token-card {
  padding: 14px;
  border-radius: 14px;
  background: rgba(248, 250, 252, 0.96);
}

.token-card strong {
  display: block;
  font-size: 22px;
  line-height: 1.1;
  margin-bottom: 6px;
}

.token-card span {
  color: var(--text-soft);
  font-size: 13px;
}

.runtime-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.runtime-table th,
.runtime-table td {
  padding: 10px 8px;
  text-align: right;
  border-bottom: 1px solid rgba(15, 23, 42, 0.08);
}

.runtime-table th {
  color: var(--text-soft);
  font-size: 12px;
  text-transform: uppercase;
}

.align-left {
  text-align: left;
}

.word-break {
  word-break: break-all;
}

.accent-cell {
  color: var(--accent-strong);
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  padding: 18px;
  text-align: center;
  border: 1px dashed rgba(15, 23, 42, 0.12);
  border-radius: 16px;
  color: var(--text-soft);
  background: rgba(255, 255, 255, 0.56);
}

.empty-state--compact {
  min-height: 88px;
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

.action-button--ghost {
  background: rgba(15, 23, 42, 0.06);
  color: var(--text-base);
}

.action-button--ghost:hover,
.action-button--ghost:focus-visible {
  background: rgba(15, 118, 110, 0.12);
  color: var(--accent-strong);
  outline: none;
}

.action-button--danger {
  background: var(--danger);
  color: #ffffff;
}

.action-button--danger:hover,
.action-button--danger:focus-visible {
  background: #9f1239;
  box-shadow: 0 10px 24px rgba(190, 18, 60, 0.18);
  outline: none;
}

@media (max-width: 1180px) {
  .runtime-grid--three {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 820px) {
  .runtime-grid--two,
  .token-grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .action-button {
    transition: none;
  }
}
</style>
