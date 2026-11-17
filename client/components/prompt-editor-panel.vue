<template>
  <div class="prompt-pane">
    <div v-if="prompts.length === 0" class="empty-state">正在加载提示词…</div>

    <template v-else>
      <nav class="prompt-list" aria-label="提示词">
        <button
          v-for="p in prompts"
          :key="p.name"
          class="prompt-item"
          :class="{ 'prompt-item--active': selected === p.name }"
          type="button"
          @click="selected = p.name"
        >
          <span class="prompt-item__label">{{ PROMPT_LABELS[p.name].label }}</span>
          <span v-if="isDirtyFor(p.name)" class="dot" title="有没保存的改动" />
          <span v-else-if="p.edited" class="badge" title="用的是 Console 里改过的版本">已改</span>
        </button>
      </nav>

      <section v-if="current" class="editor">
        <header class="editor__head">
          <div class="editor__title">
            <h2>{{ PROMPT_LABELS[current.name].label }}</h2>
            <p class="form-hint">{{ PROMPT_LABELS[current.name].hint }}</p>
            <p class="form-hint">
              <template v-if="current.edited">
                用的是 Console 里的版本（改于 {{ formatTime(current.updatedAt!) }}）。种子文件 <span class="mono">data/{{ current.seedFile }}</span> 部署时会被仓库覆盖，这里的改动不受影响。
              </template>
              <template v-else>
                跟着种子文件 <span class="mono">data/{{ current.seedFile }}</span>。在这里保存后改用数据库里的版本。
              </template>
            </p>
          </div>
          <div class="editor__actions">
            <button v-if="dirty" class="btn btn--text" type="button" :disabled="saving" @click="discard">放弃</button>
            <button
              v-if="current.edited"
              class="btn"
              type="button"
              :disabled="saving"
              @click="confirmReset"
            >
              恢复文件版本
            </button>
            <button class="btn btn--primary" type="button" :disabled="!dirty || saving" @click="save">
              {{ saving ? "保存中" : "保存" }}
            </button>
          </div>
        </header>

        <textarea
          v-model="draft"
          class="form-input editor__text"
          spellcheck="false"
          :aria-label="PROMPT_LABELS[current.name].label"
        />
        <p class="form-hint editor__foot">
          {{ draft.length.toLocaleString() }} 字 · 保存后下一次请求开始生效；改人设或环境说明会让各群的缓存重新写一次
        </p>
      </section>
    </template>
  </div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import { PROMPT_LABELS, type PromptEditorController } from "../composables/use-prompt-editor";

const props = defineProps<{ editor: PromptEditorController }>();
const { prompts, selected, current, draft, saving, isDirtyFor, save, discard, resetToSeed } = props.editor;

const dirty = computed(() => isDirtyFor(selected.value));

function confirmReset() {
  if (!current.value) return;
  if (!window.confirm(`丢掉 Console 里改过的${PROMPT_LABELS[current.value.name].label}，恢复成 data/${current.value.seedFile} 的内容？`)) return;
  void resetToSeed();
}

const pad = (n: number) => String(n).padStart(2, "0");
function formatTime(ts: number) {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
</script>

<style scoped>
.prompt-pane {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  gap: 16px;
  min-height: calc(100vh - 160px);
}

.prompt-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.prompt-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--c-text-2);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.prompt-item:hover {
  background: var(--c-bg-muted);
}

.prompt-item--active {
  background: var(--c-accent-soft);
  color: var(--c-accent);
  font-weight: 500;
}

.prompt-item__label {
  flex: 1;
}

.badge {
  padding: 0 6px;
  border-radius: 4px;
  background: var(--c-warning-soft);
  color: var(--c-warning);
  font-size: 11px;
  font-weight: 400;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--c-warning);
}

.editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.editor__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.editor__title h2 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
  color: var(--c-text);
}

.editor__title .form-hint {
  margin: 2px 0 0;
}

.editor__actions {
  display: flex;
  gap: 8px;
  flex: none;
}

.editor__text {
  flex: 1;
  min-height: 420px;
  width: 100%;
}

.editor__foot {
  margin: 0;
}

@media (max-width: 720px) {
  .prompt-pane {
    grid-template-columns: 1fr;
  }

  .prompt-list {
    flex-direction: row;
    flex-wrap: wrap;
  }

  .editor__head {
    flex-direction: column;
  }
}
</style>
