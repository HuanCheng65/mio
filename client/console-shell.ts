import { Activity, Cpu } from "lucide-vue-next";

export interface ConsoleSection {
  id: "config" | "runtime";
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
      id: "runtime",
      label: "运行统计",
      icon: Activity,
    },
  ];
}
