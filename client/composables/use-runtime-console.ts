import { computed, ref } from "vue";
import { message, send } from "@koishijs/client";
import type { MemoryStats, TokenStats } from "../types";

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function useRuntimeConsole() {
  const stats = ref<MemoryStats | null>(null);
  const tokenStats = ref<TokenStats | null>(null);
  const distilling = ref(false);
  const flushing = ref(false);
  const migrating = ref(false);
  const memoryEnabled = ref(true);
  const lastResult = ref("");
  const migrateResult = ref("");

  const byModelEntries = computed(() => {
    if (!tokenStats.value?.byModel) {
      return [] as Array<[string, TokenStats["byModel"][string]]>;
    }

    return Object.entries(tokenStats.value.byModel);
  });

  const sortedByDate = computed(() => {
    if (!tokenStats.value?.byDate) {
      return [] as Array<[string, TokenStats["byDate"][string]]>;
    }

    return Object.entries(tokenStats.value.byDate).sort((a, b) => b[0].localeCompare(a[0]));
  });

  const sortedByPurpose = computed(() => {
    if (!tokenStats.value?.byPurpose) {
      return [] as Array<[string, TokenStats["byPurpose"][string]]>;
    }

    return Object.entries(tokenStats.value.byPurpose).sort((a, b) => {
      const tokensA = a[1].promptTokens + a[1].completionTokens;
      const tokensB = b[1].promptTokens + b[1].completionTokens;
      return tokensB - tokensA;
    });
  });

  const todayTokens = computed(() => {
    const todayUsage = tokenStats.value?.byDate?.[today()];
    if (!todayUsage) {
      return "0";
    }

    return formatNumber(todayUsage.promptTokens + todayUsage.completionTokens);
  });

  function formatNumber(value: number) {
    return value.toLocaleString();
  }

  async function loadStats() {
    try {
      const data = await send("mio/memory-stats") as MemoryStats;
      stats.value = data;
      memoryEnabled.value = data.enabled;
    } catch (error) {
      message.error(`加载统计失败: ${formatError(error)}`);
    }
  }

  async function loadTokenStats() {
    try {
      tokenStats.value = await send("mio/token-stats") as TokenStats;
    } catch (error) {
      message.error(`加载 Token 统计失败: ${formatError(error)}`);
    }
  }

  async function refreshAll() {
    await Promise.all([loadStats(), loadTokenStats()]);
  }

  async function resetTokenStats() {
    try {
      await send("mio/token-stats-reset");
      message.success("统计已重置");
      await loadTokenStats();
    } catch (error) {
      message.error(`重置失败: ${formatError(error)}`);
    }
  }

  async function triggerDistillation() {
    distilling.value = true;
    lastResult.value = "";
    try {
      const result = await send("mio/trigger-distillation");
      lastResult.value = String(result);
      message.success("蒸馏完成");
      await loadStats();
    } catch (error) {
      const text = formatError(error);
      lastResult.value = `错误: ${text}`;
      message.error(`蒸馏失败: ${text}`);
    } finally {
      distilling.value = false;
    }
  }

  async function flushMemory() {
    flushing.value = true;
    lastResult.value = "";
    try {
      const result = await send("mio/flush-memory");
      lastResult.value = String(result);
      message.success("写入完成");
      await loadStats();
    } catch (error) {
      const text = formatError(error);
      lastResult.value = `错误: ${text}`;
      message.error(`写入失败: ${text}`);
    } finally {
      flushing.value = false;
    }
  }

  async function migrateParticipants() {
    migrating.value = true;
    migrateResult.value = "";
    try {
      const result = await send("mio/migrate-participants");
      migrateResult.value = String(result);
      message.success("迁移完成");
      await loadStats();
    } catch (error) {
      const text = formatError(error);
      migrateResult.value = `错误: ${text}`;
      message.error(`迁移失败: ${text}`);
    } finally {
      migrating.value = false;
    }
  }

  return {
    stats,
    tokenStats,
    distilling,
    flushing,
    migrating,
    memoryEnabled,
    lastResult,
    migrateResult,
    byModelEntries,
    sortedByDate,
    sortedByPurpose,
    todayTokens,
    formatNumber,
    loadStats,
    loadTokenStats,
    refreshAll,
    resetTokenStats,
    triggerDistillation,
    flushMemory,
    migrateParticipants,
  };
}

export type RuntimeConsoleController = ReturnType<typeof useRuntimeConsole>;
