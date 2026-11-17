<template>
  <div class="memory-pane">
    <div class="toolbar">
      <select v-model="groupId" class="form-input group-select" aria-label="群">
        <option v-if="groups.length === 0" value="">没有记录的群</option>
        <option v-for="g in groups" :key="g.groupId" :value="g.groupId">
          {{ g.name ?? g.groupId }} · {{ g.mode }} · {{ g.notes }} 条笔记
        </option>
      </select>

      <div class="view-switch" role="tablist">
        <button
          v-for="opt in views"
          :key="opt.id"
          class="range-btn"
          :class="{ 'range-btn--active': view === opt.id }"
          type="button"
          role="tab"
          :aria-selected="view === opt.id"
          @click="view = opt.id"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <div v-if="!groupId" class="empty-state">还没有开启录制的群，也没有笔记</div>

    <template v-else-if="view === 'notes'">
      <div class="filters">
        <div class="chips">
          <button class="chip" :class="{ 'chip--active': kind === 'all' }" type="button" @click="kind = 'all'">
            全部 <span class="chip__count">{{ notes.length }}</span>
          </button>
          <button
            v-for="(label, k) in NOTE_KIND_LABELS"
            :key="k"
            class="chip"
            :class="{ 'chip--active': kind === k }"
            type="button"
            :disabled="!kindCounts[k]"
            @click="kind = k"
          >
            {{ label }} <span class="chip__count">{{ kindCounts[k] ?? 0 }}</span>
          </button>
        </div>

        <div class="filter-row">
          <select v-model="about" class="form-input" aria-label="关于谁">
            <option value="all">关于所有人</option>
            <option v-for="opt in aboutOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}（{{ opt.count }}）
            </option>
          </select>
          <input v-model="query" class="form-input search" type="search" placeholder="搜标题或内容" aria-label="搜索" />
          <label class="check">
            <input v-model="privateOnly" type="checkbox" />
            只看放在心里的
          </label>
        </div>
      </div>

      <div v-if="loading" class="empty-state empty-state--sm">加载中</div>
      <div v-else-if="filtered.length === 0" class="empty-state empty-state--sm">没有符合条件的笔记</div>

      <ul v-else class="note-list">
        <li v-for="note in filtered" :key="note.id" class="note" :class="{ 'note--open': expanded.has(note.id) }">
          <button class="note__head" type="button" :aria-expanded="expanded.has(note.id)" @click="toggle(note)">
            <span class="kind" :class="`kind--${note.kind}`">{{ NOTE_KIND_LABELS[note.kind] }}</span>
            <span class="note__id mono">n{{ note.id }}</span>
            <span class="note__title">{{ note.title }}</span>
            <span class="note__about">{{ note.aboutLabel }}</span>
            <span v-if="note.private" class="badge" title="对方不提就不主动提">心里</span>
          </button>

          <div class="note__meta">
            <span>记于 {{ formatTime(note.createdAt) }}</span>
            <span v-if="note.updatedAt !== note.createdAt">改于 {{ formatTime(note.updatedAt) }}</span>
            <span>想起 {{ note.recallCount }} 次<template v-if="note.lastRecalledAt">（最近 {{ formatTime(note.lastRecalledAt) }}）</template></span>
          </div>

          <div v-if="expanded.has(note.id)" class="note__body">
            <p class="note__content">{{ note.content }}</p>
            <p v-if="note.file" class="note__file mono">文件：{{ note.file }}</p>

            <div class="sources">
              <h4 class="sources__title">出处</h4>
              <p v-if="note.sources.length === 0" class="form-hint">没有记出处</p>
              <p v-else-if="expanded.get(note.id) === undefined" class="form-hint">加载中</p>
              <template v-else>
                <p v-if="expanded.get(note.id)!.length < note.sources.length" class="form-hint">
                  有 {{ note.sources.length - expanded.get(note.id)!.length }} 条出处在事件流里找不到了
                </p>
                <div v-for="src in expanded.get(note.id)" :key="src.seq" class="source">
                  <span class="source__seq mono">m{{ src.seq }}</span>
                  <span class="source__time">{{ formatTime(src.timestamp) }}</span>
                  <span class="source__sender">{{ src.sender }}</span>
                  <span class="source__text">{{ src.text || "（空）" }}</span>
                </div>
              </template>
            </div>
          </div>
        </li>
      </ul>
    </template>

    <template v-else>
      <div v-if="loading" class="empty-state empty-state--sm">加载中</div>
      <div v-else-if="segments.length === 0" class="empty-state empty-state--sm">这个群还没有 log</div>
      <ol v-else class="segment-list">
        <li v-for="(seg, index) in segments" :key="seg.segment" class="segment">
          <div class="segment__head">
            <span class="segment__name">第 {{ seg.segment }} 段</span>
            <span v-if="index === 0" class="badge badge--accent">当前</span>
            <span class="segment__meta">开始于 {{ formatTime(seg.startedAt) }} · {{ seg.tokens.toLocaleString() }} tokens</span>
          </div>
          <p v-if="seg.summary" class="segment__summary">{{ seg.summary }}</p>
          <p v-else class="form-hint">第一段从群聊本身开始，没有睡前整理的摘要</p>
        </li>
      </ol>
    </template>
  </div>
