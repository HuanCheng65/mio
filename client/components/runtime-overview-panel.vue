<template>
  <div class="runtime-pane">
    <div class="range-bar">
      <button
        v-for="opt in rangeOptions"
        :key="opt.id"
        class="range-btn"
        :class="{ 'range-btn--active': dateRange === opt.id }"
        type="button"
        @click="dateRange = opt.id"
      >
        {{ opt.label }}
      </button>
    </div>

    <div class="kpi-row">
      <div class="kpi">
        <span class="kpi__value">{{ formatNumber(period.total) }}</span>
        <span class="kpi__label">Tokens</span>
      </div>
      <div class="kpi kpi--accent">
        <span class="kpi__value">{{ periodCacheRate }}</span>
        <span class="kpi__label">缓存命中率</span>
      </div>
      <div class="kpi">
        <span class="kpi__value">{{ formatNumber(period.calls) }}</span>
        <span class="kpi__label">调用次数</span>
      </div>
      <div class="kpi">
        <span class="kpi__value">{{ avgPerCall }}</span>
        <span class="kpi__label">均值 / 调用</span>
      </div>
    </div>

    <template v-if="filtered.length > 0">
      <div class="breakdown-grid">
        <section class="breakdown-card">
          <h3 class="card-title">按用途</h3>
          <div v-for="item in purposeBreakdown" :key="item.key" class="bk-row">
            <span class="bk-name" :title="item.key">{{ item.key }}</span>
            <div class="bk-track">
              <div class="bk-fill" :style="{ width: item.bar + '%' }" />
            </div>
            <span class="bk-num">{{ formatNumber(item.tokens) }}</span>
            <span class="bk-pct">{{ item.pct }}%</span>
          </div>
        </section>

        <section class="breakdown-card">
          <h3 class="card-title">按模型</h3>
          <div v-for="item in modelBreakdown" :key="item.key" class="bk-row">
            <span class="bk-name mono" :title="item.key">{{ item.key }}</span>
            <div class="bk-track">
              <div class="bk-fill bk-fill--alt" :style="{ width: item.bar + '%' }" />
            </div>
            <span class="bk-num">{{ formatNumber(item.tokens) }}</span>
            <span class="bk-pct">{{ item.pct }}%</span>
          </div>
        </section>
      </div>

      <section class="detail-card">
        <div class="detail-head">
          <h3 class="card-title">明细</h3>
          <span class="detail-count">{{ filtered.length }} 条</span>
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th v-if="showDateCol" class="col-label">日期</th>
                <th class="col-label">模型</th>
                <th class="col-label">用途</th>
                <th class="col-num">Prompt</th>
                <th class="col-num">Completion</th>
                <th class="col-num">Cached</th>
                <th class="col-num">调用</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, i) in filtered"
                :key="`${row.date}-${row.model}-${row.purpose}`"
                :class="{ 'date-break': showDateCol && i > 0 && row.date !== filtered[i - 1].date }"
              >
                <td v-if="showDateCol" class="col-label col-date">{{ row.date }}</td>
                <td class="col-label mono">{{ row.model }}</td>
                <td class="col-label">{{ row.purpose }}</td>
                <td class="col-num">{{ formatNumber(row.promptTokens) }}</td>
                <td class="col-num">{{ formatNumber(row.completionTokens) }}</td>
                <td class="col-num accent">{{ formatNumber(row.cachedTokens) }}</td>
                <td class="col-num">{{ row.calls }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <div v-else class="empty-state">{{ emptyHint }}</div>

    <div class="footer-bar">
      <div v-if="stats" class="memory-line">
        <span class="memory-tag">记忆</span>
        <span>Episodic {{ stats.episodic.active }} / {{ stats.episodic.archived }}</span>
        <span class="dot">&middot;</span>
        <span>Relational {{ stats.relational }}</span>
        <span class="dot">&middot;</span>
        <span>Semantic {{ stats.semantic }}</span>
      </div>
      <button class="btn btn--subtle" type="button" @click="resetTokenStats">
        <RotateCcw :size="13" />
        <span>重置统计</span>
      </button>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, ref } from "vue";
import { RotateCcw } from "lucide-vue-next";
import type { RuntimeConsoleController } from "../composables/use-runtime-console";

const props = defineProps<{ runtime: RuntimeConsoleController }>();
const { stats, detailRows, formatNumber, resetTokenStats } = props.runtime;

type RangeId = "today" | "yesterday" | "7d" | "30d" | "all";
const dateRange = ref<RangeId>("7d");
const rangeOptions: { id: RangeId; label: string }[] = [
  { id: "today", label: "今日" },
  { id: "yesterday", label: "昨日" },
  { id: "7d", label: "近 7 日" },
  { id: "30d", label: "近 30 日" },
  { id: "all", label: "全部" },
];

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

const showDateCol = computed(() => dateRange.value !== "today" && dateRange.value !== "yesterday");

const filtered = computed(() => {
  const rows = detailRows.value;
  if (dateRange.value === "all") return rows;

  const now = new Date();
  const today = isoDate(now);

  if (dateRange.value === "today") return rows.filter((r) => r.date === today);

  if (dateRange.value === "yesterday") {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    const y = isoDate(d);
    return rows.filter((r) => r.date === y);
  }

  const days = dateRange.value === "7d" ? 6 : 29;
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  const start = isoDate(d);
  return rows.filter((r) => r.date >= start && r.date <= today);
});

