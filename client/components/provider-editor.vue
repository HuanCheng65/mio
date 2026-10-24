<template>
  <div class="provider-editor">
    <div class="panel-header">
      <h2 class="panel-title">{{ provider.name || "未命名供应商" }}</h2>
      <span v-if="idLocked" class="tag tag--info">使用中</span>
    </div>

    <div class="form-grid">
      <div class="form-group">
        <span class="form-label">显示名称</span>
        <input
          v-model.trim="provider.name"
          class="form-input"
          type="text"
          placeholder="例如：DeepSeek 主线"
        />
      </div>

      <div class="form-group">
        <span class="form-label">类型</span>
        <select v-model="provider.type" class="form-input">
          <option value="openai">OpenAI 兼容</option>
          <option value="gemini">Google Gemini</option>
        </select>
      </div>

      <div v-if="provider.type === 'openai'" class="form-group">
        <span class="form-label">方言</span>
        <select v-model="provider.dialect" class="form-input">
          <option value="openai">OpenAI 官方 (reasoning_effort)</option>
          <option value="openrouter">OpenRouter (reasoning_effort)</option>
          <option value="qwen">Qwen / DashScope (enable_thinking)</option>
          <option value="deepseek">DeepSeek (thinking + reasoning_effort)</option>
          <option value="siliconflow">SiliconFlow (thinking_budget)</option>
          <option value="custom">其它（仅走 extraBody）</option>
        </select>
        <span class="form-hint">控制推理字段如何翻译到具体协议；不在列表里的请用"其它"并手填 extraBody</span>
      </div>

      <div class="form-group form-group--wide">
        <span class="form-label">API Key</span>
        <div class="key-row">
          <input
            v-model.trim="provider.apiKey"
            class="form-input mono"
            :type="revealed ? 'text' : 'password'"
            placeholder="sk-..."
            autocomplete="off"
            spellcheck="false"
          />
          <button
            class="btn btn--ghost"
            type="button"
            :title="revealed ? '隐藏' : '显示'"
            @click="$emit('toggle-reveal')"
          >
            <component :is="revealed ? EyeOff : Eye" :size="14" />
          </button>
        </div>
      </div>

      <div v-if="provider.type === 'openai'" class="form-group form-group--wide">
        <span class="form-label">Base URL</span>
        <input
          v-model.trim="provider.baseUrl"
          class="form-input mono"
          type="text"
          placeholder="https://api.deepseek.com"
        />
      </div>
    </div>

    <details v-if="provider.type === 'openai'" class="advanced">
      <summary class="advanced-summary">
        <ChevronRight :size="14" class="advanced-chevron" />
        <span>高级</span>
        <span class="advanced-hint">附加请求头 / 请求体</span>
      </summary>
      <div class="advanced-body">
        <div class="form-group">
          <span class="form-label">附加 Headers</span>
          <textarea
            v-model="extraHeadersText"
            class="form-input mono advanced-textarea"
            spellcheck="false"
            placeholder='{ "X-Foo": "bar" }'
            @blur="commitExtraHeaders"
          />
          <span v-if="extraHeadersError" class="advanced-error">{{ extraHeadersError }}</span>
        </div>

        <div class="form-group">
          <span class="form-label">附加请求体</span>
          <textarea
            v-model="extraBodyText"
            class="form-input mono advanced-textarea"
            spellcheck="false"
            placeholder='{ "top_k": 40 }'
            @blur="commitExtraBody"
          />
          <span v-if="extraBodyError" class="advanced-error">{{ extraBodyError }}</span>
          <span class="form-hint">每次请求都会合入；模型槽位的 extraBody 会覆盖此处同名键</span>
        </div>
      </div>
    </details>

    <div class="editor-toolbar">
      <button
        class="btn btn--ghost"
        type="button"
        :disabled="testing || !provider.apiKey"
        @click="$emit('test', provider)"
      >
        <Plug :size="14" />
        <span>{{ testing ? "测试中" : "测试连接" }}</span>
      </button>
      <button class="btn btn--ghost" type="button" @click="$emit('duplicate', provider.id)">
        <Copy :size="14" />
        <span>克隆</span>
      </button>
      <span class="toolbar-spacer" />
      <button
        class="btn btn--danger"
        type="button"
        :disabled="idLocked"
        :title="idLocked ? '已被模型槽位引用，请先把槽位指向其他供应商' : ''"
        @click="$emit('remove', provider.id)"
      >
        <Trash2 :size="14" />
        <span>删除</span>
      </button>
    </div>

    <div v-if="testResult" class="test-result" :class="testResult.ok ? 'test-result--ok' : 'test-result--err'">
      <span v-if="testResult.ok">✓ 连接成功{{ testResult.latencyMs ? ` · ${testResult.latencyMs}ms` : "" }}</span>
      <span v-else>✗ {{ testResult.message }}</span>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, watch } from "vue";
