<template>
  <div class="slot" :class="{ 'slot--open': open, 'slot--nested': !!sublabel }">
    <button class="slot-row" type="button" :title="`${description}\n${path}`" :aria-expanded="open" @click="open = !open">
      <span class="slot-label">
        <span class="slot-name">{{ label }}</span>
        <span v-if="sublabel" class="slot-sub">{{ sublabel }}</span>
      </span>
      <span class="slot-model">
        <span v-if="problem" class="slot-problem">● {{ problem }}</span>
        <span v-else class="slot-model-name">{{ modelValue.modelName }}</span>
        <span v-if="selectedProvider" class="slot-provider">{{ selectedProvider.name || "未命名供应商" }}</span>
      </span>
      <span class="slot-summary">{{ summary }}</span>
      <ChevronRight :size="14" class="slot-chevron" />
    </button>

    <div v-if="open" class="slot-detail">
      <div class="detail-main">
        <label class="field">
          <span class="form-label">供应商</span>
          <select :value="modelValue.providerId" class="form-input" @change="updateProvider(($event.target as HTMLSelectElement).value)">
            <option v-if="!modelValue.providerId" value="" disabled>选择供应商</option>
            <option v-for="p in providers" :key="p.id" :value="p.id">
              {{ p.name || "未命名供应商" }} · {{ p.type === "openai" ? (p.dialect ?? "openai") : p.type }}
            </option>
          </select>
        </label>
        <label class="field">
          <span class="form-label">模型名</span>
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
        </label>
        <button
          class="btn"
          type="button"
          :disabled="!modelValue.providerId || loadingModels"
          @click="$emit('list-models', modelValue.providerId)"
        >
          <RotateCw :size="13" />
          <span>{{ loadingModels ? "拉取中" : "拉取列表" }}</span>
        </button>
      </div>

      <div v-if="kind !== 'embedding'" class="detail-params">
        <label v-if="selectedProvider?.type !== 'anthropic'" class="field">
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
        </label>

        <label class="field">
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
        </label>

        <label v-if="kind === 'agent'" class="field">
          <span class="form-label">缓存 TTL（分钟）</span>
          <input
            :value="(modelValue as AgentModelConfig).cacheTtlMinutes ?? ''"
            class="form-input"
            type="number"
            step="1"
            min="0"
            :placeholder="selectedProvider?.type === 'anthropic' ? '60' : '240'"
            @input="updateNumber('cacheTtlMinutes', ($event.target as HTMLInputElement).value)"
          />
          <span class="form-hint">空闲到快过期时睡前整理；anthropic 只能填 60</span>
        </label>

        <template v-if="availableModes.length > 1">
          <label class="field">
            <span class="form-label">推理模式</span>
            <select
              :value="reasoningMode"
              class="form-input"
              @change="updateReasoningMode(($event.target as HTMLSelectElement).value as ReasoningMode)"
            >
              <option v-for="m in availableModes" :key="m" :value="m">{{ modeLabel(m) }}</option>
            </select>
          </label>

          <label v-if="reasoningMode === 'effort' || effortOptional" class="field">
            <span class="form-label">Effort 等级</span>
            <select
              :value="effortOptional ? (modelValue.reasoning?.effort ?? '') : effortValue"
              class="form-input"
              @change="updateEffort(($event.target as HTMLSelectElement).value as ReasoningEffort | '')"
            >
              <option v-if="effortOptional" value="">不设</option>
              <option v-for="e in effortOptions" :key="e" :value="e">{{ e }}</option>
            </select>
          </label>

          <label v-if="reasoningMode === 'budget'" class="field">
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
          </label>
        </template>
      </div>

      <details v-if="kind === 'chat' && selectedProvider?.type === 'openai'" class="advanced">
        <summary class="advanced-summary">
          <ChevronRight :size="13" class="advanced-chevron" />
          <span>附加请求体（仅本槽位）</span>
        </summary>
        <textarea
          v-model="extraBodyText"
          class="form-input mono advanced-textarea"
          spellcheck="false"
          placeholder='{ "top_k": 40 }'
          @blur="commitExtraBody"
        />
        <span v-if="extraBodyError" class="advanced-error">{{ extraBodyError }}</span>
      </details>

      <div v-if="removable" class="detail-footer">
        <button class="btn btn--danger" type="button" @click="$emit('remove')">
          <Trash2 :size="13" />
          <span>删除这个群的覆盖</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, ref, watch } from "vue";
import { ChevronRight, RotateCw, Trash2 } from "lucide-vue-next";
import type {
  ModelConfig,
  ProviderConfig,
  ReasoningEffort,
  ReasoningMode,
} from "../../src/llm/provider";
import type { AgentModelConfig } from "../../src/agent/models";

const props = defineProps<{
  path: string;
  label: string;
  /** 群覆盖行在名称下方显示群 ID */
  sublabel?: string;
  description: string;
  /** agent：多一个缓存 TTL（AgentModelConfig.cacheTtlMinutes） */
  kind: "chat" | "embedding" | "agent";
  modelValue: ModelConfig;
  providers: ProviderConfig[];
  modelOptions: string[];
  loadingModels: boolean;
  removable?: boolean;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: ModelConfig): void;
  (event: "list-models", providerId: string): void;
  (event: "remove"): void;
}>();