const period = computed(() => {
  let prompt = 0, completion = 0, cached = 0, calls = 0;
  for (const r of filtered.value) {
    prompt += r.promptTokens;
    completion += r.completionTokens;
    cached += r.cachedTokens;
    calls += r.calls;
  }
  return { prompt, completion, cached, calls, total: prompt + completion };
});

const periodCacheRate = computed(() => {
  const { prompt, cached } = period.value;
  if (prompt === 0) return "0%";
  return ((cached / prompt) * 100).toFixed(1) + "%";
});

const avgPerCall = computed(() => {
  const { total, calls } = period.value;
  if (calls === 0) return "0";
  return formatNumber(Math.round(total / calls));
});

interface BkItem { key: string; tokens: number; pct: string; bar: number }

function buildBreakdown(field: "purpose" | "model"): BkItem[] {
  const map = new Map<string, number>();
  for (const r of filtered.value) {
    const k = field === "purpose" ? r.purpose : r.model;
    map.set(k, (map.get(k) || 0) + r.promptTokens + r.completionTokens);
  }
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
  const max = entries[0]?.[1] || 1;
  const total = period.value.total || 1;
  return entries.map(([key, tokens]) => ({
    key,
    tokens,
    pct: ((tokens / total) * 100).toFixed(0),
    bar: (tokens / max) * 100,
  }));
}

const purposeBreakdown = computed(() => buildBreakdown("purpose"));
const modelBreakdown = computed(() => buildBreakdown("model"));

const emptyHint = computed(() => {
  if (dateRange.value === "today") return "今日暂无用量数据";
  if (dateRange.value === "yesterday") return "昨日暂无用量数据";
  return "所选时段暂无数据";
});
</script>

<style scoped>
.runtime-pane {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Range selector */
.range-bar {
  display: flex;
  gap: 2px;
  background: var(--c-bg-muted);
  padding: 3px;
  border-radius: var(--radius-md);
  width: fit-content;
}

.range-btn {
  padding: 5px 14px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text-3);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 150ms, color 150ms, box-shadow 150ms;
}

.range-btn:hover {
  color: var(--c-text);
}

.range-btn--active {
  background: var(--c-bg);
  color: var(--c-text);
  box-shadow: var(--shadow-sm);
}

/* KPI row */
.kpi-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.kpi {
  padding: 14px 16px;
  border-radius: var(--radius-lg);
  background: var(--c-bg);
  border: 1px solid var(--c-border);
}

.kpi--accent {
  background: var(--c-accent-soft);
  border-color: var(--c-accent-muted);
}

.kpi__value {
  display: block;
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  margin-bottom: 4px;
  color: var(--c-text);
}

.kpi--accent .kpi__value {
  color: var(--c-accent-active);
}

.kpi__label {
  font-size: 12px;
  color: var(--c-text-3);
}

/* Breakdown grid */
.breakdown-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

.breakdown-card {
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: 16px;
}

.card-title {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text);
}

.bk-row {
  display: grid;
  grid-template-columns: minmax(80px, 140px) 1fr 72px 36px;
  gap: 8px;
  align-items: center;
  padding: 5px 0;
}

.bk-row + .bk-row {
  border-top: 1px solid var(--c-border-light);
}

.bk-name {
  font-size: 12px;
  color: var(--c-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bk-track {
  height: 6px;
  border-radius: 3px;
  background: var(--c-bg-muted);
  overflow: hidden;
}

.bk-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--c-accent);
  min-width: 2px;
  transition: width 250ms ease;
}

.bk-fill--alt {
  background: var(--c-text-4);
}

.bk-num {
  text-align: right;
  font-size: 12px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--c-text);
}

.bk-pct {
  text-align: right;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--c-text-4);
}

/* Detail table */
.detail-card {
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: 16px;
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.detail-count {
  font-size: 12px;
  color: var(--c-text-4);
}

.table-scroll {
  overflow-x: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.data-table th,
.data-table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--c-border-light);
}

.data-table th {
  font-size: 11px;
  font-weight: 600;
  color: var(--c-text-4);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  position: sticky;
  top: 0;
  background: var(--c-bg);
}

.data-table tbody tr:hover {
  background: var(--c-bg-soft);
}

.date-break td {
  border-top: 2px solid var(--c-border);
}

.col-label { text-align: left; }
.col-date { white-space: nowrap; }
.col-num { text-align: right; white-space: nowrap; }
.mono { font-family: var(--font-mono); font-size: 12px; }
.accent { color: var(--c-accent); font-weight: 500; }

/* Footer */
.footer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.memory-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--c-text-3);
}

.memory-tag {
  font-weight: 600;
  color: var(--c-text-4);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.dot {
  color: var(--c-text-4);
}

@media (max-width: 900px) {
  .breakdown-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 820px) {
  .kpi-row {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 480px) {
  .kpi-row {
    grid-template-columns: 1fr;
  }
  .range-bar {
    width: 100%;
  }
  .range-btn {
    flex: 1;
    text-align: center;
  }
}
</style>
