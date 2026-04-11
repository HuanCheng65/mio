import * as path from "path";
import { Context } from "koishi";
import { MemoryService } from "./memory";
import { tokenTracker } from "./llm/token-tracker";

export function registerConsoleListeners(ctx: Context, logger: any, memory: MemoryService | null): void {
  ctx.inject(["console"], (ctx) => {
    ctx.console.addEntry({
      dev: path.resolve(__dirname, "../client/index.ts"),
      prod: path.resolve(__dirname, "../dist"),
    });

    ctx.console.addListener("mio/memory-stats", async () => {
      if (!memory) {
        return {
          enabled: false,
          episodic: { active: 0, archived: 0 },
          relational: 0,
          semantic: 0,
        };
      }

      try {
        const episodicActive = await ctx.database.get("mio.episodic", { archived: false });
        const episodicArchived = await ctx.database.get("mio.episodic", { archived: true });
        const relational = await ctx.database.get("mio.relational", {});
        const semantic = await ctx.database.get("mio.semantic", {});

        return {
          enabled: true,
          episodic: {
            active: episodicActive.length,
            archived: episodicArchived.length,
          },
          relational: relational.length,
          semantic: semantic.length,
        };
      } catch (err) {
        logger.error("获取记忆统计失败:", err);
        throw err;
      }
    });

    ctx.console.addListener("mio/trigger-distillation", async () => {
      if (!memory) {
        throw new Error("记忆系统未启用");
      }

      try {
        logger.info("手动触发蒸馏...");
        await memory.runDistillation();
        return "蒸馏完成！已更新关系印象和语义事实。";
      } catch (err) {
        logger.error("手动蒸馏失败:", err);
        throw err;
      }
    });

    ctx.console.addListener("mio/flush-memory", async () => {
      if (!memory) {
        throw new Error("记忆系统未启用");
      }

      try {
        logger.info("手动 flush Working Memory...");
        await memory.flushWorkingMemory();
        return "Working Memory 已写入数据库！";
      } catch (err) {
        logger.error("手动 flush 失败:", err);
        throw err;
      }
    });

    ctx.console.addListener("mio/migrate-participants", async () => {
      try {
        logger.info("开始迁移 participants 字段...");

        const BOT_USER_ID = "bot";
        const BOT_IDENTIFIERS = ["澪", "mio", "999", "u999", "bot"];

        const allEpisodes = await ctx.database.get("mio.episodic", {});
        if (allEpisodes.length === 0) {
          return "没有需要迁移的记录";
        }

        logger.info(`找到 ${allEpisodes.length} 条记录`);
        let migratedCount = 0;
        let unchangedCount = 0;

        for (const episode of allEpisodes) {
          const originalParticipants = episode.participants || [];
          const cleanedParticipants: string[] = [];
          let hasChanges = false;

          for (const p of originalParticipants) {
            const original = String(p).trim();
            let cleaned = original;

            if (BOT_IDENTIFIERS.includes(original.toLowerCase())) {
              cleaned = BOT_USER_ID;
              if (original !== BOT_USER_ID) {
                hasChanges = true;
                logger.debug(`[ep=${episode.id}] Bot: "${original}" -> "${cleaned}"`);
              }
            } else if (/^u\d+$/.test(original)) {
              cleaned = original.substring(1);
              hasChanges = true;
              logger.debug(`[ep=${episode.id}] User: "${original}" -> "${cleaned}"`);
            } else if (/^\d+$/.test(original)) {
              cleaned = original;
            } else {
              logger.warn(`[ep=${episode.id}] 未知格式的 participant: "${original}"`);
              cleaned = original;
            }

            cleanedParticipants.push(cleaned);
          }

          const uniqueParticipants = [...new Set(cleanedParticipants)];
          if (hasChanges || uniqueParticipants.length !== originalParticipants.length) {
            await ctx.database.set("mio.episodic", { id: episode.id }, { participants: uniqueParticipants });
            migratedCount++;

            if (uniqueParticipants.length !== originalParticipants.length) {
              logger.debug(`[ep=${episode.id}] 去重: ${originalParticipants.length} -> ${uniqueParticipants.length}`);
            }
          } else {
            unchangedCount++;
          }
        }

        const allEpisodesAfter = await ctx.database.get("mio.episodic", {});
        const stats = {
          total: allEpisodesAfter.length,
          withBot: 0,
          withUsers: 0,
          withUnknown: 0,
        };

        for (const episode of allEpisodesAfter) {
          const participants = episode.participants || [];
          for (const p of participants) {
            const str = String(p);
            if (str === BOT_USER_ID) {
              stats.withBot++;
            } else if (/^\d+$/.test(str)) {
              stats.withUsers++;
            } else {
              stats.withUnknown++;
            }
          }
        }

        const result = `迁移完成！
已更新: ${migratedCount} 条
无需更改: ${unchangedCount} 条

验证结果:
- 总记录数: ${stats.total}
- Bot 参与: ${stats.withBot} 次
- 用户参与: ${stats.withUsers} 次
- 未知格式: ${stats.withUnknown} 次`;

        logger.info(result);
        return result;
      } catch (err) {
        logger.error("迁移失败:", err);
        throw err;
      }
    });

    ctx.console.addListener("mio/token-stats", () => {
      return tokenTracker.getStats();
    });

    ctx.console.addListener("mio/token-stats-reset", async () => {
      await tokenTracker.reset();
      return "统计已重置";
    });
  });
}
