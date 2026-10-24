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
          <div>
            <h1 class="workspace-title">{{ activeSectionMeta.label }}</h1>
            <p class="workspace-desc">{{ activeSectionMeta.description }}</p>
          </div>
          <div class="workspace-actions">
            <button class="btn btn--ghost" type="button" @click="refreshAll">
              <RefreshCw :size="15" />
              <span>刷新</span>
            </button>
            <button
              v-if="activeSection === 'persona'"
              class="btn btn--primary"
              type="button"
              @click="studio.openCreateDialog()"
            >
              <Plus :size="15" />
              <span>新建人设</span>
            </button>
          </div>
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

const activeSectionMeta = computed(() => {
  return sections.find((s) => s.id === activeSection.value) ?? sections[0];
});

async function refreshAll() {
  await Promise.all([config.refresh(), studio.refreshStudio(), runtime.refreshAll()]);
}

onMounted(() => {
  void refreshAll();
});
</script>

<style>
.console-shell {
  --c-accent: #0d9488;
  --c-accent-hover: #0f766e;
  --c-accent-active: #115e59;
  --c-accent-soft: rgba(13, 148, 136, 0.08);
  --c-accent-muted: rgba(13, 148, 136, 0.15);

  --c-text: #1e293b;
  --c-text-2: #475569;
  --c-text-3: #64748b;
  --c-text-4: #94a3b8;

  --c-bg: #ffffff;
  --c-bg-soft: #f8fafc;
  --c-bg-muted: #f1f5f9;

  --c-border: #e2e8f0;
  --c-border-light: rgba(226, 232, 240, 0.6);

  --c-danger: #e11d48;
  --c-danger-hover: #be123c;
  --c-danger-soft: rgba(225, 29, 72, 0.08);

  --c-warning-soft: rgba(245, 158, 11, 0.08);

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 10px;
  --radius-xl: 12px;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);

  --font-sans: system-ui, -apple-system, "Segoe UI", "Noto Sans SC", "PingFang SC", sans-serif;
  --font-mono: "Fira Code", "JetBrains Mono", "Menlo", monospace;
}

.console-shell .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text-2);
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  cursor: pointer;
  white-space: nowrap;
  transition: background 150ms, border-color 150ms, color 150ms, box-shadow 150ms;
}
.console-shell .btn:active:not(:disabled) {
  transform: translateY(1px);
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

.console-shell .btn--ghost {
  background: var(--c-bg-soft);
  border-color: var(--c-border);
  color: var(--c-text-2);
}
.console-shell .btn--ghost:hover:not(:disabled) {
  background: var(--c-bg-muted);
  color: var(--c-text);
}

.console-shell .btn--danger {
  background: var(--c-danger);
  border-color: var(--c-danger);
  color: #fff;
}
.console-shell .btn--danger:hover:not(:disabled) {
  background: var(--c-danger-hover);
  border-color: var(--c-danger-hover);
}

.console-shell .btn--subtle {
  padding: 4px 8px;
  color: var(--c-text-3);
  font-size: 12px;
}
.console-shell .btn--subtle:hover:not(:disabled) {
  background: var(--c-bg-muted);
  color: var(--c-text-2);
}

.console-shell .form-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--c-text-3);
  margin-bottom: 6px;
}
.console-shell .form-input {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-bg);
  color: var(--c-text);
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.5;
  outline: none;
  transition: border-color 150ms, box-shadow 150ms;
}
.console-shell .form-input:focus {
  border-color: var(--c-accent);
  box-shadow: 0 0 0 3px var(--c-accent-soft);
}
.console-shell .form-input::placeholder {
  color: var(--c-text-4);
}
.console-shell textarea.form-input {
  resize: vertical;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
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
  border: 1px dashed var(--c-border);
  border-radius: var(--radius-md);
}
.console-shell .empty-state--sm {
  min-height: 56px;
}
</style>

<style scoped>
.console-shell {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  height: calc(100vh - 32px);
  min-height: 0;
  overflow: hidden;
  background: var(--c-bg-soft);
  color: var(--c-text);
  font-family: var(--font-sans);
  font-size: 14px;
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
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--c-border);
  background: var(--c-bg);
  flex-shrink: 0;
}

.workspace-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--c-text);
}

.workspace-desc {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--c-text-3);
}

.workspace-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.workspace-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px 20px;
}

@media (max-width: 960px) {
  .console-shell {
    grid-template-columns: 1fr;
    height: auto;
    overflow: visible;
  }
  .workspace {
    overflow: visible;
  }
}

@media (max-width: 720px) {
  .workspace-header {
    flex-direction: column;
    align-items: flex-start;
    padding: 12px 16px;
  }
}
</style>
