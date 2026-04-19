<template>
  <k-layout>
    <div class="mio-console">
      <header class="console-hero">
        <div>
          <p class="eyebrow">Mio Console</p>
          <h1>统一控制台</h1>
          <p class="hero-copy">
            把 persona studio、运行统计和维护工具放到同一个入口里，同时保持分区清晰，避免互相打架。
          </p>
        </div>
        <div class="hero-actions">
          <button class="action-button action-button--ghost" type="button" @click="refreshAll">
            <RefreshCw :size="16" />
            <span>刷新全部</span>
          </button>
        </div>
      </header>

      <section class="summary-grid">
        <article class="summary-card">
          <div class="summary-icon">
            <Users :size="18" />
          </div>
          <div>
            <p class="summary-label">默认人设</p>
            <strong>{{ studio.defaultPersona.value?.name ?? "加载中" }}</strong>
            <p class="summary-meta">{{ studio.totalBoundGroups.value }} 个显式绑定群</p>
          </div>
        </article>

        <article class="summary-card">
          <div class="summary-icon">
            <LayoutPanelLeft :size="18" />
          </div>
          <div>
            <p class="summary-label">人设总数</p>
            <strong>{{ studio.personas.value.length }}</strong>
            <p class="summary-meta">{{ buildCacheSummary(studio.cacheStats.value) }}</p>
          </div>
        </article>

        <article class="summary-card">
          <div class="summary-icon">
            <Activity :size="18" />
          </div>
          <div>
            <p class="summary-label">运行状态</p>
            <strong>{{ runtime.memoryEnabled.value ? "Memory On" : "Memory Off" }}</strong>
            <p class="summary-meta">{{ runtime.tokenStats.value?.totalCalls ?? 0 }} 次模型调用</p>
          </div>
        </article>

        <article class="summary-card">
          <div class="summary-icon">
            <Database :size="18" />
          </div>
          <div>
            <p class="summary-label">Token 总量</p>
            <strong>{{ totalTokens }}</strong>
            <p class="summary-meta">今日 {{ runtime.todayTokens.value }} Tokens</p>
          </div>
        </article>
      </section>

      <nav class="console-nav" aria-label="Mio Console Sections">
        <button
          v-for="section in sections"
          :key="section.id"
          class="nav-chip"
          :class="{ 'nav-chip--active': activeSection === section.id }"
          type="button"
          @click="activeSection = section.id"
        >
          <component :is="section.icon" :size="16" />
          <span>{{ section.label }}</span>
        </button>
      </nav>

      <section class="console-panel">
        <PersonaStudioPanel v-if="activeSection === 'persona'" :studio="studio" />
        <RuntimeOverviewPanel v-else-if="activeSection === 'runtime'" :runtime="runtime" />
        <MaintenanceToolsPanel v-else :runtime="runtime" />
      </section>
    </div>
  </k-layout>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from "vue";
import {
  Activity,
  Database,
  LayoutPanelLeft,
  RefreshCw,
  ShieldAlert,
  Users,
} from "lucide-vue-next";
import { buildCacheSummary } from "./persona-ui";
import { usePersonaStudio } from "./composables/use-persona-studio";
import { useRuntimeConsole } from "./composables/use-runtime-console";
import PersonaStudioPanel from "./components/persona-studio-panel.vue";
import RuntimeOverviewPanel from "./components/runtime-overview-panel.vue";
import MaintenanceToolsPanel from "./components/maintenance-tools-panel.vue";

const studio = usePersonaStudio();
const runtime = useRuntimeConsole();

const sections = [
  { id: "persona", label: "Persona Studio", icon: LayoutPanelLeft },
  { id: "runtime", label: "运行统计", icon: Activity },
  { id: "maintenance", label: "维护工具", icon: ShieldAlert },
] as const;

const activeSection = ref<(typeof sections)[number]["id"]>("persona");

const totalTokens = computed(() => {
  const stats = runtime.tokenStats.value;
  if (!stats) {
    return "0";
  }

  return runtime.formatNumber(stats.totalPromptTokens + stats.totalCompletionTokens);
});

async function refreshAll() {
  await Promise.all([
    studio.refreshStudio(),
    runtime.refreshAll(),
  ]);
}

onMounted(() => {
  void refreshAll();
});
</script>

<style scoped>
.mio-console {
  --panel-bg: rgba(255, 255, 255, 0.92);
  --panel-border: rgba(15, 23, 42, 0.08);
  --text-strong: #0f172a;
  --text-base: #334155;
  --text-soft: #64748b;
  --accent: #0f766e;
  --accent-soft: rgba(15, 118, 110, 0.12);
  --accent-strong: #115e59;
  --danger: #be123c;
  --danger-soft: rgba(190, 18, 60, 0.1);
  --warning-soft: #fff7ed;
  padding: 24px;
  min-height: 100%;
  background:
    radial-gradient(circle at top left, rgba(15, 118, 110, 0.12), transparent 28%),
    linear-gradient(180deg, #f5f7fb 0%, #eef2f9 100%);
  color: var(--text-strong);
  font-family: "Fira Sans", "Noto Sans SC", "PingFang SC", sans-serif;
}

.console-hero {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 20px;
}

.eyebrow {
  margin: 0 0 8px;
  color: var(--accent-strong);
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 700;
}

.console-hero h1 {
  margin: 0;
  font-family: "Fira Code", "JetBrains Mono", monospace;
  font-size: 32px;
  line-height: 1.1;
}

.hero-copy {
  max-width: 760px;
  margin: 12px 0 0;
  line-height: 1.6;
  color: var(--text-soft);
}

.hero-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}

.summary-card,
.console-panel {
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: 18px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.07);
}

.summary-card {
  display: flex;
  gap: 14px;
  padding: 18px;
}

.summary-icon {
  width: 38px;
  height: 38px;
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-soft);
  color: var(--accent-strong);
  flex-shrink: 0;
}

.summary-label {
  margin: 0 0 8px;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-soft);
}

.summary-card strong {
  display: block;
  font-size: 24px;
  line-height: 1.1;
}

.summary-meta {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-soft);
}

.console-nav {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.nav-chip,
.action-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-radius: 12px;
  border: none;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  transition: background-color 180ms ease, color 180ms ease, box-shadow 180ms ease, opacity 180ms ease;
}

.nav-chip {
  background: rgba(255, 255, 255, 0.72);
  color: var(--text-base);
}

.nav-chip:hover,
.nav-chip:focus-visible {
  background: rgba(15, 118, 110, 0.12);
  color: var(--accent-strong);
  outline: none;
}

.nav-chip--active {
  background: var(--accent);
  color: #ffffff;
  box-shadow: 0 8px 22px rgba(15, 118, 110, 0.2);
}

.console-panel {
  padding: 18px;
}

.action-button--ghost {
  background: rgba(15, 23, 42, 0.06);
  color: var(--text-base);
}

.action-button--ghost:hover,
.action-button--ghost:focus-visible {
  background: rgba(15, 118, 110, 0.12);
  color: var(--accent-strong);
  outline: none;
}

@media (max-width: 1180px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 820px) {
  .mio-console {
    padding: 16px;
  }

  .console-hero {
    flex-direction: column;
  }

  .summary-grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .nav-chip,
  .action-button {
    transition: none;
  }
}
</style>
