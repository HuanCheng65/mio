import { computed, reactive, ref, watch } from "vue";
import { message, send } from "@koishijs/client";
import type { PersonaCacheStats } from "../persona-ui";
import type { PersonaDeleteResult, PersonaDetail, PersonaSummary } from "../types";

type SaveState = "saved" | "dirty" | "saving" | "failed";

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function createDefaultDraft() {
  return {
    name: "",
    content: "# 新人设\n\n在这里写完整的人设内容。",
  };
}

export function usePersonaStudio() {
  const personas = ref<PersonaSummary[]>([]);
  const cacheStats = ref<PersonaCacheStats | null>(null);
  const selectedPersona = ref<PersonaDetail | null>(null);
  const selectedPersonaId = ref("");
  const searchQuery = ref("");
  const draftContent = ref("");
  const bindGroupId = ref("");
  const renameDraft = ref("");
  const pendingSelectionId = ref<string | null>(null);

  const showCreateModal = ref(false);
  const showRenameModal = ref(false);
  const showDiscardDialog = ref(false);
  const showDeleteDialog = ref(false);

  const createDraft = reactive(createDefaultDraft());

  const loading = reactive({
    refresh: false,
    detail: false,
    create: false,
    save: false,
    duplicate: false,
    rename: false,
    setDefault: false,
    bind: false,
    unbind: false,
    delete: false,
  });

  const saveState = ref<SaveState>("saved");

  const defaultPersona = computed(() => personas.value.find((persona) => persona.isDefault) ?? null);
  const totalBoundGroups = computed(() => personas.value.reduce((total, persona) => total + persona.boundGroupCount, 0));
  const currentPersonaCacheCount = computed(() => {
    if (!selectedPersona.value || !cacheStats.value) {
      return 0;
    }

    return cacheStats.value.byPersona[selectedPersona.value.id] ?? 0;
  });

  const filteredPersonas = computed(() => {
    const keyword = searchQuery.value.trim().toLowerCase();
    if (!keyword) {
      return personas.value;
    }

    return personas.value.filter((persona) => {
      return persona.name.toLowerCase().includes(keyword) || persona.id.toLowerCase().includes(keyword);
    });
  });

  const isDirty = computed(() => {
    return Boolean(selectedPersona.value && draftContent.value !== selectedPersona.value.content);
  });

  const busyAction = computed(() => Object.values(loading).some(Boolean));

  const saveStateText = computed(() => {
    switch (saveState.value) {
      case "dirty":
        return "有未保存改动";
      case "saving":
        return "保存中";
      case "failed":
        return "保存失败";
      default:
        return "已保存";
    }
  });

  watch([selectedPersona, draftContent], () => {
    if (!selectedPersona.value) {
      saveState.value = "saved";
      return;
    }

    if (loading.save) {
      return;
    }

    saveState.value = draftContent.value === selectedPersona.value.content ? "saved" : "dirty";
  });

  function resetCreateDraft() {
    Object.assign(createDraft, createDefaultDraft());
  }

  function closeCreateDialog() {
    showCreateModal.value = false;
    resetCreateDraft();
  }

  function openCreateDialog() {
    resetCreateDraft();
    showCreateModal.value = true;
  }

  function openRenameDialog() {
    if (!selectedPersona.value) {
      return;
    }

    renameDraft.value = selectedPersona.value.name;
    showRenameModal.value = true;
  }

  function closeRenameDialog() {
    showRenameModal.value = false;
    renameDraft.value = "";
  }

  async function loadPersonaDetail(personaId: string) {
    loading.detail = true;
    try {
      const detail = await send("mio/persona-get", personaId) as PersonaDetail;
      selectedPersona.value = detail;
      selectedPersonaId.value = detail.id;
      draftContent.value = detail.content;
      bindGroupId.value = "";
      saveState.value = "saved";
    } catch (error) {
      message.error(`加载人设详情失败: ${formatError(error)}`);
    } finally {
      loading.detail = false;
    }
  }

  async function refreshStudio(preferredPersonaId = selectedPersonaId.value) {
    loading.refresh = true;
    try {
      const [personaRows, stats] = await Promise.all([
        send("mio/persona-list") as Promise<PersonaSummary[]>,
        send("mio/persona-cache-stats") as Promise<PersonaCacheStats>,
      ]);

      personas.value = personaRows;
      cacheStats.value = stats;

      const nextPersonaId = personaRows.some((persona) => persona.id === preferredPersonaId)
        ? preferredPersonaId
        : personaRows[0]?.id;

      if (nextPersonaId) {
        await loadPersonaDetail(nextPersonaId);
      } else {
        selectedPersonaId.value = "";
        selectedPersona.value = null;
        draftContent.value = "";
        bindGroupId.value = "";
      }
    } catch (error) {
      message.error(`加载人设工作台失败: ${formatError(error)}`);
    } finally {
      loading.refresh = false;
    }
  }

  function requestPersonaSelection(personaId: string) {
    if (personaId === selectedPersonaId.value) {
      return;
    }

    if (isDirty.value) {
      pendingSelectionId.value = personaId;
      showDiscardDialog.value = true;
      return;
    }

    void loadPersonaDetail(personaId);
  }

  function cancelPendingSelection() {
    showDiscardDialog.value = false;
    pendingSelectionId.value = null;
  }

  async function confirmPendingSelection() {
    if (!pendingSelectionId.value) {
      cancelPendingSelection();
      return;
    }

    const personaId = pendingSelectionId.value;
    cancelPendingSelection();
    await loadPersonaDetail(personaId);
  }

  async function createPersona() {
    loading.create = true;
    try {
      const created = await send("mio/persona-create", {
        name: createDraft.name,
        content: createDraft.content,
      }) as PersonaDetail;
      closeCreateDialog();
      message.success("人设已创建");
      await refreshStudio(created.id);
    } catch (error) {
      message.error(`创建人设失败: ${formatError(error)}`);
    } finally {
      loading.create = false;
    }
  }

  async function saveSelectedPersona() {
    if (!selectedPersona.value || !isDirty.value) {
      return;
    }

    loading.save = true;
    saveState.value = "saving";
    try {
      await send("mio/persona-save", {
        personaId: selectedPersona.value.id,
        content: draftContent.value,
      });
      message.success("人设内容已保存");
      await refreshStudio(selectedPersona.value.id);
    } catch (error) {
      saveState.value = "failed";
      message.error(`保存失败: ${formatError(error)}`);
    } finally {
      loading.save = false;
    }
  }

  async function duplicateSelected() {
    if (!selectedPersona.value) {
      return;
    }

    loading.duplicate = true;
    try {
      const duplicated = await send("mio/persona-duplicate", selectedPersona.value.id) as PersonaDetail;
      message.success("已复制当前人设");
      await refreshStudio(duplicated.id);
    } catch (error) {
      message.error(`复制失败: ${formatError(error)}`);
    } finally {
      loading.duplicate = false;
    }
  }

  async function renameSelectedPersona() {
    if (!selectedPersona.value || !renameDraft.value) {
      return;
    }

    loading.rename = true;
    try {
      await send("mio/persona-rename", {
        personaId: selectedPersona.value.id,
        name: renameDraft.value,
      });
      closeRenameDialog();
      message.success("人设名称已更新");
      await refreshStudio(selectedPersona.value.id);
    } catch (error) {
      message.error(`重命名失败: ${formatError(error)}`);
    } finally {
      loading.rename = false;
    }
  }

  async function setSelectedAsDefault() {
    if (!selectedPersona.value || selectedPersona.value.isDefault) {
      return;
    }

    loading.setDefault = true;
    try {
      await send("mio/persona-set-default", selectedPersona.value.id);
      message.success("默认人设已切换");
      await refreshStudio(selectedPersona.value.id);
    } catch (error) {
      message.error(`设置默认人设失败: ${formatError(error)}`);
    } finally {
      loading.setDefault = false;
    }
  }

  async function bindCurrentGroup() {
    if (!selectedPersona.value || !bindGroupId.value) {
      return;
    }

    loading.bind = true;
    try {
      await send("mio/persona-bind-group", {
        groupId: bindGroupId.value,
        personaId: selectedPersona.value.id,
      });
      message.success(`群 ${bindGroupId.value} 已绑定到 ${selectedPersona.value.name}`);
      await refreshStudio(selectedPersona.value.id);
    } catch (error) {
      message.error(`绑定群失败: ${formatError(error)}`);
    } finally {
      loading.bind = false;
    }
  }

  async function unbindGroup(groupId: string) {
    if (!selectedPersona.value) {
      return;
    }

    loading.unbind = true;
    try {
      await send("mio/persona-unbind-group", groupId);
      message.success(`群 ${groupId} 已回退到默认人设`);
      await refreshStudio(selectedPersona.value.id);
    } catch (error) {
      message.error(`解绑群失败: ${formatError(error)}`);
    } finally {
      loading.unbind = false;
    }
  }

  async function deleteSelectedPersona() {
    if (!selectedPersona.value || selectedPersona.value.isDefault) {
      return;
    }

    loading.delete = true;
    try {
      const result = await send("mio/persona-delete", selectedPersona.value.id) as PersonaDeleteResult;
      showDeleteDialog.value = false;
      message.success(`人设已删除，${result.fallbackGroupIds.length} 个群已恢复到默认人设`);
      await refreshStudio(defaultPersona.value?.id);
    } catch (error) {
      message.error(`删除人设失败: ${formatError(error)}`);
    } finally {
      loading.delete = false;
    }
  }

  return {
    personas,
    cacheStats,
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
    defaultPersona,
    totalBoundGroups,
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
  };
}

export type PersonaStudioController = ReturnType<typeof usePersonaStudio>;
