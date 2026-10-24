<template>
  <div class="persona-pane">
    <div class="studio-grid">
      <div class="panel panel--list">
        <div class="panel-header">
          <h2 class="panel-title">人设列表</h2>
          <span class="badge">{{ filteredPersonas.length }}</span>
        </div>

        <div class="search-box">
          <Search :size="14" class="search-icon" />
          <input
            v-model.trim="searchQuery"
            class="form-input search-input"
            type="search"
            placeholder="搜索名称或 ID"
            aria-label="搜索人设"
          />
        </div>

        <div v-if="loading.refresh && personas.length === 0" class="empty-state">
          正在加载...
        </div>
        <div v-else-if="filteredPersonas.length === 0" class="empty-state">
          没有匹配的人设
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
            <div class="persona-row__head">
              <strong>{{ persona.name }}</strong>
              <span v-for="badge in summarizePersonaRow(persona).badges" :key="badge" class="tag">{{ badge }}</span>
            </div>
            <span class="persona-row__meta">{{ summarizePersonaRow(persona).meta }}</span>
            <span class="persona-row__id">{{ persona.id }}</span>
          </button>
        </div>
      </div>

      <div class="panel panel--editor">
        <div v-if="selectedPersona" class="editor-shell">
          <div class="panel-header">
            <h2 class="panel-title">{{ selectedPersona.name }}</h2>
            <span class="status-badge" :class="`status-badge--${saveState}`">{{ saveStateText }}</span>
          </div>

          <div class="editor-toolbar">
            <button class="btn btn--ghost" type="button" @click="duplicateSelected" :disabled="busyAction || !selectedPersonaId">
              <Copy :size="14" />
              <span>复制</span>
            </button>
            <button class="btn btn--ghost" type="button" @click="openRenameDialog" :disabled="busyAction || !selectedPersonaId">
              <PencilLine :size="14" />
              <span>重命名</span>
            </button>
            <button
              class="btn btn--ghost"
              type="button"
              @click="setSelectedAsDefault"
              :disabled="busyAction || !selectedPersonaId || selectedPersona.isDefault"
            >
              <Star :size="14" />
              <span>{{ selectedPersona.isDefault ? "当前默认" : "设为默认" }}</span>
            </button>
            <span class="toolbar-spacer" />
            <button
              class="btn btn--primary"
              type="button"
              @click="saveSelectedPersona"
              :disabled="busyAction || !isDirty || !selectedPersonaId"
            >
              <Save :size="14" />
              <span>{{ saveState === "saving" ? "保存中" : "保存" }}</span>
            </button>
          </div>

          <div class="editor-area">
            <textarea
              v-model="draftContent"
              class="form-input editor-textarea"
              spellcheck="false"
              aria-label="人设内容编辑器"
              placeholder="在这里编辑人设内容"
            />
          </div>

          <div class="editor-footer">
            <span>{{ draftContent.length }} 字符</span>
            <span>更新于 {{ formatDateTime(selectedPersona.updatedAt) }}</span>
          </div>
        </div>
        <div v-else class="empty-state">
          选择一个人设开始编辑
        </div>
      </div>

      <div class="panel panel--inspector">
        <div v-if="selectedPersona" class="inspector-shell">
          <div class="panel-header">
            <h2 class="panel-title">详情</h2>
            <span class="badge">{{ currentPersonaCacheCount }} 缓存</span>
          </div>

          <dl class="meta-list">
            <div class="meta-item">
              <dt>ID</dt>
              <dd class="mono">{{ selectedPersona.id }}</dd>
            </div>
            <div class="meta-item">
              <dt>内容哈希</dt>
              <dd class="mono">{{ selectedPersona.contentHash }}</dd>
            </div>
            <div class="meta-item">
              <dt>更新时间</dt>
              <dd>{{ formatDateTime(selectedPersona.updatedAt) }}</dd>
            </div>
          </dl>

          <section class="section-card">
            <div class="section-header">
              <Link2 :size="14" />
              <h3>群绑定</h3>
            </div>
            <p class="section-desc">绑定群到当前人设，解绑后回退到默认。</p>

            <div class="bind-form">
              <input
                v-model.trim="bindGroupId"
                class="form-input"
                type="text"
                inputmode="numeric"
                placeholder="输入群号"
                aria-label="绑定群号"
              />
              <button class="btn btn--ghost" type="button" @click="bindCurrentGroup" :disabled="busyAction || !bindGroupId">
                绑定
              </button>
            </div>

            <div v-if="selectedPersona.boundGroupIds.length === 0" class="empty-state empty-state--sm">
              暂无绑定
            </div>
            <ul v-else class="group-list">
              <li v-for="groupId in selectedPersona.boundGroupIds" :key="groupId" class="group-item">
                <span class="mono">{{ groupId }}</span>
                <button class="btn btn--subtle" type="button" @click="unbindGroup(groupId)" :disabled="busyAction">
                  <Unlink2 :size="12" />
                  <span>解绑</span>
                </button>
              </li>
            </ul>
          </section>

          <section class="section-card section-card--danger">
            <div class="section-header section-header--danger">
              <ShieldAlert :size="14" />
              <h3>危险操作</h3>
            </div>
            <p class="section-desc">{{ buildDeletePersonaWarning(selectedPersona.name, selectedPersona.boundGroupIds) }}</p>
            <button
              class="btn btn--danger"
              type="button"
              @click="showDeleteDialog = true"
              :disabled="busyAction || selectedPersona.isDefault"
            >
              <Trash2 :size="14" />
              <span>{{ selectedPersona.isDefault ? "默认人设不可删除" : "删除人设" }}</span>
            </button>
          </section>
        </div>
        <div v-else class="empty-state">
          选择人设查看详情
        </div>
      </div>
    </div>

    <div v-if="showCreateModal" class="modal-overlay" @click.self="closeCreateDialog">
      <section class="modal-box" role="dialog" aria-modal="true" aria-labelledby="create-title">
        <div class="modal-header">
          <h2 id="create-title">新建人设</h2>
          <button class="btn btn--subtle" type="button" aria-label="关闭" @click="closeCreateDialog">
            <X :size="16" />
          </button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <span class="form-label">名称</span>
            <input v-model.trim="createDraft.name" class="form-input" type="text" maxlength="40" placeholder="例如 澪-alt" />
          </div>
          <div class="form-group">
            <span class="form-label">初始内容</span>
            <textarea v-model="createDraft.content" class="form-input modal-textarea" spellcheck="false" />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn--ghost" type="button" @click="closeCreateDialog">取消</button>
          <button class="btn btn--primary" type="button" @click="createPersona" :disabled="busyAction || !createDraft.name">
            {{ loading.create ? "创建中" : "创建" }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="showRenameModal" class="modal-overlay" @click.self="closeRenameDialog">
      <section class="modal-box modal-box--sm" role="dialog" aria-modal="true" aria-labelledby="rename-title">
        <div class="modal-header">
          <h2 id="rename-title">重命名</h2>
          <button class="btn btn--subtle" type="button" aria-label="关闭" @click="closeRenameDialog">
            <X :size="16" />
          </button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <span class="form-label">新名称</span>
            <input v-model.trim="renameDraft" class="form-input" type="text" maxlength="40" />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn--ghost" type="button" @click="closeRenameDialog">取消</button>
          <button class="btn btn--primary" type="button" @click="renameSelectedPersona" :disabled="busyAction || !renameDraft">
            {{ loading.rename ? "保存中" : "确认" }}
          </button>
        </div>
      </section>
    </div>

    <div v-if="showDiscardDialog" class="modal-overlay" @click.self="cancelPendingSelection">
      <section class="modal-box modal-box--sm" role="dialog" aria-modal="true" aria-labelledby="discard-title">
        <div class="modal-header">
          <h2 id="discard-title">放弃修改？</h2>
          <button class="btn btn--subtle" type="button" aria-label="关闭" @click="cancelPendingSelection">
            <X :size="16" />
          </button>
        </div>
        <div class="modal-body">
          <p class="modal-desc">切换人设会丢失当前未保存的编辑。</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn--ghost" type="button" @click="cancelPendingSelection">继续编辑</button>
          <button class="btn btn--danger" type="button" @click="confirmPendingSelection">放弃并切换</button>
        </div>
      </section>
    </div>

    <div v-if="showDeleteDialog && selectedPersona" class="modal-overlay" @click.self="showDeleteDialog = false">
      <section class="modal-box modal-box--sm" role="dialog" aria-modal="true" aria-labelledby="delete-title">
        <div class="modal-header">
          <h2 id="delete-title">确认删除</h2>
          <button class="btn btn--subtle" type="button" aria-label="关闭" @click="showDeleteDialog = false">
            <X :size="16" />
          </button>
        </div>
        <div class="modal-body">
          <p class="modal-desc">{{ buildDeletePersonaWarning(selectedPersona.name, selectedPersona.boundGroupIds) }}</p>
          <div v-if="selectedPersona.boundGroupIds.length > 0" class="impact-tags">
            <span v-for="groupId in selectedPersona.boundGroupIds" :key="groupId" class="impact-tag">{{ groupId }}</span>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn--ghost" type="button" @click="showDeleteDialog = false">取消</button>
          <button class="btn btn--danger" type="button" @click="deleteSelectedPersona" :disabled="busyAction">
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
  requestPersonaSelection,
  confirmPendingSelection,
  cancelPendingSelection,
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
  min-height: 0;
  flex: 1;
}

