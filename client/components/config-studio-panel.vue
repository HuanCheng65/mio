<template>
  <div class="config-pane">
    <div v-if="!draft" class="empty-state">正在加载配置…</div>

    <template v-else>
      <div v-if="draft.providers.length === 0" class="warn-banner">
        当前未配置任何供应商，运行时未启动。请先添加供应商并指定对话模型，保存后插件将自动恢复。
      </div>

      <section class="section">
        <h2 class="section-title">
          模型槽位
          <small>只列出已启用模块的槽位；点一行展开编辑</small>
        </h2>
        <div class="card">
          <ModelSlotEditor
            v-for="slot in baseSlots"
            :key="slot.path"
            v-bind="slotProps(slot)"
            @update:model-value="slot.set($event)"
            @list-models="loadModels($event)"
          />
          <div class="group-heading">按群覆盖 agent 模型</div>
          <ModelSlotEditor
            v-for="slot in groupSlots"
            :key="slot.path"
            v-bind="slotProps(slot)"
            label="群"
            :sublabel="slot.path.slice(GROUP_PATH_PREFIX.length)"
            removable
            @update:model-value="slot.set($event)"
            @list-models="loadModels($event)"
            @remove="slot.remove?.()"
          />
          <div class="group-add">
            <input
              v-model.trim="newGroupId"
              class="form-input mono"
              type="text"
              placeholder="群 ID，形如 qq:&lt;32 位十六进制&gt;"
              @keydown.enter="addGroup"
            />
            <button class="btn" type="button" :disabled="!newGroupId" @click="addGroup">
              <Plus :size="13" />
              <span>添加</span>
            </button>
          </div>
        </div>
      </section>

      <section class="section">
        <h2 class="section-title">
          供应商
          <small>{{ draft.providers.length }} 个</small>
        </h2>
        <div class="card providers">
          <div class="provider-list">
            <button
              v-for="p in draft.providers"
              :key="p.id"
              class="provider-row"
              :class="{ 'provider-row--active': p.id === selectedProviderId }"
              type="button"
              @click="selectedProviderId = p.id"
            >
              <span
                class="status-dot"
                :class="testResults[p.id] ? (testResults[p.id].ok ? 'status-dot--ok' : 'status-dot--err') : ''"
                :title="testResults[p.id] ? (testResults[p.id].ok ? '上次测试：成功' : `上次测试：${testResults[p.id].message}`) : '未测试'"
              />
              <span class="provider-row__name">{{ p.name || "未命名供应商" }}</span>
              <span class="provider-row__type">{{ p.type }}</span>
            </button>
            <button class="provider-add" type="button" @click="addProvider">
              <Plus :size="13" />
              <span>添加供应商</span>
            </button>
          </div>

          <div class="provider-editor-pane">
            <ProviderEditor
              v-if="selectedProvider"
              :provider="selectedProvider"
              :id-locked="isProviderReferenced(selectedProvider.id)"
              :test-result="testResults[selectedProvider.id] ?? null"
              :testing="loading.test"
              :revealed="!!apiKeyRevealed[selectedProvider.id]"
              @test="testProvider($event)"
              @duplicate="duplicateProvider($event)"
              @remove="removeProvider($event)"
              @toggle-reveal="toggleApiKeyReveal(selectedProvider.id)"
            />
            <div v-else class="empty-state">选择或添加一个供应商以编辑</div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<script lang="ts" setup>
import { computed, ref } from "vue";
import { Plus } from "lucide-vue-next";
import ProviderEditor from "./provider-editor.vue";
import ModelSlotEditor from "./model-slot-editor.vue";
import type { ConfigStudioController } from "../composables/use-config-studio";

const props = defineProps<{
  studio: ConfigStudioController;
}>();

const {
  draft,
  selectedProviderId,
  selectedProvider,
  loading,
  modelOptionsByProvider,
  testResults,
  apiKeyRevealed,
  modelSlots,
  isProviderReferenced,
  addProvider,
  removeProvider,
  duplicateProvider,
  testProvider,
  loadModels,
  addGroupModel,
  toggleApiKeyReveal,
} = props.studio;

const GROUP_PATH_PREFIX = "agent.groupModels.";

type Slot = (typeof modelSlots.value)[number];

const baseSlots = computed(() => modelSlots.value.filter((s) => !s.remove));
const groupSlots = computed(() => modelSlots.value.filter((s) => s.remove));

function slotProps(slot: Slot) {
  const value = slot.get();
  return {
    path: slot.path,
    label: slot.label,
    description: slot.description,
    kind: slot.kind,
    modelValue: value,
    providers: draft.value!.providers,
    modelOptions: modelOptionsByProvider[value.providerId] ?? [],
    loadingModels: loading.listModels,
  };
}

const newGroupId = ref("");

function addGroup() {
  addGroupModel(newGroupId.value);
  newGroupId.value = "";
}
</script>

<style scoped>
.config-pane {
  display: flex;
  flex-direction: column;
  gap: 28px;
  max-width: 1180px;
}

.warn-banner {
  padding: 10px 14px;
  border-radius: var(--radius-md);
  background: var(--c-warning-soft);
  color: var(--c-warning);
  font-size: 13px;
}

.section-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text);
}

.section-title small {
  font-size: 12px;
  font-weight: 400;
  color: var(--c-text-4);
}

.card {
  background: var(--c-bg);
  border: 1px solid var(--c-border-light);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.group-heading {
  padding: 6px 16px;
  border-top: 1px solid var(--c-border-light);
  border-bottom: 1px solid var(--c-border-light);
  background: var(--c-bg-soft);
  font-size: 11px;
  color: var(--c-text-4);
}

.group-add {
  display: flex;
  gap: 8px;
  padding: 10px 16px 10px 30px;
  border-top: 1px solid var(--c-border-light);
}

.group-add .form-input {
  max-width: 420px;
}

.providers {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
}

.provider-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px;
  border-right: 1px solid var(--c-border-light);
}

.provider-row,
.provider-add {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 150ms;
}

.provider-row:hover,
.provider-add:hover {
  background: var(--c-bg-muted);
}

.provider-row--active,
.provider-row--active:hover {
  background: var(--c-accent-soft);
}

.provider-row__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-row__type {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--c-text-4);
}

.provider-add {
  color: var(--c-text-2);
  font-size: 12px;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: transparent;
}

.status-dot--ok {
  background: var(--c-success);
}

.status-dot--err {
  background: var(--c-danger);
}

.provider-editor-pane {
  min-width: 0;
  padding: 16px 20px;
}

@media (max-width: 900px) {
  .providers {
    grid-template-columns: 1fr;
  }
  .provider-list {
    border-right: none;
    border-bottom: 1px solid var(--c-border-light);
  }
}
</style>
