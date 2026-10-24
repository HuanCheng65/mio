<template>
  <div class="slot-card">
    <div class="slot-header">
      <div class="slot-title-block">
        <h3 class="slot-title">{{ label }}</h3>
        <span class="slot-desc">{{ description }}</span>
      </div>
      <span class="slot-path mono">{{ path }}</span>
    </div>

    <div class="form-group">
      <span class="form-label">供应商</span>
      <div v-if="providers.length === 0" class="provider-empty">先在上方添加一个供应商</div>
      <div v-else class="provider-chips" role="radiogroup" :aria-label="`${label} 供应商`">
        <button
          v-for="p in providers"
          :key="p.id"
          type="button"
          role="radio"
          :aria-checked="modelValue.providerId === p.id"
          class="provider-chip"
          :class="{ 'provider-chip--active': modelValue.providerId === p.id }"
          @click="updateProvider(p.id)"
        >
          <Check v-if="modelValue.providerId === p.id" :size="12" class="chip-check" />
          <span class="chip-name">{{ p.name || "未命名供应商" }}</span>
          <span class="chip-type">{{ p.type === 'openai' ? (p.dialect ?? 'openai') : 'gemini' }}</span>
        </button>
      </div>
    </div>

    <div class="slot-grid">
      <div class="form-group">
        <span class="form-label">
          <span>模型名称</span>
          <button
            class="btn btn--subtle slot-refresh"
            type="button"
            :disabled="!modelValue.providerId || loadingModels"
            @click="$emit('list-models', modelValue.providerId)"
          >
            <RotateCw :size="11" />
            <span>{{ loadingModels ? "拉取中" : "拉取列表" }}</span>
          </button>
        </span>
        <input
          :value="modelValue.modelName"
          class="form-input mono"
          type="text"
          :list="datalistId"
          :disabled="!modelValue.providerId"
          placeholder="model-name"
          @input="updateField('modelName', ($event.target as HTMLInputElement).value)"
        />
        <datalist :id="datalistId">
          <option v-for="name in modelOptions" :key="name" :value="name" />
        </datalist>
      </div>

      <template v-if="kind === 'chat'">
        <div class="form-group">
          <span class="form-label">Temperature</span>
          <input
            :value="modelValue.temperature ?? ''"
            class="form-input"
            type="number"
            step="0.1"
            min="0"
            max="2"
            placeholder="默认"
            @input="updateNumber('temperature', ($event.target as HTMLInputElement).value)"
          />
        </div>

        <div class="form-group">
          <span class="form-label">Max Tokens</span>
          <input
            :value="modelValue.maxTokens ?? ''"
            class="form-input"
            type="number"
            step="1"
            min="0"
            placeholder="默认"
            @input="updateNumber('maxTokens', ($event.target as HTMLInputElement).value)"
          />
        </div>

        <template v-if="availableModes.length > 1">
          <div class="form-group">
            <span class="form-label">推理模式</span>
            <select
              :value="reasoningMode"
              class="form-input"
              @change="updateReasoningMode(($event.target as HTMLSelectElement).value as ReasoningMode)"
            >
              <option v-for="m in availableModes" :key="m" :value="m">{{ modeLabel(m) }}</option>
            </select>
          </div>

          <div v-if="reasoningMode === 'effort'" class="form-group">
            <span class="form-label">Effort 等级</span>
            <select
              :value="effortValue"
              class="form-input"
              @change="updateReasoningField('effort', ($event.target as HTMLSelectElement).value as ReasoningEffort)"
            >
              <option v-for="e in effortOptions" :key="e" :value="e">{{ e }}</option>
            </select>
          </div>

          <div v-if="reasoningMode === 'budget'" class="form-group">
            <span class="form-label">Budget Tokens</span>
            <input
              :value="modelValue.reasoning?.budgetTokens ?? ''"
              class="form-input"
              type="number"
              step="1"
              min="0"
              placeholder="例如 8192"
              @input="updateReasoningBudget(($event.target as HTMLInputElement).value)"
            />
          </div>
        </template>
      </template>
    </div>

    <details v-if="kind === 'chat' && selectedProvider?.type === 'openai'" class="advanced">
      <summary class="advanced-summary">
        <ChevronRight :size="14" class="advanced-chevron" />
        <span>高级</span>
        <span class="advanced-hint">附加请求体（仅本槽位）</span>
      </summary>
      <div class="advanced-body">
        <textarea
          v-model="extraBodyText"
          class="form-input mono advanced-textarea"
          spellcheck="false"
          placeholder='{ "top_k": 40 }'
          @blur="commitExtraBody"
        />
        <span v-if="extraBodyError" class="advanced-error">{{ extraBodyError }}</span>
      </div>
    </details>
  </div>
