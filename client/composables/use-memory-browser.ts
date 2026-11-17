import { computed, reactive, ref, watch } from "vue";
import { message, send } from "@koishijs/client";
import type { MemoryGroup, MemoryNote, MemorySegment, MemorySource, NoteKind } from "../types";

export const NOTE_KIND_LABELS: Record<NoteKind, string> = {
  fact: "事实",
  impression: "印象",
  event: "事件",
  self: "自己",
  sticker: "表情包",
};

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useMemoryBrowser() {
  const groups = ref<MemoryGroup[]>([]);
  const groupId = ref("");
  const notes = ref<MemoryNote[]>([]);
  const segments = ref<MemorySegment[]>([]);
  const loading = ref(false);

  const kind = ref<NoteKind | "all">("all");
  const about = ref("all");
  const query = ref("");
  const privateOnly = ref(false);

  /** 展开的笔记 → 出处原话（undefined 表示还在加载） */
  const expanded = reactive(new Map<number, MemorySource[] | undefined>());

  const kindCounts = computed(() => {
    const counts: Partial<Record<NoteKind, number>> = {};
    for (const note of notes.value) counts[note.kind] = (counts[note.kind] ?? 0) + 1;
    return counts;
  });

  /** 关于谁：群、自己排前面，其余按笔记数 */
  const aboutOptions = computed(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const note of notes.value) {
      const entry = counts.get(note.about) ?? { label: note.aboutLabel, count: 0 };
      entry.count++;
      counts.set(note.about, entry);
    }
    const rank = (key: string) => (key === "group" ? 0 : key === "me" ? 1 : 2);
    return [...counts.entries()]
      .map(([value, { label, count }]) => ({ value, label, count }))
      .sort((a, b) => rank(a.value) - rank(b.value) || b.count - a.count);
  });

  const filtered = computed(() => {
    const q = query.value.trim().toLowerCase();
    return notes.value.filter((note) =>
      (kind.value === "all" || note.kind === kind.value)
      && (about.value === "all" || note.about === about.value)
      && (!privateOnly.value || note.private)
      && (!q || note.title.toLowerCase().includes(q) || note.content.toLowerCase().includes(q)),
    );
  });

  async function loadGroups() {
    try {
      groups.value = await send("mio/memory-groups") as MemoryGroup[];
      if (!groups.value.some((g) => g.groupId === groupId.value)) {
        groupId.value = [...groups.value].sort((a, b) => b.notes - a.notes)[0]?.groupId ?? "";
      }
    } catch (error) {
      message.error(`加载群列表失败: ${formatError(error)}`);
    }
  }

  async function loadGroup() {
    expanded.clear();
    if (!groupId.value) {
      notes.value = [];
      segments.value = [];
      return;
    }
    loading.value = true;
    try {
      const [n, s] = await Promise.all([
        send("mio/memory-notes", groupId.value) as Promise<MemoryNote[]>,
        send("mio/memory-segments", groupId.value) as Promise<MemorySegment[]>,
      ]);
      notes.value = n;
      segments.value = s;
    } catch (error) {
      message.error(`加载记忆失败: ${formatError(error)}`);
    } finally {
      loading.value = false;
    }
  }

  async function toggle(note: MemoryNote) {
    if (expanded.has(note.id)) {
      expanded.delete(note.id);
      return;
    }
    expanded.set(note.id, undefined);
    if (note.sources.length === 0) {
      expanded.set(note.id, []);
      return;
    }
    try {
      expanded.set(note.id, await send("mio/memory-sources", groupId.value, note.sources) as MemorySource[]);
    } catch (error) {
      expanded.delete(note.id);
      message.error(`加载出处失败: ${formatError(error)}`);
    }
  }

  watch(groupId, () => {
    kind.value = "all";
    about.value = "all";
    void loadGroup();
  });

  async function refresh() {
    const before = groupId.value;
    await loadGroups();
    // 选中的群变了时由 watch 加载
    if (groupId.value === before) await loadGroup();
  }

  return {
    groups,
    groupId,
    notes,
    segments,
    loading,
    kind,
    about,
    query,
    privateOnly,
    expanded,
    kindCounts,
    aboutOptions,
    filtered,
    toggle,
    refresh,
  };
}

export type MemoryBrowserController = ReturnType<typeof useMemoryBrowser>;
