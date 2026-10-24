import { computed, reactive, ref, watch } from "vue";
import { message, send } from "@koishijs/client";
import type { Config as MioConfig } from "../../src/config";
import type { ModelConfig, ProviderConfig } from "../../src/llm/provider";
import type { ProviderTestResult } from "../../src/console/config-service";

type SaveState = "idle" | "dirty" | "saving" | "failed";

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function generateProviderId(existing: ProviderConfig[]): string {
  const taken = new Set(existing.map((p) => p.id));
  for (let attempt = 0; attempt < 16; attempt++) {
    const rand = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 8)
      : Math.random().toString(16).slice(2, 10).padStart(8, "0");
    const id = `p-${rand}`;
    if (!taken.has(id)) return id;
  }
  return `p-${Date.now().toString(16)}`;
}

export function useConfigStudio() {
  const draft = ref<MioConfig | null>(null);
  const baseline = ref<string>("");
  const selectedProviderId = ref<string>("");
  const saveState = ref<SaveState>("idle");

  const loading = reactive({
    refresh: false,
    save: false,
    test: false,
    listModels: false,
  });

  const modelOptionsByProvider = reactive<Record<string, string[]>>({});
  const testResults = reactive<Record<string, ProviderTestResult>>({});
  const apiKeyRevealed = reactive<Record<string, boolean>>({});

  const isDirty = computed(() => {
    if (!draft.value) return false;
    return JSON.stringify(draft.value) !== baseline.value;
  });

  const selectedProvider = computed<ProviderConfig | null>(() => {
    if (!draft.value) return null;
    return draft.value.providers.find((p) => p.id === selectedProviderId.value) ?? null;
  });

  const referencedProviderIds = computed<Set<string>>(() => {
    const set = new Set<string>();
    if (!draft.value) return set;
    const cfg = draft.value;
    const add = (id: string | undefined) => {
      if (id) set.add(id);
    };
    add(cfg.models?.chat?.providerId);
    if (cfg.vision?.enabled) add(cfg.models?.vision?.providerId);
    if (cfg.memory?.enabled) {
      add(cfg.memory.embedding?.providerId);
      add(cfg.memory.extraction?.providerId);
      add(cfg.memory.distillation?.providerId);
    }
    if (cfg.search?.enabled) add(cfg.search.compression?.providerId);
    return set;
  });

  function isProviderReferenced(id: string): boolean {
    return referencedProviderIds.value.has(id);
  }

  const saveStateText = computed(() => {
    switch (saveState.value) {
      case "dirty":
        return "有未保存改动";
      case "saving":
        return "保存中";
      case "failed":
        return "保存失败";
      default:
        return "已同步";
    }
  });

  const busyAction = computed(() => Object.values(loading).some(Boolean));

  watch(isDirty, (val) => {
    if (loading.save) return;
    if (val) saveState.value = "dirty";
    else if (saveState.value !== "saving") saveState.value = "idle";
  });

  async function refresh() {
    loading.refresh = true;
    try {
      const cfg = (await send("mio/config/get")) as MioConfig;
      draft.value = cfg;
      baseline.value = JSON.stringify(cfg);
      saveState.value = "idle";
      if (!selectedProviderId.value || !cfg.providers.some((p) => p.id === selectedProviderId.value)) {
        selectedProviderId.value = cfg.providers[0]?.id ?? "";
      }
    } catch (error) {
      message.error(`加载配置失败: ${formatError(error)}`);
    } finally {
      loading.refresh = false;
    }
  }

  async function save() {
    if (!draft.value || !isDirty.value) return;
    loading.save = true;
    saveState.value = "saving";
    try {
      await send("mio/config/update", clone(draft.value));
      message.success("配置已保存，插件正在热重载…");
      await new Promise((r) => setTimeout(r, 200));
      await refresh();
    } catch (error) {
      saveState.value = "failed";
      message.error(`保存失败: ${formatError(error)}`);
    } finally {
      loading.save = false;
    }
  }

  function addProvider() {
    if (!draft.value) return;
    const id = generateProviderId(draft.value.providers);
    const provider: ProviderConfig = {
      id,
      name: "未命名供应商",
      type: "openai",
      apiKey: "",
      baseUrl: "",
      dialect: "openai",
    };
    draft.value.providers.push(provider);
    selectedProviderId.value = id;
  }

  function removeProvider(id: string) {
    if (!draft.value) return;
    draft.value.providers = draft.value.providers.filter((p) => p.id !== id);
    delete modelOptionsByProvider[id];
    delete testResults[id];
    if (selectedProviderId.value === id) {
      selectedProviderId.value = draft.value.providers[0]?.id ?? "";
    }
  }

  function duplicateProvider(id: string) {
    if (!draft.value) return;
    const original = draft.value.providers.find((p) => p.id === id);
    if (!original) return;
    const newId = generateProviderId(draft.value.providers);
    const copy: ProviderConfig = { ...clone(original), id: newId, name: `${original.name} (副本)` };
    draft.value.providers.push(copy);
    selectedProviderId.value = newId;
  }

  async function testProvider(provider: ProviderConfig) {
    loading.test = true;
    try {
      const result = (await send("mio/config/test-provider", clone(provider))) as ProviderTestResult;
      testResults[provider.id] = result;
      if (result.ok) {
        message.success(`${provider.id} 连接成功${result.latencyMs ? ` (${result.latencyMs}ms)` : ""}`);
      } else {
        message.error(`${provider.id} 测试失败: ${result.message}`);
      }
    } catch (error) {
      message.error(`测试失败: ${formatError(error)}`);
    } finally {
      loading.test = false;
    }
  }

  async function loadModels(providerId: string) {
    if (!providerId) return;
    loading.listModels = true;
    try {
      const list = (await send("mio/config/list-models", providerId)) as string[];
      modelOptionsByProvider[providerId] = list;
    } catch (error) {
      message.error(`列出模型失败: ${formatError(error)}`);
    } finally {
      loading.listModels = false;
    }
  }

  function toggleApiKeyReveal(id: string) {
    apiKeyRevealed[id] = !apiKeyRevealed[id];
  }

  interface ModelSlot {
    path: string;
    label: string;
    description: string;
    kind: "chat" | "embedding";
    get: () => ModelConfig;
    set: (next: ModelConfig) => void;
  }

  const modelSlots = computed<ModelSlot[]>(() => {
    if (!draft.value) return [];
    const cfg = draft.value;
    const slots: ModelSlot[] = [
      {
        path: "models.chat",
        label: "对话模型",
        description: "主对话生成。",
        kind: "chat",
        get: () => cfg.models.chat,
        set: (v) => {
          cfg.models.chat = v;
        },
      },
    ];
    if (cfg.vision?.enabled) {
      slots.push({
        path: "models.vision",
        label: "图片理解",
        description: "多模态识图。",
        kind: "chat",
        get: () => cfg.models.vision,
        set: (v) => {
          cfg.models.vision = v;
        },
      });
    }
    if (cfg.memory?.enabled) {
      slots.push({
        path: "memory.embedding",
        label: "Embedding",
        description: "记忆向量化模型。",
        kind: "embedding",
        get: () => cfg.memory.embedding,
        set: (v) => {
          cfg.memory.embedding = v;
        },
      });
      slots.push({
        path: "memory.extraction",
        label: "记忆提取",
        description: "从对话提取记忆。",
        kind: "chat",
        get: () => cfg.memory.extraction,
        set: (v) => {
          cfg.memory.extraction = v;
        },
      });
      slots.push({
        path: "memory.distillation",
        label: "记忆蒸馏",
        description: "每日蒸馏关系/语义。",
        kind: "chat",
        get: () => cfg.memory.distillation,
        set: (v) => {
          cfg.memory.distillation = v;
        },
      });
    }
    if (cfg.search?.enabled) {
      slots.push({
        path: "search.compression",
        label: "搜索压缩",
        description: "压缩搜索结果到上下文。",
        kind: "chat",
        get: () => cfg.search.compression,
        set: (v) => {
          cfg.search.compression = v;
        },
      });
    }
    return slots;
  });

  return {
    draft,
    selectedProviderId,
    selectedProvider,
    saveState,
    saveStateText,
    loading,
    busyAction,
    isDirty,
    modelOptionsByProvider,
    testResults,
    apiKeyRevealed,
    modelSlots,
    isProviderReferenced,
    refresh,
    save,
    addProvider,
    removeProvider,
    duplicateProvider,
    testProvider,
    loadModels,
    toggleApiKeyReveal,
  };
}

export type ConfigStudioController = ReturnType<typeof useConfigStudio>;
