<template>
  <aside class="sidebar">
    <div class="sidebar-brand">MIO</div>

    <nav class="sidebar-nav" aria-label="Mio Console Navigation">
      <button
        v-for="section in sections"
        :key="section.id"
        class="nav-item"
        :class="{ 'nav-item--active': activeSection === section.id }"
        type="button"
        @click="$emit('select', section.id)"
      >
        <component :is="section.icon" :size="15" />
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
  padding: 14px 8px;
  background: var(--c-bg);
  border-right: 1px solid var(--c-border-light);
  overflow-y: auto;
}

.sidebar-brand {
  padding: 0 10px 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--c-text-4);
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text-2);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 150ms, color 150ms;
}

.nav-item:hover {
  background: var(--c-bg-muted);
  color: var(--c-text);
}

.nav-item--active,
.nav-item--active:hover {
  background: var(--c-accent-soft);
  color: var(--c-accent);
  font-weight: 500;
}

@media (max-width: 960px) {
  .sidebar {
    flex-direction: row;
    align-items: center;
    border-right: none;
    border-bottom: 1px solid var(--c-border-light);
  }
  .sidebar-brand {
    padding: 0 10px;
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
