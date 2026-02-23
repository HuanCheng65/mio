import { Context } from "koishi";
import { MemoryContext, ClosenessTier } from "./types";
import { RetrievedMemory } from "./episodic";
import { WorkingMemory } from "./working-memory";
import { MioSemanticRow } from "./tables";
import { EmbeddingService } from "./embedding";

const CLOSENESS_LABELS: Record<ClosenessTier, string> = {
  stranger: "不太熟",
  acquaintance: "偶尔聊几句",
  familiar: "挺熟的",
  close: "老聊友了",
};

function formatTimeAgo(eventTime: number): string {
  const hours = (Date.now() - eventTime) / 3600_000;
  if (hours < 1) return "刚才";
  if (hours < 24) return `${Math.floor(hours)} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days <= 7) return `${days} 天前`;
  return `${Math.floor(days / 7)} 周前`;
}

export class ContextAssembler {
  constructor(
    private ctx: Context,
    private workingMemory: WorkingMemory,
    private embeddingService?: EmbeddingService,
  ) {}

  /**
   * 组装 Layer 3 动态上下文
   */
  async assemble(
    groupId: string,
    participantIds: string[],
    memories: RetrievedMemory[],
  ): Promise<MemoryContext> {
    const logger = this.ctx.logger('mio.memory');

    const [userProfile, episodicText, groupFactsText] = await Promise.all([
      this.buildUserProfile(groupId, participantIds),
      Promise.resolve(this.buildMemoriesText(memories)),
      this.buildGroupFacts(groupId),
    ]);

    // group facts（inside_joke 等）追加到 episodic memories 末尾
    const memoriesText = [episodicText, groupFactsText]
      .filter(Boolean)
      .join('\n');

    return { userProfile, memories: memoriesText };
  }

  private async buildUserProfile(
    groupId: string,
    participantIds: string[],
  ): Promise<string> {
    if (participantIds.length === 0) return "";

    const lines: string[] = [];

    for (const userId of participantIds) {
      const rows = await this.ctx.database.get("mio.relational", {
        groupId,
        userId,
      });

      if (rows.length === 0) continue;

      const rel = rows[0];
      const tier = (rel.closenessTier || "stranger") as ClosenessTier;
      const parts: string[] = [];

      // 称呼前缀
      let namePrefix = '';
      if (rel.preferredName) {
        namePrefix = `（大家叫他${rel.preferredName}）`;
      } else if (rel.displayName && this.looksLikeRealName(rel.displayName)) {
        // 群昵称看起来像正常名字时用作 fallback
        namePrefix = `（昵称${rel.displayName}）`;
      }
      // 否则不标注 — 澪就不主动叫名字

      // closeness 描述
      parts.push(CLOSENESS_LABELS[tier] || "不太熟");

      // 核心印象
      if (rel.coreImpression) {
        parts.push(rel.coreImpression);
      }

      // 近期印象
      if (rel.recentImpression) {
        parts.push(rel.recentImpression);
      }

      let line = `- ${userId}`;
      if (namePrefix) {
        line += ` ${namePrefix}`;
      }
      line += `: ${parts.join("。")}`;

      // Session vibe
      const vibe = this.workingMemory.getSessionVibe(groupId, userId);
      if (vibe) {
        line += `（${vibe.vibe}）`;
        const logger = this.ctx.logger('mio.memory');
        logger.debug(`[${groupId}] 活跃 vibe: ${userId} → ${vibe.vibe} (expires ${new Date(vibe.expiresAt).toLocaleTimeString('zh-CN')})`);
      }

      lines.push(line);

      // 加载 semantic facts 并追加（排除 preferred_name，因为已经显示了）
      const factsLine = await this.buildFactsLine(
        groupId,
        userId,
        rel.coreImpression,
        rel.recentImpression,
      );
      if (factsLine) {
        lines.push(factsLine);
      }
    }

    return lines.join("\n");
  }

  /**
   * 加载用户的 active semantic facts，过滤掉 impression 已涵盖的，拼接为 "你还记得：..." 行
   */
  private async buildFactsLine(
    groupId: string,
    userId: string,
    coreImpression: string,
    recentImpression: string,
  ): Promise<string | null> {
    // 加载 active facts（未被取代，confidence >= 0.3，排除 preferred_name）
    const allFacts = await this.ctx.database.get("mio.semantic", {
      groupId,
      subject: userId,
    });

    const activeFacts = allFacts.filter(
      (f) =>
        (f.supersededBy === null || f.supersededBy === undefined) &&
        f.confidence >= 0.3 &&
        f.factType !== "preferred_name", // 排除称呼信息，已在上面显示
    );

    if (activeFacts.length === 0) return null;

    // 简单关键词去重：过滤掉 impression 中已涵盖的内容
    const impressionText = `${coreImpression || ""} ${recentImpression || ""}`;
    const filtered = activeFacts.filter(
      (f) => !this.isContentCovered(f.content, impressionText),
    );

    if (filtered.length === 0) return null;

    // 按 confidence 降序，最多取 3 条
    const top = filtered
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);

    const factsText = top.map((f) => f.content).join("。");
    return `  你还记得：${factsText}`;
  }

  /**
   * 简单判断 fact 内容是否已被 impression 涵盖
   * 提取 fact 中的关键词（>= 2 字的词），检查 impression 中是否包含
   */
  private isContentCovered(
    factContent: string,
    impressionText: string,
  ): boolean {
    if (!impressionText) return false;
    // 提取 fact 中较长的片段作为关键词
    const keywords = factContent.match(/[\u4e00-\u9fff\w]{2,}/g) || [];
    // 如果超过一半的关键词都出现在 impression 中，认为已涵盖
    if (keywords.length === 0) return false;
    const covered = keywords.filter((kw) => impressionText.includes(kw)).length;
    return covered / keywords.length > 0.5;
  }

  /**
   * 判断昵称是否看起来像真实名字（不是 emoji、符号等）
   */
  private looksLikeRealName(displayName: string): boolean {
    // 简单规则：主要由中文、英文、数字组成，长度 2-10
    if (displayName.length < 2 || displayName.length > 10) return false;
    const normalChars = displayName.match(/[\u4e00-\u9fff\w]/g) || [];
    return normalChars.length / displayName.length > 0.7;
  }

  /**
   * 加载群级别的 semantic facts（subject="group"，如 inside_joke）
   * 这些是跨对话积累的群文化/梗，直接追加到 memories 末尾注入
   */
  private async buildGroupFacts(groupId: string): Promise<string> {
    const allFacts = await this.ctx.database.get('mio.semantic', {
      groupId,
      subject: 'group',
    });

    const activeFacts = allFacts.filter(
      (f) =>
        (f.supersededBy === null || f.supersededBy === undefined) &&
        f.confidence >= 0.5,
    );

    if (activeFacts.length === 0) return '';

    // 按 confidence 降序，最多取 3 条（避免注入过多）
    const top = activeFacts
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);

    return top.map((f) => `- ${f.content}`).join('\n');
  }

  private buildMemoriesText(memories: RetrievedMemory[]): string {
    if (memories.length === 0) return "";

    const active: string[] = [];
    const observer: string[] = [];

    for (const mem of memories) {
      const timeLabel = formatTimeAgo(mem.eventTime);
      const line = `- ${timeLabel} ${mem.summary}`;

      if (mem.mioInvolvement === "observer") {
        observer.push(line);
      } else {
        active.push(line);
      }
    }

    const parts: string[] = [];
    if (active.length > 0) {
      parts.push(active.join("\n"));
    }
    if (observer.length > 0) {
      parts.push(
        "（以下是你在群里看到但没参与的——你知道发生过，但别人不知道你看过）\n" +
          observer.join("\n"),
      );
    }

    return parts.join("\n\n");
  }
}
