<template>
  <div class="persona-pane">
    <div class="persona-pane__actions">
      <button class="action-button action-button--ghost" type="button" @click="refreshStudio()" :disabled="loading.refresh">
        <RefreshCw :size="16" />
        <span>{{ loading.refresh ? "刷新中" : "刷新人设数据" }}</span>
      </button>
      <button class="action-button action-button--primary" type="button" @click="openCreateDialog">
        <Plus :size="16" />
        <span>创建人设</span>
      </button>
    </div>

    <div class="studio-grid">
      <k-card class="panel panel--list">
        <div class="panel-heading">
          <div>
            <p class="panel-eyebrow">Persona Index</p>
            <h2>人设列表</h2>
          </div>
          <span class="count-pill">{{ filteredPersonas.length }}</span>
        </div>

        <label class="field">
          <span class="field-label">搜索人设</span>
          <div class="search-shell">
            <Search :size="16" />
            <input
              v-model.trim="searchQuery"
              type="search"
              placeholder="按名称或 ID 搜索"
              aria-label="搜索人设"
            />
          </div>
        </label>

        <div v-if="loading.refresh && personas.length === 0" class="empty-state">
          正在加载人设列表...
        </div>
        <div v-else-if="filteredPersonas.length === 0" class="empty-state">
          没有匹配的人设，试试别的关键词。
        </div>
        <div v-else class="persona-list">
          <button
            v-for="persona in filteredPersonas"
            :key="persona.id"
            v-memo="[persona.id, persona.updatedAt, persona.boundGroupCount, persona.isDefault, selectedPersonaId]"
            class="persona-row"
            :class="{ 'persona-row--active': persona.id === selectedPersonaId }"
            type="button"
            @click="requestPersonaSelection(persona.id)"
          >
            <div class="persona-row__title">
              <strong>{{ persona.name }}</strong>
              <span v-for="badge in summarizePersonaRow(persona).badges" :key="badge" class="mini-badge">
                {{ badge }}
              </span>
            </div>
            <p class="persona-row__meta">{{ summarizePersonaRow(persona).meta }}</p>
            <p class="persona-row__id">{{ persona.id }}</p>
          </button>
        </div>
      </k-card>

      <k-card class="panel panel--editor">
        <div v-if="selectedPersona" class="editor-shell">
          <div class="panel-heading panel-heading--spread">
            <div>
              <p class="panel-eyebrow">Editor</p>
              <h2>{{ selectedPersona.name }}</h2>
            </div>
            <span class="status-pill" :class="`status-pill--${saveState}`">{{ saveStateText }}</span>
          </div>

          <div class="editor-actions">
            <button class="action-button action-button--ghost" type="button" @click="duplicateSelected" :disabled="busyAction || !selectedPersonaId">
              <Copy :size="16" />
              <span>复制</span>
            </button>
            <button class="action-button action-button--ghost" type="button" @click="openRenameDialog" :disabled="busyAction || !selectedPersonaId">
              <PencilLine :size="16" />
              <span>重命名</span>
            </button>
            <button
              class="action-button action-button--ghost"
              type="button"
              @click="setSelectedAsDefault"
              :disabled="busyAction || !selectedPersonaId || selectedPersona.isDefault"
            >
              <Star :size="16" />
              <span>{{ selectedPersona.isDefault ? "当前默认" : "设为默认" }}</span>
            </button>
            <button
              class="action-button action-button--primary"
              type="button"
              @click="saveSelectedPersona"
              :disabled="busyAction || !isDirty || !selectedPersonaId"
            >
              <Save :size="16" />
              <span>{{ saveState === "saving" ? "保存中" : "保存内容" }}</span>
            </button>
          </div>

          <label class="field field--grow">
            <span class="field-label">Persona Markdown</span>
            <textarea
              v-model="draftContent"
              class="editor-textarea"
              spellcheck="false"
              aria-label="人设 Markdown 编辑器"
              placeholder="在这里编辑完整人设内容"
            />
          </label>

          <div class="editor-footer">
            <span>{{ draftContent.length }} 字符</span>
            <span>最后更新 {{ formatDateTime(selectedPersona.updatedAt) }}</span>
          </div>
        </div>
        <div v-else class="empty-state">
          当前没有可编辑的人设。
        </div>
      </k-card>

      <k-card class="panel panel--inspector">
        <div v-if="selectedPersona" class="inspector-shell">
          <div class="panel-heading">
            <div>
              <p class="panel-eyebrow">Inspector</p>
              <h2>检查器</h2>
            </div>
            <span class="count-pill">{{ currentPersonaCacheCount }}</span>
          </div>

          <dl class="meta-grid">
            <div>
              <dt>ID</dt>
              <dd>{{ selectedPersona.id }}</dd>
            </div>
            <div>
              <dt>内容哈希</dt>
              <dd>{{ selectedPersona.contentHash }}</dd>
            </div>
            <div>
              <dt>缓存条目</dt>
              <dd>{{ currentPersonaCacheCount }}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{{ formatDateTime(selectedPersona.updatedAt) }}</dd>
            </div>
          </dl>

          <section class="binding-card">
            <div class="section-title">
              <Link2 :size="16" />
              <h3>群绑定</h3>
            </div>
            <p class="section-copy">输入群号即可把它切到当前人设；解绑后会自动回退默认人设。</p>

            <label class="field">
              <span class="field-label">绑定群号</span>
              <div class="inline-form">
                <input
                  v-model.trim="bindGroupId"
                  type="text"
                  inputmode="numeric"
                  placeholder="例如 123456789"
                  aria-label="绑定群号"
                />
                <button class="action-button action-button--ghost" type="button" @click="bindCurrentGroup" :disabled="busyAction || !bindGroupId">
                  绑定
                </button>
              </div>
            </label>

            <div v-if="selectedPersona.boundGroupIds.length === 0" class="empty-state empty-state--compact">
              还没有显式绑定群。
            </div>
            <ul v-else class="group-list">
              <li v-for="groupId in selectedPersona.boundGroupIds" :key="groupId" class="group-row">
                <span>{{ groupId }}</span>
                <button
                  class="action-button action-button--subtle"
                  type="button"
                  @click="unbindGroup(groupId)"
                  :disabled="busyAction"
                >
                  <Unlink2 :size="14" />
                  <span>解绑</span>
                </button>
              </li>
            </ul>
          </section>

          <section class="danger-card">
            <div class="section-title section-title--danger">
              <ShieldAlert :size="16" />
              <h3>危险操作</h3>
            </div>
            <p class="section-copy">
              {{ buildDeletePersonaWarning(selectedPersona.name, selectedPersona.boundGroupIds) }}
            </p>
            <button
              class="action-button action-button--danger"
              type="button"
              @click="showDeleteDialog = true"
              :disabled="busyAction || selectedPersona.isDefault"
            >
              <Trash2 :size="16" />
              <span>{{ selectedPersona.isDefault ? "默认人设不可删除" : "删除当前人设" }}</span>
            </button>
          </section>
        </div>
        <div v-else class="empty-state">
          选中一个人设后，这里会显示元数据、绑定和删除预警。
        </div>
      </k-card>
    </div>

    <div v-if="showCreateModal" class="modal-backdrop" @click.self="closeCreateDialog">
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-persona-title">
        <div class="modal-header">
          <h2 id="create-persona-title">创建新的人设</h2>
          <button class="icon-button" type="button" aria-label="关闭创建人设窗口" @click="closeCreateDialog">
            <X :size="16" />
          </button>
        </div>

        <label class="field">
          <span class="field-label">名称</span>
          <input v-model.trim="createDraft.name" type="text" maxlength="40" placeholder="例如 澪-alt" />
        </label>

        <label class="field">
          <span class="field-label">初始内容</span>
          <textarea v-model="createDraft.content" class="modal-textarea" spellcheck="false" />
        </label>

        <div class="modal-actions">
          <button class="action-button action-button--ghost" type="button" @click="closeCreateDialog">取消</button>
          <button class="action-button action-button--primary" type="button" @click="createPersona" :disabled="busyAction || !createDraft.name">
            {{ loading.create ? "创建中" : "创建" }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="showRenameModal" class="modal-backdrop" @click.self="closeRenameDialog">
      <section class="modal-card modal-card--compact" role="dialog" aria-modal="true" aria-labelledby="rename-persona-title">
        <div class="modal-header">
          <h2 id="rename-persona-title">重命名人设</h2>
          <button class="icon-button" type="button" aria-label="关闭重命名窗口" @click="closeRenameDialog">
            <X :size="16" />
          </button>
        </div>

        <label class="field">
          <span class="field-label">新名称</span>
          <input v-model.trim="renameDraft" type="text" maxlength="40" />
        </label>

        <div class="modal-actions">
          <button class="action-button action-button--ghost" type="button" @click="closeRenameDialog">取消</button>
          <button class="action-button action-button--primary" type="button" @click="renameSelectedPersona" :disabled="busyAction || !renameDraft">
            {{ loading.rename ? "保存中" : "保存名称" }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="showDiscardDialog" class="modal-backdrop" @click.self="cancelPendingSelection">
      <section class="modal-card modal-card--compact" role="dialog" aria-modal="true" aria-labelledby="discard-changes-title">
        <div class="modal-header">
          <h2 id="discard-changes-title">放弃未保存改动？</h2>
          <button class="icon-button" type="button" aria-label="关闭切换确认窗口" @click="cancelPendingSelection">
            <X :size="16" />
          </button>
        </div>

        <p class="dialog-copy">你有未保存的内容。继续切换会丢失这次编辑草稿。</p>

        <div class="modal-actions">
          <button class="action-button action-button--ghost" type="button" @click="cancelPendingSelection">继续编辑</button>
          <button class="action-button action-button--danger" type="button" @click="confirmPendingSelection">放弃并切换</button>
        </div>
      </section>
    </div>

    <div v-if="showDeleteDialog && selectedPersona" class="modal-backdrop" @click.self="showDeleteDialog = false">
      <section class="modal-card modal-card--compact" role="dialog" aria-modal="true" aria-labelledby="delete-persona-title">
        <div class="modal-header">
          <h2 id="delete-persona-title">确认删除人设</h2>
          <button class="icon-button" type="button" aria-label="关闭删除确认窗口" @click="showDeleteDialog = false">
            <X :size="16" />
          </button>
        </div>

        <p class="dialog-copy">{{ buildDeletePersonaWarning(selectedPersona.name, selectedPersona.boundGroupIds) }}</p>

        <div v-if="selectedPersona.boundGroupIds.length > 0" class="impact-list">
          <span v-for="groupId in selectedPersona.boundGroupIds" :key="groupId" class="impact-pill">{{ groupId }}</span>
        </div>

        <div class="modal-actions">
          <button class="action-button action-button--ghost" type="button" @click="showDeleteDialog = false">取消</button>
          <button class="action-button action-button--danger" type="button" @click="deleteSelectedPersona" :disabled="busyAction">
            {{ loading.delete ? "删除中" : "确认删除" }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<script lang="ts" setup>
import {
  Copy,
  Link2,
  PencilLine,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  Star,
  Trash2,
  Unlink2,
  X,
} from "lucide-vue-next";
import { buildDeletePersonaWarning, formatDateTime, summarizePersonaRow } from "../persona-ui";
import type { PersonaStudioController } from "../composables/use-persona-studio";

const props = defineProps<{
  studio: PersonaStudioController;
}>();

const {
  personas,
  selectedPersona,
  selectedPersonaId,
  searchQuery,
  draftContent,
  bindGroupId,
  renameDraft,
  createDraft,
  loading,
  saveState,
  saveStateText,
  currentPersonaCacheCount,
  filteredPersonas,
  isDirty,
  busyAction,
  showCreateModal,
  showRenameModal,
  showDiscardDialog,
  showDeleteDialog,
  refreshStudio,
  requestPersonaSelection,
  confirmPendingSelection,
  cancelPendingSelection,
  openCreateDialog,
  closeCreateDialog,
  createPersona,
  openRenameDialog,
  closeRenameDialog,
  renameSelectedPersona,
  saveSelectedPersona,
  duplicateSelected,
  setSelectedAsDefault,
  bindCurrentGroup,
  unbindGroup,
  deleteSelectedPersona,
} = props.studio;
</script>

<style scoped>
.persona-pane {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.persona-pane__actions,
.editor-actions,
.modal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.studio-grid {
  display: grid;
  grid-template-columns: minmax(240px, 280px) minmax(0, 1fr) minmax(280px, 320px);
  gap: 16px;
  align-items: start;
}

.panel {
  padding: 18px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: 18px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.07);
}

.panel--editor,
.panel--inspector,
.panel--list {
  min-height: 720px;
}

.panel-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}

.panel-heading--spread {
  align-items: center;
}

.panel-eyebrow {
  margin: 0 0 8px;
  color: var(--accent-strong);
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 700;
}

.panel-heading h2,
.modal-header h2 {
  margin: 0;
  font-family: "Fira Code", "JetBrains Mono", monospace;
  font-size: 24px;
  line-height: 1.15;
}

.count-pill,
.mini-badge,
.status-pill,
.impact-pill {
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
}

.count-pill {
  min-width: 34px;
  padding: 7px 10px;
  background: rgba(15, 23, 42, 0.06);
  color: var(--text-base);
}

.status-pill {
  padding: 8px 12px;
  background: rgba(15, 23, 42, 0.06);
  color: var(--text-base);
}

.status-pill--dirty {
  background: rgba(245, 158, 11, 0.12);
  color: #b45309;
}

.status-pill--saving {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.status-pill--failed {
  background: var(--danger-soft);
  color: var(--danger);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field--grow {
  flex: 1;
}

.field-label {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-soft);
}

.search-shell,
.inline-form,
.field input,
.modal-textarea,
.editor-textarea {
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 14px;
  background: rgba(248, 250, 252, 0.96);
}

.search-shell {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
}

.search-shell input,
.inline-form input,
.field input {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-strong);
  padding: 12px 0;
  outline: none;
  font: inherit;
}

.persona-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 640px;
  overflow: auto;
  padding-right: 2px;
}

.persona-row {
  width: 100%;
  text-align: left;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: rgba(255, 255, 255, 0.72);
  transition: border-color 180ms ease, box-shadow 180ms ease, background-color 180ms ease;
  cursor: pointer;
}

.persona-row:hover,
.persona-row:focus-visible {
  border-color: rgba(15, 118, 110, 0.35);
  box-shadow: 0 8px 22px rgba(15, 118, 110, 0.12);
  outline: none;
}

.persona-row--active {
  border-color: rgba(15, 118, 110, 0.45);
  background: rgba(240, 253, 250, 0.95);
}

.persona-row__title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.persona-row__meta,
.persona-row__id,
.editor-footer,
.section-copy,
.dialog-copy {
  color: var(--text-soft);
}

.persona-row__meta,
.persona-row__id {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.5;
}

.persona-row__id {
  font-family: "Fira Code", "JetBrains Mono", monospace;
  font-size: 11px;
  word-break: break-all;
}

.mini-badge {
  padding: 4px 8px;
  background: rgba(15, 118, 110, 0.1);
  color: var(--accent-strong);
}

.editor-shell,
.inspector-shell {
  display: flex;
  flex-direction: column;
  gap: 18px;
  height: 100%;
}

.editor-textarea,
.modal-textarea {
  width: 100%;
  min-height: 480px;
  resize: vertical;
  padding: 16px;
  font: 500 14px/1.65 "Fira Code", "JetBrains Mono", monospace;
  color: var(--text-strong);
  outline: none;
}

.modal-textarea {
  min-height: 180px;
}

.editor-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
}

