<template>
  <k-layout>
    <div class="console-shell">
      <ConsoleSidebar
        :sections="sections"
        :active-section="activeSection"
        @select="activeSection = $event"
      />

      <main class="workspace">
        <header class="workspace-header">
          <h1 class="workspace-title">{{ activeSectionMeta.label }}</h1>
          <span class="workspace-spacer" />

          <template v-if="activeSection === 'config'">
            <span v-if="configSaveState !== 'idle'" class="save-state" :class="`save-state--${configSaveState}`">
              {{ configSaveStateText }}
            </span>
            <button
              v-if="configDirty"
              class="btn btn--text"
              type="button"
              :disabled="configLoading.save || configLoading.refresh"
              @click="discardConfig"
            >
              放弃
            </button>
            <button class="btn btn--primary" type="button" :disabled="!configDirty || configLoading.save" @click="saveConfig">
              {{ configLoading.save ? "保存中" : "保存" }}
            </button>
          </template>

          <button
            v-if="activeSection === 'persona'"
            class="btn btn--primary"
            type="button"
            @click="studio.openCreateDialog()"
          >
            <Plus :size="14" />
            <span>新建人设</span>
          </button>

          <button class="btn btn--icon" type="button" title="从服务器重新加载" aria-label="刷新" @click="refreshAll">
            <RefreshCw :size="14" />
          </button>
        </header>

        <div class="workspace-body">
          <ConfigStudioPanel v-if="activeSection === 'config'" :studio="config" />
          <PersonaStudioPanel v-else-if="activeSection === 'persona'" :studio="studio" />
          <RuntimeOverviewPanel v-else-if="activeSection === 'runtime'" :runtime="runtime" />
          <MaintenanceToolsPanel v-else :runtime="runtime" />
        </div>
      </main>
    </div>
  </k-layout>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from "vue";
import { Plus, RefreshCw } from "lucide-vue-next";
import { createConsoleSections, DEFAULT_CONSOLE_SECTION } from "./console-shell";
import { useConfigStudio } from "./composables/use-config-studio";
import { usePersonaStudio } from "./composables/use-persona-studio";
import { useRuntimeConsole } from "./composables/use-runtime-console";
import ConfigStudioPanel from "./components/config-studio-panel.vue";
import ConsoleSidebar from "./components/console-sidebar.vue";
import MaintenanceToolsPanel from "./components/maintenance-tools-panel.vue";
import PersonaStudioPanel from "./components/persona-studio-panel.vue";
import RuntimeOverviewPanel from "./components/runtime-overview-panel.vue";

const config = useConfigStudio();
const studio = usePersonaStudio();
const runtime = useRuntimeConsole();
const sections = createConsoleSections();
const activeSection = ref(DEFAULT_CONSOLE_SECTION);

const {
  isDirty: configDirty,
  saveState: configSaveState,
  saveStateText: configSaveStateText,
  loading: configLoading,
  save: saveConfig,
  refresh: refreshConfig,
} = config;
const { isDirty: personaDirty } = studio;

const activeSectionMeta = computed(() => {
  return sections.find((s) => s.id === activeSection.value) ?? sections[0];
});

function discardConfig() {
  if (!window.confirm("放弃未保存的模型配置改动？")) return;
  void refreshConfig();
}

/** 刷新会用服务器上的数据覆盖草稿，所以有未保存改动时先确认 */
async function refreshAll() {
  const unsaved = [configDirty.value && "模型配置", personaDirty.value && "人设内容"].filter(Boolean);
  if (unsaved.length && !window.confirm(`刷新会丢掉未保存的${unsaved.join("、")}改动，继续？`)) return;
  await Promise.all([config.refresh(), studio.refreshStudio(), runtime.refreshAll()]);
}

onMounted(() => {
  void Promise.all([config.refresh(), studio.refreshStudio(), runtime.refreshAll()]);
});
</script>

