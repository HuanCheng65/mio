import { computed, reactive, ref } from "vue";
import { message, send } from "@koishijs/client";
import type { PromptName, PromptView } from "../types";

export const PROMPT_LABELS: Record<PromptName, { label: string; hint: string }> = {
  persona: { label: "人设", hint: "她是谁。和环境说明拼成 system，放在每次请求最前面。" },
  environment: { label: "环境说明", hint: "群聊、工具、log 格式这些规则。接在人设后面。" },
  reminder: { label: "说话提醒", hint: "唤醒时每一步请求末尾的提醒，只管那一轮。" },
  sleep: { label: "睡前整理", hint: "整理 log 时的说明，{time} 会换成当前时间。必须要求她以【群速写】【交接】收尾。" },
};

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function usePromptEditor() {
  const prompts = ref<PromptView[]>([]);
  const selected = ref<PromptName>("persona");
  /** 每个提示词的草稿；和服务器上一样时不算改动 */
  const drafts = reactive<Partial<Record<PromptName, string>>>({});
  const saving = ref(false);

  const current = computed(() => prompts.value.find((p) => p.name === selected.value) ?? null);
  const draft = computed({
    get: () => drafts[selected.value] ?? current.value?.content ?? "",
    set: (value: string) => {
      drafts[selected.value] = value;
    },
  });
  const isDirtyFor = (name: PromptName) => {
    const view = prompts.value.find((p) => p.name === name);
    return view !== undefined && drafts[name] !== undefined && drafts[name] !== view.content;
  };
  const isDirty = computed(() => prompts.value.some((p) => isDirtyFor(p.name)));

  function apply(views: PromptView[]) {
    prompts.value = views;
    for (const name of Object.keys(drafts) as PromptName[]) {
      if (!isDirtyFor(name)) delete drafts[name];
    }
  }

  async function refresh() {
    try {
      const views = await send("mio/prompts") as PromptView[];
      for (const name of Object.keys(drafts) as PromptName[]) delete drafts[name];
      prompts.value = views;
    } catch (error) {
      message.error(`加载提示词失败: ${formatError(error)}`);
    }
  }

  async function save() {
    const name = selected.value;
    saving.value = true;
    try {
      const views = await send("mio/prompt-save", name, draft.value) as PromptView[];
      delete drafts[name];
      apply(views);
      message.success(`${PROMPT_LABELS[name].label}已保存，下一次请求开始生效`);
    } catch (error) {
      message.error(`保存失败: ${formatError(error)}`);
    } finally {
      saving.value = false;
    }
  }

  function discard() {
    delete drafts[selected.value];
  }

  async function resetToSeed() {
    const name = selected.value;
    saving.value = true;
    try {
      const views = await send("mio/prompt-reset", name) as PromptView[];
      delete drafts[name];
      apply(views);
      message.success(`${PROMPT_LABELS[name].label}已恢复为文件里的版本`);
    } catch (error) {
      message.error(`恢复失败: ${formatError(error)}`);
    } finally {
      saving.value = false;
    }
  }

  return { prompts, selected, current, draft, saving, isDirty, isDirtyFor, refresh, save, discard, resetToSeed };
}

export type PromptEditorController = ReturnType<typeof usePromptEditor>;
