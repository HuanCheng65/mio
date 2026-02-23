<template>
  <k-layout>
    <div class="mio-dashboard">
      <!-- 顶部统计卡片 -->
      <div class="row">
        <k-card class="card">
          <h2>记忆统计</h2>
          <div v-if="stats">
            <p>
              <strong>Episodic 记忆:</strong> {{ stats.episodic.active }} 条活跃 /
              {{ stats.episodic.archived }} 条已归档
            </p>
            <p><strong>Relational 记录:</strong> {{ stats.relational }} 条</p>
            <p><strong>Semantic Facts:</strong> {{ stats.semantic }} 条</p>
          </div>
          <div v-else><p>加载中...</p></div>
        </k-card>

        <k-card class="card">
          <h2>Token 用量</h2>
          <div v-if="tokenStats">
            <div class="stat-row">
              <div class="stat-box blue">
                <div class="stat-number">{{ formatNumber(tokenStats.totalPromptTokens + tokenStats.totalCompletionTokens) }}</div>
                <div class="stat-label">总 Tokens</div>
              </div>
              <div class="stat-box green">
                <div class="stat-number">{{ tokenStats.totalCalls }}</div>
                <div class="stat-label">总调用次数</div>
              </div>
              <div class="stat-box purple">
                <div class="stat-number">{{ todayTokens }}</div>
                <div class="stat-label">今日 Tokens</div>
              </div>
            </div>
            <div style="margin-top: 12px">
              <el-button size="small" @click="loadTokenStats">刷新</el-button>
              <el-button size="small" type="danger" @click="resetTokenStats">重置全部</el-button>
            </div>
          </div>
          <div v-else><p>加载中...</p></div>
        </k-card>
      </div>

      <!-- Token 明细 -->
      <div class="row" v-if="tokenStats">
        <k-card class="card">
          <h2>按模型</h2>
          <table class="data-table">
            <thead>
              <tr>
                <th style="text-align: left">模型</th>
                <th>Prompt</th>
                <th>Completion</th>
                <th>调用</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(usage, model) in tokenStats.byModel" :key="model">
                <td style="text-align: left; word-break: break-all">{{ model }}</td>
                <td>{{ formatNumber(usage.promptTokens) }}</td>
                <td>{{ formatNumber(usage.completionTokens) }}</td>
                <td>{{ usage.calls }}</td>
              </tr>
            </tbody>
          </table>
        </k-card>

        <k-card class="card">
          <h2>按日期</h2>
          <table class="data-table">
            <thead>
              <tr>
                <th style="text-align: left">日期</th>
                <th>Tokens</th>
                <th>调用</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(usage, date) in sortedByDate" :key="date">
                <td style="text-align: left">{{ date }}</td>
                <td>{{ formatNumber(usage.promptTokens + usage.completionTokens) }}</td>
                <td>{{ usage.calls }}</td>
              </tr>
            </tbody>
          </table>
        </k-card>
      </div>

      <!-- 操作区 -->
      <div class="row">
        <k-card class="card">
          <h2>记忆蒸馏</h2>
          <p>蒸馏会将 Working Memory 中的记忆整合到长期记忆中，并更新关系印象。</p>
          <div style="margin: 16px 0">
            <el-button
              type="primary"
              :loading="distilling"
              @click="triggerDistillation"
              :disabled="!memoryEnabled"
            >
              {{ distilling ? "蒸馏中..." : "手动触发蒸馏" }}
            </el-button>
            <el-button
              type="default"
              :loading="flushing"
              @click="flushMemory"
              :disabled="!memoryEnabled"
            >
              {{ flushing ? "写入中..." : "立即写入 Working Memory" }}
            </el-button>
          </div>
          <div v-if="!memoryEnabled" style="color: #999">记忆系统未启用</div>
          <div v-if="lastResult" class="result-box">
            <h3>操作结果</h3>
            <pre>{{ lastResult }}</pre>
          </div>
        </k-card>

        <k-card class="card">
          <h2>数据库维护</h2>
          <p>清理和修复数据库中的历史数据。</p>
          <div style="margin: 16px 0">
            <el-button
              type="warning"
              :loading="migrating"
              @click="migrateParticipants"
            >
              {{ migrating ? "迁移中..." : "修复 Participants 字段" }}
            </el-button>
            <p style="margin-top: 8px; font-size: 12px; color: #999">
              将 episodic 记忆中的 participants 字段统一格式
            </p>
          </div>
          <div v-if="migrateResult" class="result-box warning">
            <h3>迁移结果</h3>
            <pre>{{ migrateResult }}</pre>
          </div>
        </k-card>
      </div>
    </div>
  </k-layout>