</template>

<script lang="ts" setup>
import { computed, ref, watch } from "vue";
import { Check, ChevronRight, RotateCw } from "lucide-vue-next";
import type {
  ModelConfig,
  ProviderConfig,
  ReasoningEffort,
  ReasoningMode,
} from "../../src/llm/provider";

const props = defineProps<{
  path: string;
  label: string;
  description: string;
  kind: "chat" | "embedding";
  modelValue: ModelConfig;
  providers: ProviderConfig[];
  modelOptions: string[];
  loadingModels: boolean;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: ModelConfig): void;
  (event: "list-models", providerId: string): void;
}>();

const selectedProvider = computed(() => props.providers.find((p) => p.id === props.modelValue.providerId) ?? null);

const datalistId = computed(() => `models-${props.path.replace(/\./g, "-")}`);

const reasoningMode = computed<ReasoningMode>(() => props.modelValue.reasoning?.mode ?? "auto");

const availableModes = computed<ReasoningMode[]>(() => {
  const provider = selectedProvider.value;
  if (!provider) return ["auto"];
  if (provider.type === "gemini") return ["auto", "off", "budget"];
  const dialect = provider.dialect ?? "openai";
  switch (dialect) {
    case "openai":
    case "openrouter":
      return ["auto", "off", "effort"];
    case "qwen":
      return ["auto", "off", "budget"];
    case "deepseek":
      return ["auto", "off", "effort"];
    case "siliconflow":
      return ["auto", "budget"];
    case "custom":
    default:
      return ["auto"];
  }
});

const effortOptions = computed<ReasoningEffort[]>(() => {
  const provider = selectedProvider.value;
  if (!provider || provider.type !== "openai") return [];
  const dialect = provider.dialect ?? "openai";
  if (dialect === "deepseek") return ["high", "max"];
  if (dialect === "openai" || dialect === "openrouter") return ["minimal", "low", "medium", "high"];
  return [];
});

const effortValue = computed<ReasoningEffort>(() => {
  const current = props.modelValue.reasoning?.effort;
  const options = effortOptions.value;
  if (current && options.includes(current)) return current;
  return options[options.length - 1] ?? "high";
});

function modeLabel(m: ReasoningMode): string {
  switch (m) {
    case "auto":
      return "auto（不下发）";
    case "off":
      return "off（关闭思考）";
    case "effort":
      return "effort（按等级）";
    case "budget":
      return "budget（按预算）";
  }
}

function commit(next: ModelConfig) {
  emit("update:modelValue", next);
}

function updateProvider(value: string) {
  if (props.modelValue.providerId === value) return;
  // 切换 provider 时清空模型名和 reasoning（不同方言能力不同）
  const next: ModelConfig = {
    ...props.modelValue,
    providerId: value,
    modelName: "",
  };
  delete next.reasoning;
  commit(next);
}

function updateField<K extends keyof ModelConfig>(field: K, value: ModelConfig[K]) {
  commit({ ...props.modelValue, [field]: value });
}

function updateNumber(field: "temperature" | "maxTokens", raw: string) {
  const trimmed = raw.trim();
  const next = { ...props.modelValue };
  if (trimmed === "") {
    delete next[field];
  } else {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    next[field] = n;
  }
  commit(next);
}

function updateReasoningMode(mode: ReasoningMode) {
  const next = { ...props.modelValue };
  if (mode === "auto") {
    delete next.reasoning;
  } else {
    next.reasoning = { ...(next.reasoning ?? {}), mode };
  }
  commit(next);
}

