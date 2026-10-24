import { Activity, Cpu, LayoutPanelLeft, ShieldAlert } from "lucide-vue-next";

export interface ConsoleSection {
  id: "config" | "persona" | "runtime" | "maintenance";
  label: string;
  description: string;
  icon: any;
}

export const DEFAULT_CONSOLE_SECTION: ConsoleSection["id"] = "config";

export function createConsoleSections(): ConsoleSection[] {
  return [
    {
      id: "config",
      label: "模型配置",
      description: "管理 LLM 供应商与模型槽位。",
      icon: Cpu,
    },
    {
      id: "persona",
      label: "人设工作区",
      description: "管理人设、群绑定和缓存状态。",
      icon: LayoutPanelLeft,
    },
    {
      id: "runtime",
      label: "运行统计",
      description: "查看记忆与 Token 数据。",
      icon: Activity,
    },
    {
      id: "maintenance",
      label: "维护工具",
      description: "触发蒸馏、flush 和记忆迁移。",
      icon: ShieldAlert,
    },
  ];
}
