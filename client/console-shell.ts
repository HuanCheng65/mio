import { Activity, Cpu, LayoutPanelLeft, ShieldAlert } from "lucide-vue-next";

export interface ConsoleSection {
  id: "config" | "persona" | "runtime" | "maintenance";
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
      id: "persona",
      label: "人设工作区",
      icon: LayoutPanelLeft,
    },
    {
      id: "runtime",
      label: "运行统计",
      icon: Activity,
    },
    {
      id: "maintenance",
      label: "维护工具",
      icon: ShieldAlert,
    },
  ];
}