</template>

<script lang="ts" setup>
import { ref } from "vue";
import { NOTE_KIND_LABELS, type MemoryBrowserController } from "../composables/use-memory-browser";

const props = defineProps<{ memory: MemoryBrowserController }>();
const {
  groups, groupId, notes, segments, loading,
  kind, about, query, privateOnly, expanded,
  kindCounts, aboutOptions, filtered, toggle,
} = props.memory;

const views = [
  { id: "notes", label: "笔记" },
  { id: "segments", label: "段落摘要" },
] as const;
const view = ref<(typeof views)[number]["id"]>("notes");

const pad = (n: number) => String(n).padStart(2, "0");
function formatTime(ts: number) {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
</script>

<style scoped>
.memory-pane {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.group-select {
  flex: 1 1 280px;
  max-width: 480px;
}

.view-switch {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--c-bg-muted);
}

.range-btn {
  padding: 5px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text-3);
  font-size: 13px;
  cursor: pointer;
}

.range-btn--active {
  background: var(--c-bg);
  color: var(--c-text);
  font-weight: 500;
}

.filters {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--c-border);
  border-radius: 999px;
  background: var(--c-bg);
  color: var(--c-text-2);
  font-size: 12px;
  cursor: pointer;
}

.chip:disabled {
  opacity: 0.45;
  cursor: default;
}

.chip--active {
  border-color: var(--c-accent);
  background: var(--c-accent-soft);
  color: var(--c-accent);
}

.chip__count {
  color: var(--c-text-4);
  font-variant-numeric: tabular-nums;
}

.chip--active .chip__count {
  color: inherit;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.filter-row select {
  flex: 0 1 220px;
}

.search {
  flex: 1 1 200px;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--c-text-2);
  white-space: nowrap;
}

.note-list,
.segment-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.note,
.segment {
  border: 1px solid var(--c-border-light);
  border-radius: var(--radius-lg);
  background: var(--c-bg);
}

.note--open {
  border-color: var(--c-border);
}

.note__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px 4px;
  border: none;
  background: none;
  color: var(--c-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.note__head:focus-visible {
  outline: 2px solid var(--c-accent-muted);
  outline-offset: -2px;
  border-radius: var(--radius-lg);
}

.kind {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--c-bg-muted);
  color: var(--c-text-3);
  font-size: 11px;
}

.kind--impression { background: var(--c-accent-soft); color: var(--c-accent); }
.kind--event { background: var(--c-warning-soft); color: var(--c-warning); }
.kind--self { background: color-mix(in srgb, var(--c-success) 14%, transparent); color: var(--c-success); }

.note__id {
  flex: none;
  color: var(--c-text-4);
  font-size: 11px;
}

.note__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 500;
}

.note__about {
  flex: none;
  max-width: 30%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--c-text-3);
  font-size: 12px;
}

.badge {
  flex: none;
  padding: 0 6px;
  border: 1px solid var(--c-border);
  border-radius: 4px;
  color: var(--c-text-3);
  font-size: 11px;
}

.badge--accent {
  border-color: transparent;
  background: var(--c-accent-soft);
  color: var(--c-accent);
}

.note__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding: 0 12px 10px;
  color: var(--c-text-4);
  font-size: 12px;
}

.note__body {
  padding: 10px 12px 12px;
  border-top: 1px solid var(--c-border-light);
}

.note__content,
.segment__summary {
  margin: 0;
  color: var(--c-text);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.note__file {
  margin: 8px 0 0;
  color: var(--c-text-3);
}

.sources {
  margin-top: 12px;
}

.sources__title {
  margin: 0 0 6px;
  color: var(--c-text-3);
  font-size: 12px;
  font-weight: 600;
}

.source {
  display: grid;
  grid-template-columns: auto auto auto minmax(0, 1fr);
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
  line-height: 1.6;
}

.source__seq,
.source__time {
  color: var(--c-text-4);
  white-space: nowrap;
}

.source__sender {
  color: var(--c-text-2);
  font-weight: 500;
  white-space: nowrap;
}

.source__text {
  color: var(--c-text);
  overflow-wrap: anywhere;
}

.segment {
  padding: 12px;
}

.segment__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.segment__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text);
}

.segment__meta {
  color: var(--c-text-4);
  font-size: 12px;
}

@media (max-width: 640px) {
  .note__about {
    display: none;
  }

  .source {
    grid-template-columns: auto auto minmax(0, 1fr);
  }

  .source__time {
    display: none;
  }
}
</style>