import { ChevronRight, Copy, Eye, EyeOff, Plug, Trash2 } from "lucide-vue-next";
import type { ProviderConfig } from "../../src/llm/provider";
import type { ProviderTestResult } from "../../src/console/config-service";

const props = defineProps<{
  provider: ProviderConfig;
  idLocked: boolean;
  testResult: ProviderTestResult | null;
  testing: boolean;
  revealed: boolean;
}>();

defineEmits<{
  (event: "test", provider: ProviderConfig): void;
  (event: "duplicate", id: string): void;
  (event: "remove", id: string): void;
  (event: "toggle-reveal"): void;
}>();

const extraHeadersText = ref("");
const extraHeadersError = ref("");
const extraBodyText = ref("");
const extraBodyError = ref("");

function syncTextFromProvider() {
  extraHeadersText.value = props.provider.extraHeaders && Object.keys(props.provider.extraHeaders).length
    ? JSON.stringify(props.provider.extraHeaders, null, 2)
    : "";
  extraHeadersError.value = "";
  extraBodyText.value = props.provider.extraBody && Object.keys(props.provider.extraBody).length
    ? JSON.stringify(props.provider.extraBody, null, 2)
    : "";
  extraBodyError.value = "";
}

watch(() => props.provider.id, syncTextFromProvider, { immediate: true });

function parseJsonObject(raw: string): Record<string, any> | null | string {
  const txt = raw.trim();
  if (!txt) return null;
  try {
    const parsed = JSON.parse(txt);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "必须是 JSON 对象";
    }
    return parsed;
  } catch (e) {
    return (e as Error).message;
  }
}

function commitExtraHeaders() {
  const result = parseJsonObject(extraHeadersText.value);
  if (typeof result === "string") {
    extraHeadersError.value = result;
    return;
  }
  extraHeadersError.value = "";
  if (result === null) {
    delete (props.provider as any).extraHeaders;
  } else {
    const stringified: Record<string, string> = {};
    for (const [k, v] of Object.entries(result)) {
      stringified[k] = String(v);
    }
    props.provider.extraHeaders = stringified;
  }
}

function commitExtraBody() {
  const result = parseJsonObject(extraBodyText.value);
  if (typeof result === "string") {
    extraBodyError.value = result;
    return;
  }
  extraBodyError.value = "";
  if (result === null) {
    delete (props.provider as any).extraBody;
  } else {
    props.provider.extraBody = result;
  }
}
</script>

<style scoped>
.provider-editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  min-height: 0;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.panel-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text);
}

.tag {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--c-accent-soft);
  color: var(--c-accent-active);
  font-size: 11px;
  font-weight: 600;
}

.tag--info {
  background: rgba(245, 158, 11, 0.12);
  color: #b45309;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group--wide {
  grid-column: 1 / -1;
}

.form-hint {
  font-size: 11px;
  color: var(--c-text-4);
  line-height: 1.4;
}

.mono {
  font-family: var(--font-mono);
}

.key-row {
  display: flex;
  gap: 6px;
}

.key-row .form-input {
  flex: 1;
}

.advanced {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-bg-soft);
}

.advanced-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
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
  gap: 12px;
  padding: 0 12px 12px;
}

.advanced-textarea {
  min-height: 80px;
  resize: vertical;
  font-size: 12px;
}

.advanced-error {
  font-size: 11px;
  color: var(--c-danger);
}

.editor-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.toolbar-spacer {
  flex: 1;
}

.test-result {
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.5;
}

.test-result--ok {
  background: var(--c-accent-soft);
  color: var(--c-accent-active);
}

.test-result--err {
  background: var(--c-danger-soft);
  color: var(--c-danger);
}
</style>
