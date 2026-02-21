import { Context } from "koishi";
import { LLMClient } from "../llm/client";
import { ModelConfig } from "../llm/provider";
import { MemoryConfig, DistillationResult, SignificantEvent } from "./types";
import { MioEpisodicRow, MioRelationalRow, MioSemanticRow } from "./tables";
import { getPromptManager } from "./prompt-manager";
import { EmbeddingService, cosineSimilarity } from "./embedding";

const promptManager = getPromptManager();

// ===== Helpers =====

function formatFacts(facts: MioSemanticRow[]): string {
  if (facts.length === 0) return "（暂无）";
  return facts
    .map(
      (f) =>
        `[id=${f.id}] ${f.subject}: ${f.content} (${f.factType}, confidence=${f.confidence})`,
    )
    .join("\n");
}

function formatEpisodes(episodes: MioEpisodicRow[]): string {
  return episodes
    .map((e) => {
      const date = new Date(e.eventTime).toLocaleDateString("zh-CN");
      const participants = e.participants.join(", ");
      return `[ep=${e.id}] ${date} [参与者: ${participants}] ${e.summary}`;
    })
    .join("\n");
}

function formatEvents(events: SignificantEvent[]): string {
  return events
    .map((e) => {
      const date = new Date(e.timestamp).toLocaleDateString("zh-CN");
      return `${date} ${e.description}（${e.emotionalTone}）`;
    })
    .join("\n");
}

function parseJSON(text: string): any | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ===== Main Pipeline =====

export class DistillationPipeline {
  constructor(
    private ctx: Context,
    private llm: LLMClient,
    private config: MemoryConfig,
    private embeddingService?: EmbeddingService,
  ) {}

  /**
   * 执行完整蒸馏流程（每日一次）
   */
  async run(): Promise<void> {
    const logger = this.ctx.logger("mio.distillation");
    logger.info("开始每日蒸馏...");

    try {
      // 获取所有活跃群（有 relational 记录的群）
      const allRel = await this.ctx.database.get("mio.relational", {});
      const groupIds = [...new Set(allRel.map((r) => r.groupId))];

      for (const groupId of groupIds) {
        await this.runForGroup(groupId);
      }

      // 全局清理
      await this.cleanup();

      logger.info("每日蒸馏完成");
    } catch (err) {
      logger.error("蒸馏失败:", err);
    }
  }

  private async runForGroup(groupId: string): Promise<void> {
    const logger = this.ctx.logger("mio.distillation");
    logger.info(`[${groupId}] 开始蒸馏...`);

    // Step 0: 补充缺失的 embeddings（历史数据修复）
    await this.backfillEmbeddings(groupId);

    // Step 1: Semantic Facts 蒸馏
    await this.distillSemanticFacts(groupId);

    // Step 2 & 3: Impression 更新
    const relations = await this.ctx.database.get("mio.relational", {
      groupId,
    });
    const sevenDaysAgo = Date.now() - 7 * 86400_000;

    for (const rel of relations) {
      // 只处理近 7 天有互动的用户
      if (rel.lastInteraction < sevenDaysAgo) continue;

      await this.updateRecentImpression(rel);
      await this.updateCoreImpression(rel);
    }

    logger.info(`[${groupId}] 蒸馏完成`);
  }