function updateReasoningField<K extends "effort" | "budgetTokens">(field: K, value: any) {
  const next = { ...props.modelValue, reasoning: { ...(props.modelValue.reasoning ?? { mode: "auto" }), [field]: value } };
  commit(next);
}

function updateReasoningBudget(raw: string) {
  const trimmed = raw.trim();
  const reasoning = { ...(props.modelValue.reasoning ?? { mode: "budget" as ReasoningMode }) };
  if (trimmed === "") {
    delete reasoning.budgetTokens;
  } else {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    reasoning.budgetTokens = n;
  }
  commit({ ...props.modelValue, reasoning });
}

const extraBodyText = ref("");
const extraBodyError = ref("");

function syncExtraBodyText() {
  extraBodyText.value = props.modelValue.extraBody && Object.keys(props.modelValue.extraBody).length
    ? JSON.stringify(props.modelValue.extraBody, null, 2)
    : "";
  extraBodyError.value = "";
}

watch(() => [props.path, props.modelValue.providerId], syncExtraBodyText, { immediate: true });

function commitExtraBody() {
  const txt = extraBodyText.value.trim();
  const next = { ...props.modelValue };
  if (!txt) {
    delete next.extraBody;
    extraBodyError.value = "";
    commit(next);
    return;
  }
  try {
    const parsed = JSON.parse(txt);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      extraBodyError.value = "必须是 JSON 对象";
      return;
    }
    extraBodyError.value = "";
    next.extraBody = parsed;
    commit(next);
  } catch (e) {
    extraBodyError.value = (e as Error).message;
  }
}
</script>

<style scoped>
.slot-card {
  background: var(--c-bg-soft);
  border: 1px solid var(--c-border-light);
  border-radius: var(--radius-md);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.slot-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}

.slot-title-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.slot-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text);
}

.slot-desc {
  font-size: 11px;
  color: var(--c-text-4);
  line-height: 1.4;
}

.slot-path {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--c-bg);
  color: var(--c-text-4);
}

.mono {
  font-family: var(--font-mono);
}

.provider-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.provider-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--c-border);
  border-radius: 999px;
  background: var(--c-bg);
  color: var(--c-text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 150ms, border-color 150ms, color 150ms;
}

.provider-chip:hover {
  background: var(--c-bg-muted);
  color: var(--c-text);
}

.provider-chip--active {
  background: var(--c-accent-soft);
  border-color: var(--c-accent);
  color: var(--c-accent-active);
  font-weight: 600;
}

.provider-chip--active:hover {
  background: var(--c-accent-soft);
}

.chip-check {
  color: var(--c-accent);
}

.chip-type {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--c-bg-muted);
  color: var(--c-text-4);
  font-family: var(--font-mono);
  font-size: 10px;
}

.provider-chip--active .chip-type {
  background: rgba(13, 148, 136, 0.15);
  color: var(--c-accent-active);
}

.provider-empty {
  padding: 8px 10px;
  border: 1px dashed var(--c-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--c-text-4);
  text-align: center;
}

.slot-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.slot-refresh {
  font-size: 11px;
  padding: 2px 6px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.advanced {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-bg);
}

.advanced-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  font-weight: 500;
  color: var(--c-text-2);
}

.advanced-summary::-webkit-details-marker {
  display: none;
}

.advanced-chevron {
  transition: transform 150ms;
  color: var(--c-text-4);
}

.advanced[open] .advanced-chevron {
  transform: rotate(90deg);
}

.advanced-hint {
  margin-left: auto;
  color: var(--c-text-4);
  font-size: 11px;
  font-weight: 400;
}

.advanced-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 10px 10px;
}

.advanced-textarea {
  min-height: 70px;
  resize: vertical;
  font-size: 12px;
}

.advanced-error {
  font-size: 11px;
  color: var(--c-danger);
}

@media (max-width: 720px) {
  .slot-grid {
    grid-template-columns: 1fr;
  }
}
</style>