.meta-grid div {
  padding: 12px;
  border-radius: 14px;
  background: rgba(248, 250, 252, 0.92);
}

.meta-grid dt {
  color: var(--text-soft);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 6px;
}

.meta-grid dd {
  margin: 0;
  color: var(--text-strong);
  font-family: "Fira Code", "JetBrains Mono", monospace;
  font-size: 12px;
  line-height: 1.6;
  word-break: break-all;
}

.binding-card,
.danger-card {
  padding: 16px;
  border-radius: 16px;
  background: rgba(248, 250, 252, 0.92);
  border: 1px solid rgba(15, 23, 42, 0.08);
}

.danger-card {
  background: var(--warning-soft);
  border-color: rgba(190, 18, 60, 0.12);
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  color: var(--text-strong);
}

.section-title h3 {
  margin: 0;
  font-size: 15px;
}

.section-title--danger {
  color: var(--danger);
}

.section-copy {
  margin: 0 0 14px;
  line-height: 1.6;
}

.inline-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 14px;
}

.group-list {
  list-style: none;
  padding: 0;
  margin: 14px 0 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.group-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.88);
  color: var(--text-base);
  font-family: "Fira Code", "JetBrains Mono", monospace;
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  padding: 18px;
  text-align: center;
  border: 1px dashed rgba(15, 23, 42, 0.12);
  border-radius: 16px;
  color: var(--text-soft);
  background: rgba(255, 255, 255, 0.56);
}