  /**
   * Step 0: 批量补充缺失的 embeddings（历史数据修复）
   */
  private async backfillEmbeddings(groupId: string): Promise<void> {
    const logger = this.ctx.logger("mio.distillation");

    if (!this.embeddingService) {
      logger.debug(`[${groupId}] 无 embedding service，跳过补充`);
      return;
    }

    const BATCH_SIZE = 100; // 每批处理 100 条

    // 1. 补充 Episodic Memory 的 embeddings
    const episodicWithoutEmbedding = await this.ctx.database.get(
      "mio.episodic",
      { groupId, archived: false },
    );
    const episodicToFix = episodicWithoutEmbedding.filter(
      (e) => !e.embedding || e.embedding.length === 0,
    );

    if (episodicToFix.length > 0) {
      logger.info(
        `[${groupId}] 补充 ${episodicToFix.length} 条 episodic embeddings...`,
      );

      // 分批处理
      for (let i = 0; i < episodicToFix.length; i += BATCH_SIZE) {
        const batch = episodicToFix.slice(i, i + BATCH_SIZE);
        try {
          const texts = batch.map((e) => e.summary);
          const embeddings = await this.embeddingService.embedBatch(texts);

          // 批量更新
          for (let j = 0; j < batch.length; j++) {
            await this.ctx.database.set(
              "mio.episodic",
              { id: batch[j].id },
              { embedding: embeddings[j] },
            );
          }
        } catch (err) {
          logger.warn(
            `补充 episodic batch ${i}-${i + batch.length} 失败:`,
            err,
          );
        }
      }
      logger.info(`[${groupId}] Episodic embeddings 补充完成`);
    }

    // 2. 补充 Semantic Facts 的 embeddings
    const semanticWithoutEmbedding = await this.ctx.database.get(
      "mio.semantic",
      { groupId },
    );
    const semanticToFix = semanticWithoutEmbedding.filter(
      (f) =>
        (!f.embedding || f.embedding.length === 0) &&
        (f.supersededBy === null || f.supersededBy === undefined),
    );

    if (semanticToFix.length > 0) {
      logger.info(
        `[${groupId}] 补充 ${semanticToFix.length} 条 semantic embeddings...`,
      );

      for (let i = 0; i < semanticToFix.length; i += BATCH_SIZE) {
        const batch = semanticToFix.slice(i, i + BATCH_SIZE);
        try {
          const texts = batch.map((f) => f.content);
          const embeddings = await this.embeddingService.embedBatch(texts);

          for (let j = 0; j < batch.length; j++) {
            await this.ctx.database.set(
              "mio.semantic",
              { id: batch[j].id },
              { embedding: embeddings[j] },
            );
          }
        } catch (err) {
          logger.warn(
            `补充 semantic batch ${i}-${i + batch.length} 失败:`,
            err,
          );
        }
      }
      logger.info(`[${groupId}] Semantic embeddings 补充完成`);
    }
  }