.studio-grid {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 300px;
  gap: 16px;
  flex: 1;
  min-height: 0;
}

.panel {
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: 16px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
  flex-shrink: 0;
}

.panel-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text);
}

.badge {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--c-bg-muted);
  color: var(--c-text-3);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.tag {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--c-accent-soft);
  color: var(--c-accent-active);
  font-size: 11px;
  font-weight: 600;
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

/* Search */
.search-box {
  position: relative;
  margin-bottom: 12px;
  flex-shrink: 0;
}

.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--c-text-4);
  pointer-events: none;
}

.search-input {
  padding-left: 30px;
}

/* Persona list */
.persona-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.persona-row {
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

.persona-row:hover {
  background: var(--c-bg-muted);
}

.persona-row--active {
  background: var(--c-accent-soft);
  border-color: var(--c-accent-muted);
}

.persona-row__head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.persona-row__head strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--c-text);
}

.persona-row__meta {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: var(--c-text-4);
}

.persona-row__id {
  display: block;
  margin-top: 2px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--c-text-4);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Editor */
.editor-shell {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
}

.editor-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex-shrink: 0;
}

.toolbar-spacer {
  flex: 1;
}

.editor-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.editor-textarea {
  flex: 1;
  min-height: 200px;
  resize: none;
}

