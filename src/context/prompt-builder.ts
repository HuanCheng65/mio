import { Lunar } from "lunar-javascript";
import { getPromptManager } from "../memory/prompt-manager";
import { getPersonaLayer } from "./layer2-persona";

const promptManager = getPromptManager();

interface PromptOptions {
  groupId: string;
  userId: string;
  userProfile?: string;
  memories?: string;
  recentSummary?: string;
  backgroundKnowledge?: string;
  recentMessages: string;
}

export class PromptBuilder {
  private layer3Persona: string;

  constructor(personaFile: string) {
    this.layer3Persona = getPersonaLayer(personaFile);
  }

  /**
   * 构建 System Prompt
   * 优化前缀缓存：静态内容在前，动态内容在后
   */
  buildSystemPrompt(options: PromptOptions): string {
    const parts: string[] = [];

    // ===== 静态部分（完全不变，最大化缓存命中）=====

    // Layer 0: 认知框架
    parts.push(promptManager.getRaw("chat_system_layer0_cognitive"));

    // Layer 1: 行为原则
    parts.push("\n---\n");
    parts.push(promptManager.getRaw("chat_system_layer1_behavior"));

    // Layer 2: 输出格式说明（从 user prompt 移到这里，减少重复）
    parts.push("\n---\n");
    parts.push(promptManager.getRaw("chat_system_layer2_format"));

    // Layer 3: 人设 + Few-Shot 示范（很少变化）
    parts.push("\n---\n");
    parts.push(this.layer3Persona);

    // ===== 动态部分（变化频率：偶尔到频繁）=====

    // 当前时间信息（移到后面，避免破坏前面的缓存）
    const now = new Date();
    const lunar = Lunar.fromDate(now);
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const timeInfo = `\n---\n# 当前时间\n${now.getFullYear()}年${(now.getMonth() + 1).toString().padStart(2, "0")}月${now.getDate().toString().padStart(2, "0")}日 ${weekdays[now.getDay()]} ${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}\n农历${lunar.getYearInChinese()}年${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`;
    parts.push(timeInfo);

    // 记忆上下文（偶尔变化）
    if (
      options.userProfile ||
      options.memories ||
      options.recentSummary ||
      options.backgroundKnowledge
    ) {
      parts.push("\n");
      parts.push(promptManager.getRaw("chat_system_memory_prefix"));

      if (options.userProfile) {
        parts.push(`\n关于今天参与对话的人：\n${options.userProfile}`);
      }

      if (options.memories) {
        parts.push(`\n你有印象的最近的一些事：\n${options.memories}`);
      }

      if (options.recentSummary) {
        parts.push(`\n最近群里大概在聊什么：\n${options.recentSummary}`);
      }

      if (options.backgroundKnowledge) {
        parts.push(
          `\n你对最近提到的内容的模糊了解：\n（这些是你隐约听说过的，不要当精确事实背诵。不确定的就说不太清楚。）\n${options.backgroundKnowledge}`,
        );
      }
    }

    // 群聊消息记录（每次都变）
    parts.push("\n");
    parts.push(promptManager.getRaw("chat_system_history_prefix"));
    parts.push(`\n${options.recentMessages}`);

    // 尾部锚定（利用 recency bias 强化核心行为）
    parts.push("\n\n");
    parts.push(promptManager.getRaw("chat_system_anchor"));

    return parts.join("\n");
  }

  /**
   * 构建 User Prompt（简化版，格式说明已移到 system）
   */
  buildUserPrompt(newMessageMarker: string): string {
    return promptManager.get("chat_user_simple", {
      newMessages: newMessageMarker,
    });
  }
}
