import { computed, ref } from "vue";
import { message, send } from "@koishijs/client";
import type { TokenStats } from "../types";

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
  const tokenStats = ref<TokenStats | null>(null);

  const todayTokens = computed(() => {
    const todayUsage = tokenStats.value?.byDate?.[today()];
    if (!todayUsage) return "0";
    return formatNumber(todayUsage.promptTokens + todayUsage.completionTokens);
  });

  const totalTokens = computed(() => {
    if (!tokenStats.value) return "0";
    return formatNumber(tokenStats.value.totalPromptTokens + tokenStats.value.totalCompletionTokens);
  });

  const totalCalls = computed(() => {
    if (!tokenStats.value) return "0";
    return formatNumber(tokenStats.value.totalCalls);
  });

  const cacheHitRate = computed(() => {
    if (!tokenStats.value || tokenStats.value.totalPromptTokens === 0) return "0%";
    const rate = (tokenStats.value.totalCachedTokens / tokenStats.value.totalPromptTokens) * 100;
    return rate.toFixed(1) + "%";
  });

  const detailRows = computed(() => {
    return tokenStats.value?.detail ?? [];
  });

  function formatNumber(value: number) {
    return value.toLocaleString();
  }

  async function loadTokenStats() {
    try {
      tokenStats.value = await send("mio/token-stats") as TokenStats;
    } catch (error) {
      message.error(`加载 Token 统计失败: ${formatError(error)}`);
    }
  }

  async function refreshAll() {
    await loadTokenStats();
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

  return {
    tokenStats,
    todayTokens,
    totalTokens,
    totalCalls,
    cacheHitRate,
    detailRows,
    formatNumber,
    loadTokenStats,
    refreshAll,
    resetTokenStats,
  };
}

export type RuntimeConsoleController = ReturnType<typeof useRuntimeConsole>;