.editor-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  color: var(--c-text-4);
  flex-shrink: 0;
}

/* Inspector */
.inspector-shell {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.meta-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
}

.meta-item {
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--c-bg-soft);
}

.meta-item dt {
  font-size: 11px;
  font-weight: 500;
  color: var(--c-text-4);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-bottom: 2px;
}

.meta-item dd {
  margin: 0;
  font-size: 12px;
  color: var(--c-text);
  line-height: 1.5;
  word-break: break-all;
}

.mono {
  font-family: var(--font-mono);
}

.section-card {
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--c-bg-soft);
  border: 1px solid var(--c-border-light);
}

.section-card--danger {
  background: var(--c-danger-soft);
  border-color: rgba(225, 29, 72, 0.15);
}

.section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  color: var(--c-text);
}

.section-header h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.section-header--danger {
  color: var(--c-danger);
}

.section-desc {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--c-text-3);
}

.bind-form {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}

.group-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.group-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: var(--c-bg);
  font-size: 12px;
}

/* Modals */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 100;
}

.modal-box {
  width: min(600px, 100%);
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-xl);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.12);
  overflow: hidden;
}

.modal-box--sm {
  width: min(420px, 100%);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--c-border);
}

.modal-header h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.modal-body {
  padding: 16px 20px;
}

.modal-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--c-text-2);
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-group + .form-group {
  margin-top: 12px;
}

.modal-textarea {
  min-height: 160px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--c-border);
  background: var(--c-bg-soft);
}

.impact-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.impact-tag {
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--c-bg);
  color: var(--c-danger);
  border: 1px solid rgba(225, 29, 72, 0.15);
  font-family: var(--font-mono);
  font-size: 12px;
}

@media (max-width: 1200px) {
  .studio-grid {
    grid-template-columns: 220px minmax(0, 1fr);
  }
  .panel--inspector {
    grid-column: 1 / -1;
  }
}

@media (max-width: 820px) {
  .studio-grid {
    grid-template-columns: 1fr;
  }
  .editor-toolbar {
    flex-wrap: wrap;
  }
  .editor-footer {
    flex-direction: column;
  }
}
</style>
