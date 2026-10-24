<template>
  <aside class="sidebar">
    <div class="sidebar-brand">
      <span class="sidebar-logo">M</span>
      <div>
        <div class="sidebar-title">Mio</div>
        <div class="sidebar-subtitle">控制台</div>
      </div>
    </div>

    <nav class="sidebar-nav" aria-label="Mio Console Navigation">
      <button
        v-for="section in sections"
        :key="section.id"
        class="nav-item"
        :class="{ 'nav-item--active': activeSection === section.id }"
        type="button"
        @click="$emit('select', section.id)"
      >
        <component :is="section.icon" :size="16" />
        <span>{{ section.label }}</span>
      </button>
    </nav>
  </aside>
</template>

<script lang="ts" setup>
import type { ConsoleSection } from "../console-shell";

defineProps<{
  sections: ConsoleSection[];
  activeSection: ConsoleSection["id"];
}>();

defineEmits<{
  (event: "select", sectionId: ConsoleSection["id"]): void;
}>();
</script>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  background: var(--c-bg);
  border-right: 1px solid var(--c-border);
  overflow-y: auto;
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px;
  border-bottom: 1px solid var(--c-border);
}

.sidebar-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  background: var(--c-accent);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 700;
  flex-shrink: 0;
}

.sidebar-title {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--c-text);
}

.sidebar-subtitle {
  font-size: 11px;
  color: var(--c-text-4);
  margin-top: 1px;
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text-2);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background 150ms, color 150ms;
}

.nav-item:hover {
  background: var(--c-bg-muted);
  color: var(--c-text);
}

.nav-item--active {
  background: var(--c-accent-soft);
  color: var(--c-accent-active);
  font-weight: 600;
}

.nav-item--active:hover {
  background: var(--c-accent-soft);
}

@media (max-width: 960px) {
  .sidebar {
    border-right: none;
    border-bottom: 1px solid var(--c-border);
  }
  .sidebar-nav {
    flex-direction: row;
    overflow-x: auto;
  }
  .nav-item {
    white-space: nowrap;
  }
}
</style>
