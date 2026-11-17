import { Activity, BookOpen, Cpu, FileText } from "lucide-vue-next";

export interface ConsoleSection {
  id: "config" | "prompts" | "memory" | "runtime";
  label: string;
  icon: any;
}

export const DEFAULT_CONSOLE_SECTION: ConsoleSection["id"] = "config";

export function createConsoleSections(): ConsoleSection[] {
  return [
    {
      id: "config",
      label: "模型配置",
      icon: Cpu,
    },
    {
      id: "prompts",
      label: "提示词",
      icon: FileText,
    },
    {
      id: "memory",
      label: "记忆",
      icon: BookOpen,
    },
    {
      id: "runtime",
      label: "运行统计",
      icon: Activity,
    },
  ];
}
