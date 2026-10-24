<template>
  <div class="config-pane">
    <div v-if="!draft" class="empty-state">正在加载配置…</div>

    <template v-else>
      <div v-if="draft.providers.length === 0" class="warn-banner">
        ⚠ 当前未配置任何供应商，运行时未启动。请先添加 Provider 并指定 chat 模型，保存后插件将自动恢复。
      </div>

      <div class="providers-grid">
        <div class="panel panel--list">
          <div class="panel-header">
            <h2 class="panel-title">供应商</h2>
            <span class="badge">{{ draft.providers.length }}</span>
          </div>

          <div v-if="draft.providers.length === 0" class="empty-state empty-state--sm">未配置供应商</div>
          <div v-else class="provider-list">
            <button
              v-for="p in draft.providers"
              :key="p.id"
              class="provider-row"
              :class="{ 'provider-row--active': p.id === selectedProviderId }"
              type="button"
              @click="selectedProviderId = p.id"
            >
              <span class="provider-row__head">
                <strong>{{ p.name || "未命名供应商" }}</strong>
                <span
                  v-if="testResults[p.id]"
                  class="status-dot"
                  :class="testResults[p.id].ok ? 'status-dot--ok' : 'status-dot--err'"
                  :title="testResults[p.id].ok ? '上次测试：成功' : `上次测试：${testResults[p.id].message}`"
                />
              </span>
              <span class="provider-row__meta">
                <span class="tag">{{ p.type }}</span>
                <span v-if="isProviderReferenced(p.id)" class="tag tag--info">使用中</span>
              </span>
            </button>
          </div>

          <button class="btn btn--ghost provider-add" type="button" @click="addProvider">
            <Plus :size="14" />
            <span>添加供应商</span>
          </button>
        </div>

        <div class="panel panel--editor">
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

      <div class="panel panel--slots">
        <div class="panel-header">
          <h2 class="panel-title">模型槽位</h2>
          <span class="hint">仅显示已启用的模块；模型名可手填或从拉取的列表中选择</span>
        </div>

        <div v-if="modelSlots.length === 0" class="empty-state empty-state--sm">没有需要配置的模型槽位</div>
        <div v-else class="slots-grid">
          <ModelSlotEditor
            v-for="slot in modelSlots"
            :key="slot.path"
            :path="slot.path"
            :label="slot.label"
            :description="slot.description"
            :kind="slot.kind"
            :model-value="slot.get()"
            :providers="draft.providers"
            :model-options="modelOptionsByProvider[slot.get().providerId] ?? []"
            :loading-models="loading.listModels"
            @update:model-value="slot.set($event)"
            @list-models="loadModels($event)"
          />
        </div>
      </div>

      <div class="save-bar">
        <span class="status-badge" :class="`status-badge--${saveState}`">{{ saveStateText }}</span>
        <span class="save-bar__spacer" />
        <button class="btn btn--ghost" type="button" :disabled="!isDirty || loading.save || loading.refresh" @click="refresh">
          <RotateCcw :size="14" />
          <span>放弃改动</span>
        </button>
        <button class="btn btn--primary" type="button" :disabled="!isDirty || loading.save" @click="save">
          <Save :size="14" />
          <span>{{ loading.save ? "保存中" : "保存配置" }}</span>
        </button>
      </div>
    </template>
  </div>
</template>

<script lang="ts" setup>
import { Plus, RotateCcw, Save } from "lucide-vue-next";
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
  saveState,
  saveStateText,
  loading,
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
} = props.studio;
</script>

<style scoped>
.config-pane {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  flex: 1;
}

.warn-banner {
  padding: 10px 14px;
  border-radius: var(--radius-md);
  background: rgba(245, 158, 11, 0.12);
  color: #92400e;
  font-size: 13px;
  line-height: 1.5;
  border: 1px solid rgba(245, 158, 11, 0.25);
}

.providers-grid {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 16px;
}

.panel {
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
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

.hint {
  font-size: 11px;
  color: var(--c-text-4);
}

.badge {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--c-bg-muted);
  color: var(--c-text-3);
  font-size: 12px;
  font-weight: 500;
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

.provider-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow-y: auto;
}

.provider-row {
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  font: inherit;
  cursor: pointer;
  transition: background 150ms, border-color 150ms;
}

.provider-row:hover {
  background: var(--c-bg-muted);
}

.provider-row--active {
  background: var(--c-accent-soft);
  border-color: var(--c-accent-muted);
}

.provider-row__head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--c-text);
}

.provider-row__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-left: auto;
}

.status-dot--ok {
  background: #10b981;
}

.status-dot--err {
  background: var(--c-danger);
}

.provider-add {
  align-self: flex-start;
}

.slots-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.status-badge {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
  background: var(--c-bg-muted);
  color: var(--c-text-3);
}

.status-badge--dirty {
  background: rgba(245, 158, 11, 0.1);
  color: #b45309;
}

.status-badge--saving {
  background: var(--c-accent-soft);
  color: var(--c-accent-hover);
}

.status-badge--failed {
  background: var(--c-danger-soft);
  color: var(--c-danger);
}

.save-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}

.save-bar__spacer {
  flex: 1;
}

@media (max-width: 1100px) {
  .providers-grid {
    grid-template-columns: 1fr;
  }
  .slots-grid {
    grid-template-columns: 1fr;
  }
}
</style>
