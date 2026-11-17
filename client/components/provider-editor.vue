<template>
  <div class="provider-editor">
    <div class="editor-head">
      <h3 class="editor-title">{{ provider.name || "未命名供应商" }}</h3>
      <span v-if="idLocked" class="tag">使用中</span>
    </div>

    <div class="form">
      <span class="form-key">名称</span>
      <input v-model.trim="provider.name" class="form-input" type="text" placeholder="例如：DeepSeek 主线" />

      <span class="form-key">类型</span>
      <div class="pair">
        <select v-model="provider.type" class="form-input">
          <option value="openai">OpenAI 兼容</option>
          <option value="gemini">Google Gemini</option>
          <option value="anthropic">Anthropic（仅 agent）</option>
        </select>
        <template v-if="provider.type === 'openai'">
          <span class="form-key">方言</span>
          <select
            v-model="provider.dialect"
            class="form-input"
            title="控制推理字段如何翻译到具体协议；不在列表里的请用“其它”并手填 extraBody"
          >
            <option value="openai">OpenAI 官方 (reasoning_effort)</option>
            <option value="openrouter">OpenRouter (reasoning_effort)</option>
            <option value="qwen">Qwen / DashScope (enable_thinking)</option>
            <option value="deepseek">DeepSeek (thinking + reasoning_effort)</option>
            <option value="siliconflow">SiliconFlow (thinking_budget)</option>
            <option value="custom">其它（仅走 extraBody）</option>
          </select>
        </template>
      </div>

      <span class="form-key">API Key</span>
      <div class="key-row">
        <input
          v-model.trim="provider.apiKey"
          class="form-input mono"
          :type="revealed ? 'text' : 'password'"
          placeholder="sk-..."
          autocomplete="off"
          spellcheck="false"
        />
        <button class="btn btn--icon" type="button" :title="revealed ? '隐藏' : '显示'" @click="$emit('toggle-reveal')">
          <component :is="revealed ? EyeOff : Eye" :size="14" />
        </button>
      </div>

      <template v-if="provider.type === 'openai'">
        <span class="form-key">Base URL</span>
        <input v-model.trim="provider.baseUrl" class="form-input mono" type="text" placeholder="https://api.deepseek.com" />
      </template>

      <template v-if="provider.type === 'anthropic'">
        <span class="form-key">HTTP 代理</span>
        <input
          :value="provider.proxyUrl ?? ''"
          class="form-input mono"
          type="text"
          placeholder="http://127.0.0.1:7890"
          @input="setProxyUrl"
        />
        <span class="form-hint">服务器直连 Anthropic 会被按地区拒绝（403），填本机代理地址；留空表示直连</span>
      </template>

      <template v-if="provider.type !== 'gemini'">
        <span class="form-key">agent 发图</span>
        <div class="pair">
          <select :value="provider.images?.transport ?? ''" class="form-input" @change="setTransport">
            <option value="">未配置（agent 不能用这个供应商）</option>
            <option v-if="provider.type === 'openai'" value="deepseek-files">DeepSeek Files API（每张图只传一次）</option>
            <option v-if="provider.type === 'anthropic'" value="anthropic-files">Anthropic Files API（每张图只传一次）</option>
            <option value="inline">内联 base64（每步随请求上传）</option>
          </select>
          <template v-if="provider.images?.transport">
            <span class="form-key">缩图像素</span>
            <input v-model.number="provider.images.maxPixels" class="form-input mono" type="number" placeholder="1690000" />
          </template>
        </div>
        <span v-if="provider.images?.transport" class="form-hint">
          缩图像素填供应商服务端自己的缩放目标：DeepSeek 是 1300×1300 = 1690000；Claude 4.7 及以后最多约 3750000（长边 2576），填小些更省
        </span>
      </template>

      <template v-if="provider.type !== 'gemini' && provider.images?.transport === 'inline'">
        <span class="form-key">内联预算 MiB</span>
        <input v-model.number="provider.images.inlineBudgetMiB" class="form-input mono narrow" type="number" placeholder="32" />
        <span class="form-hint">一段 log 的图片超过这个量就睡前整理，要低于供应商的请求体上限（Claude 是 128 MB，base64 再大三分之一）</span>
      </template>
    </div>

    <details v-if="provider.type === 'openai'" class="advanced">
      <summary class="advanced-summary">
        <ChevronRight :size="13" class="advanced-chevron" />
        <span>高级：附加请求头 / 请求体</span>
      </summary>
      <div class="form advanced-body">
        <span class="form-key">Headers</span>
        <textarea
          v-model="extraHeadersText"
          class="form-input mono advanced-textarea"
          spellcheck="false"
          placeholder='{ "X-Foo": "bar" }'
          @blur="commitExtraHeaders"
        />
        <span v-if="extraHeadersError" class="form-hint advanced-error">{{ extraHeadersError }}</span>

        <span class="form-key">请求体</span>
        <textarea
          v-model="extraBodyText"
          class="form-input mono advanced-textarea"
          spellcheck="false"
          placeholder='{ "top_k": 40 }'
          @blur="commitExtraBody"
        />
        <span v-if="extraBodyError" class="form-hint advanced-error">{{ extraBodyError }}</span>
        <span class="form-hint">每次请求都会合入；模型槽位的 extraBody 会覆盖此处同名键</span>
      </div>
    </details>

    <div class="editor-toolbar">
      <button class="btn" type="button" :disabled="testing || !provider.apiKey" @click="$emit('test', provider)">
        <Plug :size="13" />
        <span>{{ testing ? "测试中" : "测试连接" }}</span>
      </button>
      <button class="btn" type="button" @click="$emit('duplicate', provider.id)">
        <Copy :size="13" />
        <span>克隆</span>
      </button>
      <span
        v-if="testResult"
        class="test-result"
        :class="testResult.ok ? 'test-result--ok' : 'test-result--err'"
        :title="testResult.ok ? '' : testResult.message"
      >
        {{ testResult.ok ? `✓ 连接成功${testResult.latencyMs ? ` · ${testResult.latencyMs}ms` : ""}` : `✗ ${testResult.message}` }}
      </span>
      <span class="toolbar-spacer" />
      <button
        class="btn btn--danger"
        type="button"
        :disabled="idLocked"
        :title="idLocked ? '已被模型槽位引用，请先把槽位指向其他供应商' : ''"
        @click="$emit('remove', provider.id)"
      >
        <Trash2 :size="13" />
        <span>删除</span>
      </button>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, watch } from "vue";