const open = ref(false);

const selectedProvider = computed(() => props.providers.find((p) => p.id === props.modelValue.providerId) ?? null);

const datalistId = computed(() => `models-${props.path.replace(/\./g, "-")}`);

const reasoningMode = computed<ReasoningMode>(() => props.modelValue.reasoning?.mode ?? "auto");

/** 收起时要一眼看出没配完的槽位 */
const problem = computed(() => {
  if (!selectedProvider.value) return "未选供应商";
  if (!props.modelValue.modelName) return "未填模型名";
  return "";
});

const summary = computed(() => {
  if (props.kind === "embedding") return "";
  const m = props.modelValue;
  const parts: string[] = [];
  if (m.temperature !== undefined && selectedProvider.value?.type !== "anthropic") parts.push(`T ${m.temperature}`);
  if (m.maxTokens !== undefined) parts.push(String(m.maxTokens));
  const ttl = (m as AgentModelConfig).cacheTtlMinutes;
  if (props.kind === "agent" && ttl !== undefined) parts.push(`TTL ${ttl}`);
  if (availableModes.value.length > 1) {
    parts.push(reasoningMode.value);
    if (m.reasoning?.effort) parts.push(m.reasoning.effort);
    if (reasoningMode.value === "budget" && m.reasoning?.budgetTokens !== undefined) parts.push(`${m.reasoning.budgetTokens} tok`);
  }
  if (m.extraBody && Object.keys(m.extraBody).length) parts.push("+body");
  return parts.join(" · ");
});

const availableModes = computed<ReasoningMode[]>(() => {
  const provider = selectedProvider.value;
  if (!provider) return ["auto"];
  if (provider.type === "gemini") return ["auto", "off", "budget"];
  if (provider.type === "anthropic") return ["auto", "off", "effort"];
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
  if (!provider) return [];
  if (provider.type === "anthropic") {
    // 关思考（between_tools）时 effort 最高只能是 high；Anthropic 没有 minimal
    return reasoningMode.value === "off" ? ["low", "medium", "high"] : ["low", "medium", "high", "max"];
  }
  if (provider.type !== "openai") return [];
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

/** anthropic 关思考时 effort 可设可不设（output_config.effort） */
const effortOptional = computed(() => selectedProvider.value?.type === "anthropic" && reasoningMode.value === "off");

function updateEffort(value: ReasoningEffort | "") {
  if (value) {
    updateReasoningField("effort", value);
    return;
  }
  const reasoning = { ...(props.modelValue.reasoning ?? { mode: "off" as ReasoningMode }) };
  delete reasoning.effort;
  commit({ ...props.modelValue, reasoning });
}

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

function updateNumber(field: "temperature" | "maxTokens" | "cacheTtlMinutes", raw: string) {
  const trimmed = raw.trim();
  const next: ModelConfig & { cacheTtlMinutes?: number } = { ...props.modelValue };
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
.slot + .slot {
  border-top: 1px solid var(--c-border-light);
}

.slot-row {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr) auto 16px;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 44px;
  padding: 8px 14px 8px 16px;
  border: none;
  background: transparent;
  color: var(--c-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 150ms;
}

.slot-row:hover,
.slot--open .slot-row {
  background: var(--c-bg-soft);
}

.slot-row:focus-visible {
  outline: 2px solid var(--c-accent);
  outline-offset: -2px;
}

.slot-label {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.slot--nested .slot-label {
  padding-left: 12px;
  border-left: 2px solid var(--c-border-light);
}

.slot-name {
  font-weight: 500;
}

.slot-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--c-text-4);
}

.slot-model {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  overflow: hidden;
}

.slot-model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

.slot-problem {
  color: var(--c-danger);
  white-space: nowrap;
}

.slot-provider {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--c-text-4);
}

.slot-summary {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--c-text-4);
  white-space: nowrap;
}

.slot-chevron {
  color: var(--c-text-4);
  transition: transform 150ms;
}

.slot--open .slot-chevron {
  transform: rotate(90deg);
}

.slot-detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 42px 16px 148px;
  background: var(--c-bg-soft);
}

.detail-main {
  display: grid;
  grid-template-columns: minmax(0, 220px) minmax(0, 1fr) auto;
  gap: 10px;
  align-items: end;
}

.detail-params {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  align-items: start;
}

.field {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.field .form-hint {
  margin-top: 3px;
}

.advanced-summary {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  color: var(--c-text-2);
  list-style: none;
}

.advanced-summary::-webkit-details-marker {
  display: none;
}

.advanced-chevron {
  transition: transform 150ms;
}

.advanced[open] .advanced-chevron {
  transform: rotate(90deg);
}

.advanced-textarea {
  margin-top: 8px;
  min-height: 72px;
}

.advanced-error {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--c-danger);
}

.detail-footer {
  display: flex;
  justify-content: flex-end;
}

@media (max-width: 900px) {
  .slot-row {
    grid-template-columns: 96px minmax(0, 1fr) 16px;
  }
  .slot-summary {
    display: none;
  }
  .slot-detail {
    padding: 4px 16px 16px;
  }
  .detail-main {
    grid-template-columns: 1fr;
  }
  .detail-main .btn {
    justify-self: start;
  }
  .detail-params {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