  /**
   * Step 1: Semantic Facts 蒸馏
   */
  private async distillSemanticFacts(groupId: string): Promise<void> {
    const logger = this.ctx.logger("mio.distillation");
    const sevenDaysAgo = Date.now() - 7 * 86400_000;

    // 加载近 7 天未 archived、未 distilled 的 episodic memories
    const recentEpisodes = (
      await this.ctx.database.get("mio.episodic", {
        groupId,
        archived: false,
        distilled: false,
      })
    ).filter((e) => e.eventTime >= sevenDaysAgo);

    if (recentEpisodes.length === 0) {
      logger.debug(`[${groupId}] 无近期记忆，跳过语义蒸馏`);
      return;
    }

    // 加载现有 active semantic facts
    const existingFacts = (
      await this.ctx.database.get("mio.semantic", {
        groupId,
      })
    ).filter((f) => f.supersededBy === null || f.supersededBy === undefined);

    // LLM 调用
    const prompt = promptManager.get("semantic_distill", {
      existingFacts: formatFacts(existingFacts),
      recentEpisodes: formatEpisodes(recentEpisodes),
    });

    const response = await this.llm.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: "请分析以上记忆并更新认知。" },
      ],
      this.config.distillation,
      { temperature: 0.3, maxTokens: 1000, responseFormat: "json_object" },
    );

    const raw = parseJSON(response.content);
    if (!raw) {
      logger.warn(`[${groupId}] 语义蒸馏 LLM 输出解析失败`);
      return;
    }

    // LLM 输出 snake_case，映射到 camelCase
    const result: DistillationResult = {
      newFacts: (raw.new_facts || []).map((f: any) => ({
        subject: f.subject,
        factType: f.fact_type || "trait",
        content: f.content,
        confidence: f.confidence ?? 0.5,
      })),
      confirmedFacts: (raw.confirmed_facts || []).map((f: any) => ({
        id: f.id,
        newConfidence: f.new_confidence ?? 0.5,
      })),
      evolvedFacts: (raw.evolved_facts || []).map((f: any) => ({
        oldFactId: f.old_fact_id,
        newContent: f.new_content,
        newConfidence: f.new_confidence ?? 0.5,
      })),
      decayedFacts: (raw.decayed_facts || []).map((f: any) => ({
        id: f.id,
        newConfidence: f.new_confidence ?? 0.2,
      })),
    };

    const now = Date.now();
    const episodeIds = recentEpisodes.map((e) => e.id);

    // 处理 new_facts（添加 embedding 去重）
    for (const fact of result.newFacts || []) {
      // 生成 embedding
      let embedding: number[] = [];
      if (this.embeddingService) {
        try {
          embedding = await this.embeddingService.embed(fact.content);
        } catch (err) {
          logger.warn("生成 fact embedding 失败:", err);
        }
      }

      // 检查是否与现有 facts 相似（阈值 0.9）
      if (embedding.length > 0) {
        const similar = existingFacts.find(
          (f) =>
            f.subject === fact.subject &&
            f.factType === fact.factType &&
            f.embedding &&
            f.embedding.length > 0 &&
            cosineSimilarity(embedding, f.embedding) >= 0.9,
        );

        if (similar) {
          // 相似 fact 已存在，提升 confidence 而不是创建新条目
          const newConfidence = Math.min(1.0, similar.confidence + 0.1);
          await this.ctx.database.set(
            "mio.semantic",
            { id: similar.id },
            {
              confidence: newConfidence,
              lastConfirmed: now,
            },
          );
          logger.debug(
            `合并相似 fact [${similar.id}]: ${fact.content.slice(0, 30)}...`,
          );
          continue;
        }
      }

      // 创建新 fact
      await this.ctx.database.create("mio.semantic", {
        groupId,
        subject: fact.subject,
        factType: fact.factType || "trait",
        content: fact.content,
        embedding,
        confidence: Math.max(0, Math.min(1, fact.confidence)),
        sourceEpisodes: episodeIds,
        firstObserved: now,
        lastConfirmed: now,
        supersededBy: null,
        createdAt: now,
      });
    }

    // 处理 confirmed_facts
    for (const cf of result.confirmedFacts || []) {
      const existing = existingFacts.find((f) => f.id === cf.id);
      if (existing) {
        await this.ctx.database.set(
          "mio.semantic",
          { id: cf.id },
          {
            confidence: Math.max(0, Math.min(1, cf.newConfidence)),
            lastConfirmed: now,
          },
        );
      }
    }

    // 处理 evolved_facts（时间线叙事）
    for (const ef of result.evolvedFacts || []) {
      const oldFact = existingFacts.find((f) => f.id === ef.oldFactId);
      if (!oldFact) continue;

      // 生成新 fact 的 embedding
      let embedding: number[] = [];
      if (this.embeddingService) {
        try {
          embedding = await this.embeddingService.embed(ef.newContent);
        } catch (err) {
          logger.warn("生成 evolved fact embedding 失败:", err);
        }
      }

      // 创建新 fact
      const newFact = await this.ctx.database.create("mio.semantic", {
        groupId,
        subject: oldFact.subject,
        factType: oldFact.factType,
        content: ef.newContent,
        embedding,
        confidence: Math.max(0, Math.min(1, ef.newConfidence)),
        sourceEpisodes: [...oldFact.sourceEpisodes, ...episodeIds],
        firstObserved: oldFact.firstObserved,
        lastConfirmed: now,
        supersededBy: null,
        createdAt: now,
      });

      // 旧 fact 标记为被取代
      await this.ctx.database.set(
        "mio.semantic",
        { id: ef.oldFactId },
        {
          supersededBy: newFact.id,
        },
      );
    }

    // 处理 decayed_facts
    for (const df of result.decayedFacts || []) {
      const existing = existingFacts.find((f) => f.id === df.id);
      if (existing) {
        await this.ctx.database.set(
          "mio.semantic",
          { id: df.id },
          {
            confidence: Math.max(0, Math.min(1, df.newConfidence)),
          },
        );
      }
    }

    const counts = {
      new: result.newFacts?.length || 0,
      confirmed: result.confirmedFacts?.length || 0,
      evolved: result.evolvedFacts?.length || 0,
      decayed: result.decayedFacts?.length || 0,
    };
    logger.info(
      `[${groupId}] 语义蒸馏: +${counts.new} 新, ${counts.confirmed} 确认, ${counts.evolved} 演进, ${counts.decayed} 衰减`,
    );

    // 标记这些 episodes 为已蒸馏（信息已备份到 semantic）
    if (episodeIds.length > 0) {
      await this.ctx.database.set(
        "mio.episodic",
        { id: { $in: episodeIds } },
        { distilled: true, distilledAt: now },
      );
      logger.debug(
        `[${groupId}] 已标记 ${episodeIds.length} 条 episodic memories 为已蒸馏`,
      );
    }

    // 后处理：同步 preferred_name facts 到 relationship 表
    const { updateKnownNames } = await import("./name-learning");
    for (const fact of result.newFacts || []) {
      if (fact.factType === "preferred_name") {
        await updateKnownNames(this.ctx, groupId, fact.subject, fact.content);
        logger.debug(
          `[${groupId}] 更新称呼: ${fact.subject} -> ${fact.content}`,
        );
      }
    }
  }

  /**
   * Step 2: Recent Impression 重写
   */
  private async updateRecentImpression(rel: MioRelationalRow): Promise<void> {
    const logger = this.ctx.logger("mio.distillation");
    const events = (rel.significantEvents || []).filter((e) => !e.consumed);

    if (events.length === 0) return;

    const prompt = promptManager.get("recent_impression", {
      displayName: rel.displayName,
      events: formatEvents(events),
      coreImpression: rel.coreImpression || "（暂无）",
    });

    const response = await this.llm.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: "请生成近期印象补充。" },
      ],
      this.config.distillation,
      { temperature: 0.3, maxTokens: 200, responseFormat: "json_object" },
    );

    const result = parseJSON(response.content);
    if (!result) {
      logger.warn(`[${rel.groupId}] ${rel.displayName} 近期印象 LLM 解析失败`);
      return;
    }

    const recentImpression = (result.recent_impression || "").slice(0, 60);

    // 标记 events 为已消费
    const updatedEvents: SignificantEvent[] = (rel.significantEvents || []).map(
      (e) => ({
        ...e,
        consumed: true,
      }),
    );

    await this.ctx.database.set(
      "mio.relational",
      { id: rel.id },
      {
        recentImpression,
        recentImpressionUpdatedAt: Date.now(),
        significantEvents: updatedEvents,
      },
    );

    if (recentImpression) {
      logger.debug(
        `[${rel.groupId}] ${rel.displayName} 近期印象: ${recentImpression}`,
      );
    }
  }

  /**
   * Step 3: Core Impression 条件更新
   */
  private async updateCoreImpression(rel: MioRelationalRow): Promise<void> {
    const logger = this.ctx.logger("mio.distillation");
    const events = rel.significantEvents || [];
    const unconsumedEvents = events.filter((e) => !e.consumed);

    // 触发条件判断
    const hasHighImportance = unconsumedEvents.some((e) => e.importance >= 0.8);
    const hasManyConsistent =
      unconsumedEvents.length >= 5 &&
      this.isEmotionallyConsistent(unconsumedEvents);
    const isNewUser = !rel.coreImpression;

    if (!hasHighImportance && !hasManyConsistent && !isNewUser) return;

    const prompt = promptManager.get("core_impression", {
      displayName: rel.displayName,
      coreImpression: rel.coreImpression || "（暂无，这是新认识的人）",
      events: formatEvents(events.slice(-10)),
    });

    const response = await this.llm.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: "请判断是否需要更新核心印象。" },
      ],
      this.config.distillation,
      { temperature: 0.3, maxTokens: 200, responseFormat: "json_object" },
    );

    const result = parseJSON(response.content);
    if (!result) {
      logger.warn(`[${rel.groupId}] ${rel.displayName} 核心印象 LLM 解析失败`);
      return;
    }

    if (result.unchanged) return;

    const newImpression = (result.new_impression || "").slice(0, 80);
    if (!newImpression) return;

    await this.ctx.database.set(
      "mio.relational",
      { id: rel.id },
      {
        coreImpression: newImpression,
        coreImpressionUpdatedAt: Date.now(),
      },
    );

    logger.info(
      `[${rel.groupId}] ${rel.displayName} 核心印象更新: ${newImpression}`,
    );
  }

  private isEmotionallyConsistent(events: SignificantEvent[]): boolean {
    if (events.length < 2) return true;
    const tones = events.map((e) => e.emotionalTone);
    // 简单判断：如果超过 60% 的情感基调相同，认为一致
    const counts = new Map<string, number>();
    for (const tone of tones) {
      counts.set(tone, (counts.get(tone) || 0) + 1);
    }
    const maxCount = Math.max(...counts.values());
    return maxCount / tones.length >= 0.6;
  }

  /**
   * 清理：过期 events、archived episodic、容量驱逐
   */
  private async cleanup(): Promise<void> {
    const logger = this.ctx.logger("mio.distillation");
    const now = Date.now();
    const fourteenDaysAgo = now - 14 * 86400_000;

    // 1. 清理 consumed + 超过 14 天的 significant_events
    const allRel = await this.ctx.database.get("mio.relational", {});
    for (const rel of allRel) {
      const events = rel.significantEvents || [];
      const filtered = events.filter(
        (e) => !(e.consumed && e.timestamp < fourteenDaysAgo),
      );
      if (filtered.length < events.length) {
        await this.ctx.database.set(
          "mio.relational",
          { id: rel.id },
          {
            significantEvents: filtered,
          },
        );
      }
    }

    // 2. Episodic: retention < 0.1 → archived
    // retention = importance * recency_factor * access_bonus
    // 已蒸馏的条目打 0.6 折（信息已备份到 semantic）
    const activeEpisodic = await this.ctx.database.get("mio.episodic", {
      archived: false,
    });

    let archivedCount = 0;
    for (const ep of activeEpisodic) {
      const daysSince = (now - ep.eventTime) / 86400_000;
      const recency = Math.pow(0.5, daysSince / 14); // 14 天半衰期
      const accessBonus = Math.min(ep.accessCount * 0.05, 0.3);
      let retention = ep.importance * recency + accessBonus;

      // 已蒸馏的条目，信息已有备份，保留价值降低
      if (ep.distilled) {
        retention *= 0.6;
      }

      if (retention < 0.1) {
        await this.ctx.database.set(
          "mio.episodic",
          { id: ep.id },
          {
            archived: true,
          },
        );
        archivedCount++;
      }
    }

    // 3. 容量驱逐：超过 activePoolLimit 时淘汰保留价值最低的
    const remaining = activeEpisodic.length - archivedCount;
    if (remaining > this.config.activePoolLimit) {
      const toEvict = remaining - this.config.activePoolLimit;
      // 按 retention 排序，淘汰最低的
      const scored = activeEpisodic
        .filter((ep) => {
          const daysSince = (now - ep.eventTime) / 86400_000;
          const recency = Math.pow(0.5, daysSince / 14);
          const accessBonus = Math.min(ep.accessCount * 0.05, 0.3);
          let retention = ep.importance * recency + accessBonus;
          if (ep.distilled) retention *= 0.6;
          return retention >= 0.1; // 只看还没被 archived 的
        })
        .map((ep) => {
          const daysSince = (now - ep.eventTime) / 86400_000;
          const recency = Math.pow(0.5, daysSince / 14);
          const accessBonus = Math.min(ep.accessCount * 0.05, 0.3);
          let retention = ep.importance * recency + accessBonus;
          if (ep.distilled) retention *= 0.6;
          return {
            id: ep.id,
            retention,
          };
        })
        .sort((a, b) => a.retention - b.retention);

      for (let i = 0; i < Math.min(toEvict, scored.length); i++) {
        await this.ctx.database.set(
          "mio.episodic",
          { id: scored[i].id },
          {
            archived: true,
          },
        );
        archivedCount++;
      }
    }

    if (archivedCount > 0) {
      logger.info(`清理: archived ${archivedCount} 条 episodic 记忆`);
    }
  }
}