import { ChevronRight, Copy, Eye, EyeOff, Plug, Trash2 } from "lucide-vue-next";
import type { ImageTransportKind, ProviderConfig } from "../../src/llm/provider";
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

function setTransport(event: Event) {
  const transport = (event.target as HTMLSelectElement).value as ImageTransportKind | "";
  if (!transport) {
    delete (props.provider as any).images;
    return;
  }
  props.provider.images = { ...props.provider.images, transport };
}

function setProxyUrl(event: Event) {
  const url = (event.target as HTMLInputElement).value.trim();
  if (url) props.provider.proxyUrl = url;
  else delete (props.provider as any).proxyUrl;
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
  gap: 16px;
}

.editor-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.editor-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text);
}

.tag {
  padding: 0 6px;
  border-radius: 4px;
  background: var(--c-accent-soft);
  color: var(--c-accent);
  font-size: 11px;
}

.form {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 10px 14px;
  align-items: center;
}

.form-key {
  font-size: 12px;
  color: var(--c-text-2);
  white-space: nowrap;
}

.form > .form-hint {
  grid-column: 2;
  margin-top: -4px;
}

.pair {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  gap: 10px;
  align-items: center;
}

.pair > :only-child {
  grid-column: 1 / -1;
}

.narrow {
  max-width: 160px;
}

.key-row {
  display: flex;
  gap: 6px;
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

.advanced-body {
  margin-top: 10px;
  align-items: start;
}

.advanced-body .form-key {
  padding-top: 8px;
}

.advanced-textarea {
  min-height: 72px;
}

.advanced-error {
  color: var(--c-danger);
}

.editor-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding-top: 14px;
  border-top: 1px solid var(--c-border-light);
}

.toolbar-spacer {
  flex: 1;
}

.test-result {
  min-width: 0;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.test-result--ok {
  color: var(--c-success);
}

.test-result--err {
  color: var(--c-danger);
}
</style>
