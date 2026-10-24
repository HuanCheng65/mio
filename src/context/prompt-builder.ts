import { Lunar } from "lunar-javascript";
import { createHash } from "node:crypto";
import { getPromptManager } from "../memory/prompt-manager";
import { getPersonaLayer } from "./layer2-persona";
import { ALLOWED_REACT_EMOJI_TEXT } from "../emoji/react-policy";

const promptManager = getPromptManager();

interface PromptOptions {
  personaContent?: string;
  includeStaticCore?: boolean;
  userProfile?: string;
  groupCulture?: string;
  memories?: string;
  recentSummary?: string;
  backgroundKnowledge?: string;
  stickerSummary?: string;
}

interface UserPromptOptions {
  recentMessages: string;
  recentBotCount: number;
}

interface StaticCoreOptions {
  personaContent: string;
}

interface PromptStaticCore {
  text: string;
  promptVersion: string;
}

export class PromptBuilder {
  private layer3Persona: string;
  private personaFile: string;

  constructor(personaFile: string) {
    this.personaFile = personaFile;
    this.layer3Persona = getPersonaLayer(personaFile);
  }

  reloadPersona(): void {
    this.layer3Persona = getPersonaLayer(this.personaFile);
  }

  getPersonaLength(): number {
    return this.layer3Persona.length;
  }

  getPersonaPreview(): string {
    return this.layer3Persona.split("\n")[0];
  }

  /**
   * 构建稳定静态前缀，供缓存层复用。
   */
  buildStaticCore(options: StaticCoreOptions): PromptStaticCore {
    const parts: string[] = [];

    parts.push(promptManager.getRaw("chat_system_layer0_cognitive"));
    parts.push("\n---\n");
    parts.push(promptManager.getRaw("chat_system_layer1_behavior"));
    parts.push("\n---\n");
    parts.push(
      promptManager.get("chat_system_layer2_format", {
        allowedReactEmojis: ALLOWED_REACT_EMOJI_TEXT,
      }),
    );
    parts.push("\n---\n");
    parts.push(options.personaContent);

    const text = parts.join("\n");
    const promptVersion = createHash("sha256").update(text).digest("hex");
    return { text, promptVersion };
  }

  /**
   * 构建 System Prompt
   * 优化前缀缓存：静态内容在前，动态内容在后
   */
  buildSystemPrompt(options: PromptOptions): string {
    const parts: string[] = [];
    const staticCore = this.buildStaticCore({
      personaContent: options.personaContent ?? this.layer3Persona,
    });

    if (options.includeStaticCore !== false) {
      parts.push(staticCore.text);
    }

    // ===== 动态部分（变化频率：偶尔到频繁）=====

    // 记忆上下文（偶尔变化，放在时间之前以最大化缓存命中）
    if (
      options.userProfile ||
      options.groupCulture ||
      options.memories ||
      options.recentSummary ||
      options.backgroundKnowledge
    ) {
      parts.push("\n");
      parts.push(promptManager.getRaw("chat_system_memory_prefix"));

      if (options.userProfile) {
        parts.push(`\n关于今天参与对话的人：\n${options.userProfile}`);
      }

      if (options.groupCulture) {
        parts.push(`\n你对这个群的了解：\n${options.groupCulture}`);
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

    if (options.stickerSummary) {
      parts.push("\n");
      parts.push(options.stickerSummary);
    }

    return parts.join("\n");
  }

  /**
   * 构建 User Prompt（包含时间、recent history、anchor，每轮都变）
   */
  buildUserPrompt(options: UserPromptOptions): string {
    const activity =
      options.recentBotCount > 0
        ? `（你最近 5 分钟内说了 ${options.recentBotCount} 条消息。）\n`
        : "";
    return promptManager.get("chat_user_simple", {
      currentTime: this.buildTimeInfo(),
      recentMessages: options.recentMessages,
      recentBotActivity: activity,
      historyPrefix: promptManager.getRaw("chat_history_prefix"),
      anchor: promptManager.getRaw("chat_anchor"),
    });
  }

  buildTimeInfo(): string {
    const now = new Date();
    const lunar = Lunar.fromDate(now);
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return `${now.getFullYear()}年${(now.getMonth() + 1).toString().padStart(2, "0")}月${now.getDate().toString().padStart(2, "0")}日 ${weekdays[now.getDay()]} ${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}\n农历${lunar.getYearInChinese()}年${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`;
  }
}