.empty-state--compact {
  min-height: 88px;
}

.action-button,
.icon-button {
  border: none;
  cursor: pointer;
  transition: background-color 180ms ease, color 180ms ease, box-shadow 180ms ease, opacity 180ms ease;
}

.action-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-radius: 12px;
  font: inherit;
  font-weight: 700;
}

.action-button:disabled,
.icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.action-button--primary {
  background: var(--accent);
  color: #ffffff;
}

.action-button--primary:hover:not(:disabled),
.action-button--primary:focus-visible:not(:disabled) {
  background: var(--accent-strong);
  box-shadow: 0 8px 22px rgba(15, 118, 110, 0.2);
  outline: none;
}

.action-button--ghost {
  background: rgba(15, 23, 42, 0.06);
  color: var(--text-base);
}

.action-button--ghost:hover:not(:disabled),
.action-button--ghost:focus-visible:not(:disabled),
.action-button--subtle:hover:not(:disabled),
.action-button--subtle:focus-visible:not(:disabled) {
  background: rgba(15, 118, 110, 0.12);
  color: var(--accent-strong);
  outline: none;
}

.action-button--subtle {
  background: transparent;
  color: var(--text-soft);
  padding: 8px 10px;
}

.action-button--danger {
  background: var(--danger);
  color: #ffffff;
}

