import type { SearchResult } from '../types';

export class TraceMoeSearch {
  private readonly baseUrl = 'https://api.trace.moe/search';

  /**
   * 以图搜番剧截图来源。接受图片 Buffer，通过 multipart/form-data 上传给 Trace.moe。
   * 不能传 QQ CDN 链接——Trace.moe 的境外服务器无法访问 gchat.qpic.cn。
   */
  async search(imageBuffer: Buffer, filename: string = 'image.jpg'): Promise<SearchResult[]> {
    try {
      const form = new FormData();
      form.append('image', new Blob([new Uint8Array(imageBuffer)]), filename);

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        body: form,
      });

      if (!response.ok) {
        console.warn(`TraceMoe API error: ${response.status}`);
        return [];
      }

      const data = await response.json() as any;

      if (!data.result || data.result.length === 0) {
        return [];
      }

      const results: SearchResult[] = [];
      const topResults = data.result.slice(0, 2);

      for (const item of topResults) {
        // Trace.moe returns similarity as 0.0 to 1.0
        if (item.similarity < 0.75) continue;

        let title = item.filename || '未知番剧';
        if (item.anilist) {
          title = `AniList ID: ${item.anilist}`;
        }

        let description = `匹配度: ${(item.similarity * 100).toFixed(1)}%.`;
        if (item.episode) description += ` 剧集: ${item.episode}.`;
        if (item.from && item.to) {
          const fromMin = Math.floor(item.from / 60);
          const fromSec = Math.floor(item.from % 60);
          description += ` 时间戳: ${fromMin}:${fromSec.toString().padStart(2, '0')}.`;
        }

        results.push({
          title: `Trace.moe: ${title}`,
          description,
          url: item.video || '',
          source: 'tracemoe',
        });
      }

      return results;
    } catch (error) {
      console.error('TraceMoe search error:', error);
      return [];
    }
  }
}
