<template>
  <k-layout>
    <template #left>
      <k-card>
        <h2>记忆统计</h2>
        <div v-if="stats">
          <p>
            <strong>Episodic 记忆:</strong> {{ stats.episodic.active }} 条活跃 /
            {{ stats.episodic.archived }} 条已归档
          </p>
          <p><strong>Relational 记录:</strong> {{ stats.relational }} 条</p>
          <p><strong>Semantic Facts:</strong> {{ stats.semantic }} 条</p>
        </div>
        <div v-else>
          <p>加载中...</p>
        </div>
      </k-card>
    </template>

    <k-card>
      <h2>记忆蒸馏</h2>
      <p>蒸馏会将 Working Memory 中的记忆整合到长期记忆中，并更新关系印象。</p>

      <div style="margin: 20px 0">
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

      <div
        v-if="lastResult"
        style="
          margin-top: 20px;
          padding: 10px;
          background: #f5f5f5;
          border-radius: 4px;
        "
      >
        <h3>上次操作结果</h3>
        <pre style="white-space: pre-wrap">{{ lastResult }}</pre>
      </div>
    </k-card>

    <k-card>
      <h2>数据库维护</h2>
      <p>清理和修复数据库中的历史数据。</p>

      <div style="margin: 20px 0">
        <el-button
          type="warning"
          :loading="migrating"
          @click="migrateParticipants"
        >
          {{ migrating ? "迁移中..." : "修复 Participants 字段" }}
        </el-button>
        <p style="margin-top: 10px; font-size: 12px; color: #666">
          将 episodic 记忆中的 participants 字段统一格式（Bot 统一为 "bot"，用户
          ID 统一为纯数字）
        </p>
      </div>

      <div
        v-if="migrateResult"
        style="
          margin-top: 20px;
          padding: 10px;
          background: #fff3cd;
          border-radius: 4px;
        "
      >
        <h3>迁移结果</h3>
        <pre style="white-space: pre-wrap">{{ migrateResult }}</pre>
      </div>
    </k-card>
  </k-layout>
</template>

<script lang="ts" setup>
import { ref, onMounted } from "vue";
import { send, message } from "@koishijs/client";

const stats = ref<any>(null);
const distilling = ref(false);
const flushing = ref(false);
const migrating = ref(false);
const memoryEnabled = ref(true);
const lastResult = ref("");
const migrateResult = ref("");

async function loadStats() {
  try {
    const data = await send("mio/memory-stats");
    stats.value = data;
    memoryEnabled.value = data.enabled;
  } catch (err) {
    message.error("加载统计失败: " + err.message);
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
});
</script>