.action-button--danger:hover:not(:disabled),
.action-button--danger:focus-visible:not(:disabled) {
  background: #9f1239;
  box-shadow: 0 10px 24px rgba(190, 18, 60, 0.18);
  outline: none;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 30;
}

.modal-card {
  width: min(720px, 100%);
  padding: 22px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: 18px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.07);
}

.modal-card--compact {
  width: min(480px, 100%);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
}

.icon-button {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.06);
  color: var(--text-base);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.icon-button:hover,
.icon-button:focus-visible {
  background: rgba(15, 118, 110, 0.12);
  color: var(--accent-strong);
  outline: none;
}

.impact-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 16px 0 0;
}

.impact-pill {
  padding: 7px 10px;
  background: rgba(255, 255, 255, 0.9);
  color: var(--danger);
  border: 1px solid rgba(190, 18, 60, 0.12);
}

@media (max-width: 1180px) {
  .studio-grid {
    grid-template-columns: minmax(240px, 280px) minmax(0, 1fr);
  }

  .panel--inspector {
    grid-column: 1 / -1;
    min-height: auto;
  }
}

@media (max-width: 820px) {
  .studio-grid,
  .meta-grid {
    grid-template-columns: 1fr;
  }

  .panel--list,
  .panel--editor,
  .panel--inspector {
    min-height: auto;
  }

  .editor-footer {
    flex-direction: column;
  }

  .inline-form {
    grid-template-columns: 1fr;
    padding: 10px 12px 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .persona-row,
  .action-button,
  .icon-button {
    transition: none;
  }
}
</style>
