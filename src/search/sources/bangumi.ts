import type { SearchResult } from "../types";

export class BangumiSearch {
  private readonly BASE = "https://api.bgm.tv";
  private readonly USER_AGENT: string;

  constructor(userAgent: string = "starrydream/mio-bot/1.0") {
    this.USER_AGENT = userAgent;
  }

  async search(
    query: string,
    hint?: "anime" | "galgame" | "music" | "general",
  ): Promise<SearchResult[]> {
    try {
      // Type mapping based on hint
      const typeMap: Record<string, number[]> = {
        anime: [2], // 动画
        galgame: [4], // 游戏
        music: [3], // 音乐
        general: [1, 2, 3, 4, 6], // 书籍、动画、音乐、游戏、三次元
      };

      const types = hint ? typeMap[hint] : typeMap.general;

      const response = await fetch(`${this.BASE}/v0/search/subjects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": this.USER_AGENT,
        },
        body: JSON.stringify({
          keyword: query,
          filter: {
            type: types,
          },
        }),
      });

      if (!response.ok) {
        console.warn(`Bangumi API error: ${response.status}`);
        return [];
      }

      const data = await response.json();

      if (!data.data || data.data.length === 0) {
        return [];
      }

      // Return top 2 results
      return data.data.slice(0, 2).map((item: any) => ({
        title: item.name_cn || item.name || "",
        description: (item.summary || "").substring(0, 200),
        url: `https://bgm.tv/subject/${item.id}`,
        source: "bangumi" as const,
      }));
    } catch (error) {
      console.error("Bangumi search error:", error);
      return [];
    }
  }
}