<style>
/* 颜色全部取自 Koishi 主题变量，亮/暗随控制台外壳切换 */
.console-shell {
  --c-accent: var(--k-color-primary);
  --c-accent-hover: var(--k-color-primary-shade);
  --c-accent-active: var(--k-color-primary);
  --c-accent-soft: var(--k-color-primary-fade);
  --c-accent-muted: color-mix(in srgb, var(--k-color-primary) 30%, transparent);

  --c-text: var(--k-text-dark);
  --c-text-2: var(--k-text-normal);
  --c-text-3: var(--k-text-normal);
  --c-text-4: var(--k-text-light);

  --c-bg: var(--k-card-bg);
  --c-bg-soft: var(--bg1);
  --c-bg-muted: var(--k-hover-bg);

  --c-border: var(--k-color-border);
  --c-border-light: var(--k-color-divider);

  --c-danger: var(--k-color-danger);
  --c-danger-soft: var(--k-color-danger-fade);

  --c-warning: var(--k-color-warning);
  --c-warning-soft: color-mix(in srgb, var(--k-color-warning) 12%, transparent);
  --c-success: var(--k-color-success);

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 8px;
  --radius-xl: 12px;

  --shadow-sm: none;

  --font-sans: system-ui, -apple-system, "Segoe UI", "Noto Sans SC", "PingFang SC", sans-serif;
  --font-mono: "JetBrains Mono", "Fira Code", "Menlo", monospace;

  color-scheme: light;
}
html.dark .console-shell {
  color-scheme: dark;
}

.console-shell *,
.console-shell *::before,
.console-shell *::after {
  box-sizing: border-box;
}

.console-shell .btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text);
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background 150ms, border-color 150ms, color 150ms;
}
.console-shell .btn:hover:not(:disabled) {
  background: var(--c-bg-muted);
}
.console-shell .btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.console-shell .btn:focus-visible {
  outline: 2px solid var(--c-accent);
  outline-offset: 1px;
}

.console-shell .btn--primary {
  background: var(--c-accent);
  border-color: var(--c-accent);
  color: #fff;
}
.console-shell .btn--primary:hover:not(:disabled) {
  background: var(--c-accent-hover);
  border-color: var(--c-accent-hover);
}

.console-shell .btn--danger {
  border-color: transparent;
  color: var(--c-danger);
}
.console-shell .btn--danger:hover:not(:disabled) {
  background: var(--c-danger-soft);
}

.console-shell .btn--text,
.console-shell .btn--subtle {
  border-color: transparent;
  color: var(--c-text-2);
}
.console-shell .btn--subtle {
  height: 24px;
  padding: 0 6px;
  font-size: 12px;
}
.console-shell .btn--text:hover:not(:disabled),
.console-shell .btn--subtle:hover:not(:disabled) {
  color: var(--c-text);
}

.console-shell .btn--icon {
  width: 28px;
  padding: 0;
}

.console-shell .form-label {
  display: block;
  font-size: 12px;
  font-weight: 400;
  color: var(--c-text-2);
  margin-bottom: 4px;
}
.console-shell .form-input {
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text);
  font-family: var(--font-sans);
  font-size: 13px;
  outline: none;
  transition: border-color 150ms;
}
.console-shell select.form-input {
  background: var(--c-bg);
}
.console-shell .form-input:focus {
  border-color: var(--c-accent);
}
.console-shell .form-input:disabled {
  opacity: 0.5;
}
.console-shell .form-input::placeholder {
  color: var(--c-text-4);
}
.console-shell textarea.form-input {
  height: auto;
  padding: 8px 10px;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
}
.console-shell .form-hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--c-text-4);
}
.console-shell .mono {
  font-family: var(--font-mono);
}

.console-shell .empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100px;
  padding: 16px;
  text-align: center;
  color: var(--c-text-4);
  font-size: 13px;
  border: 1px dashed var(--c-border-light);
  border-radius: var(--radius-md);
}
.console-shell .empty-state--sm {
  min-height: 56px;
}
</style>

<style scoped>
.console-shell {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--c-bg-soft);
  color: var(--c-text);
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.5;
}

.workspace {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workspace-header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 52px;
  padding: 0 24px;
  border-bottom: 1px solid var(--c-border-light);
  background: var(--c-bg);
  flex-shrink: 0;
}

.workspace-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--c-text);
}

.workspace-spacer {
  flex: 1;
}

.save-state {
  font-size: 12px;
  color: var(--c-text-4);
}
.save-state--dirty {
  color: var(--c-warning);
}
.save-state--failed {
  color: var(--c-danger);
}

.workspace-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 20px 24px 40px;
}

@media (max-width: 960px) {
  .console-shell {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }
}
</style>