</template>

<script lang="ts" setup>
import { ref, computed, onMounted } from "vue";
import { send, message } from "@koishijs/client";

const stats = ref<any>(null);
const tokenStats = ref<any>(null);
const distilling = ref(false);
const flushing = ref(false);
const migrating = ref(false);
const memoryEnabled = ref(true);
const lastResult = ref("");
const migrateResult = ref("");

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const sortedByDate = computed(() => {
  if (!tokenStats.value?.byDate) return {};
  const entries = Object.entries(tokenStats.value.byDate);
  entries.sort((a, b) => b[0].localeCompare(a[0]));
  return Object.fromEntries(entries);
});

const todayTokens = computed(() => {
  const d = tokenStats.value?.byDate?.[today()];
  if (!d) return "0";
  return formatNumber(d.promptTokens + d.completionTokens);
});

async function loadStats() {
  try {
    const data = await send("mio/memory-stats");
    stats.value = data;
    memoryEnabled.value = data.enabled;
  } catch (err) {
    message.error("加载统计失败: " + err.message);
  }
}

async function loadTokenStats() {
  try {
    tokenStats.value = await send("mio/token-stats");
  } catch (err) {
    message.error("加载 Token 统计失败: " + err.message);
  }
}

async function resetTokenStats() {
  try {
    await send("mio/token-stats-reset");
    message.success("统计已重置");
    await loadTokenStats();
  } catch (err) {
    message.error("重置失败: " + err.message);
  }
}

async function triggerDistillation() {
  distilling.value = true;
  lastResult.value = "";
  try {
    const result = await send("mio/trigger-distillation");
    lastResult.value = result;
    message.success("蒸馏完成");
    await loadStats();
  } catch (err) {
    message.error("蒸馏失败: " + err.message);
    lastResult.value = "错误: " + err.message;
  } finally {
    distilling.value = false;
  }
}

async function flushMemory() {
  flushing.value = true;
  lastResult.value = "";
  try {
    const result = await send("mio/flush-memory");
    lastResult.value = result;
    message.success("写入完成");
    await loadStats();
  } catch (err) {
    message.error("写入失败: " + err.message);
    lastResult.value = "错误: " + err.message;
  } finally {
    flushing.value = false;
  }
}

async function migrateParticipants() {
  migrating.value = true;
  migrateResult.value = "";
  try {
    const result = await send("mio/migrate-participants");
    migrateResult.value = result;
    message.success("迁移完成");
    await loadStats();
  } catch (err) {
    message.error("迁移失败: " + err.message);
    migrateResult.value = "错误: " + err.message;
  } finally {
    migrating.value = false;
  }
}

onMounted(() => {
  loadStats();
  loadTokenStats();
});
</script>

<style scoped>
.mio-dashboard {
  padding: 16px;
  max-width: 1200px;
}

.row {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}

.row > .card {
  flex: 1;
  min-width: 0;
}

.stat-row {
  display: flex;
  gap: 12px;
}

.stat-box {
  flex: 1;
  text-align: center;
  padding: 14px 8px;
  border-radius: 8px;
}

.stat-box.blue { background: #f0f7ff; }
.stat-box.green { background: #f0f9eb; }
.stat-box.purple { background: #f3f0ff; }

.stat-number {
  font-size: 22px;
  font-weight: bold;
}

.stat-box.blue .stat-number { color: #409eff; }
.stat-box.green .stat-number { color: #67c23a; }
.stat-box.purple .stat-number { color: #7c5cfc; }

.stat-label {
  font-size: 12px;
  color: #999;
  margin-top: 4px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.data-table th,
.data-table td {
  padding: 8px 6px;
  text-align: right;
  border-bottom: 1px solid var(--k-color-divider, #eee);
}

.data-table th {
  font-weight: 600;
  color: #999;
  font-size: 12px;
}

.result-box {
  margin-top: 16px;
  padding: 12px;
  background: var(--k-color-active, #f5f5f5);
  border-radius: 6px;
}

.result-box.warning {
  background: #fff3cd;
}

.result-box pre {
  white-space: pre-wrap;
  margin: 8px 0 0;
  font-size: 13px;
}

.result-box h3 {
  margin: 0;
  font-size: 14px;
}

@media (max-width: 768px) {
  .row {
    flex-direction: column;
  }
}
</style>
