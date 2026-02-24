import type { SearchResult } from '../types';

export class SauceNAOSearch {
  private readonly baseUrl = 'https://saucenao.com/search.php';

  constructor(private readonly apiKey: string) { }

  /**
   * 以图搜图。接受图片 Buffer，通过 multipart/form-data 上传给 SauceNAO。
   * 不能传 QQ CDN 链接——SauceNAO 的境外服务器无法访问 gchat.qpic.cn。
   */
  async search(imageBuffer: Buffer, filename: string = 'image.jpg'): Promise<SearchResult[]> {
    if (!this.apiKey) return [];

    try {
      const form = new FormData();
      form.append('db', '999');           // 搜全部数据库
      form.append('testmode', '1');
      form.append('output_type', '2');    // JSON 格式
      form.append('api_key', this.apiKey);
      form.append('numres', '3');         // 每个 DB 最多 5 条，自己再筛 top 3
      form.append('minsim', '55');
      form.append('file', new Blob([new Uint8Array(imageBuffer)]), filename);

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        body: form,
      });

      if (!response.ok) {
        console.warn(`SauceNAO API error: ${response.status}`);
        return [];
      }

      const data = await response.json() as any;

      if (!data.results || data.results.length === 0) {
        return [];
      }

      // 1. 过滤、提取字段
      interface RawResult {
        similarity: number;
        title: string;
        description: string;
        url: string;
      }
      const raw: RawResult[] = [];
      const seenUrls = new Set<string>();

      for (const item of data.results) {
        const header = item.header;
        const d = item.data;

        const similarity = parseFloat(header.similarity);

        const url: string = d.ext_urls?.[0] || '';
        if (url && seenUrls.has(url)) continue;  // 去重（同一 Pixiv 作品会从多个 DB 命中）
        if (url) seenUrls.add(url);

        let title: string = d.title || d.source || url || '未知来源';
        if (d.part) title += ` Part ${d.part}`;

        // 画师名：Pixiv 用 member_name，其他来源用 author_name / creator
        const authorName: string = d.member_name || d.author_name || d.creator || '';
        // Pixiv 画师主页（有 member_id 时构造链接）
        const authorUrl: string = d.member_id ? `https://www.pixiv.net/users/${d.member_id}` : '';

        let description = `匹配度: ${similarity.toFixed(1)}%.`;
        if (authorName) description += ` 画师: ${authorName}${authorUrl ? ` (${authorUrl})` : ''}.`;
        if (d.characters) description += ` 角色: ${d.characters}.`;
        if (d.material) description += ` 作品: ${d.material}.`;
        if (d.eng_name) description += ` 英文名: ${d.eng_name}.`;

        raw.push({ similarity, title, description, url });
      }

      // 2. 按相似度降序，取 top 3
      raw.sort((a, b) => b.similarity - a.similarity);

      return raw.slice(0, 3).map(r => ({
        title: `SauceNAO: ${r.title}`,
        description: r.description,
        url: r.url,
        source: 'saucenao' as const,
      }));
    } catch (error) {
      console.error('SauceNAO search error:', error);
      return [];
    }
  }
}
