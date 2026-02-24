import type { SearchRequest } from '../types/response';
import type { SearchResult } from './types';
import { BangumiSearch } from './sources/bangumi';
import { VNDBSearch } from './sources/vndb';
import { SearXNGSearch } from './sources/searxng';
import { SauceNAOSearch } from './sources/saucenao';
import { TraceMoeSearch } from './sources/tracemoe';
import { YandexImageSearch } from './sources/yandex';
import { SearchCompressor } from './compressor';
import { withTimeout } from './utils';
import type { LLMClient } from '../llm/client';
import type { ModelConfig } from '../llm/provider';
import * as https from 'https';
import * as http from 'http';

/**
 * 在本地下载图片到 Buffer。
 * 搜圖引擎（SauceNAO/Trace.moe）均为境外服务器，无法访问 QQ CDN。
 * 必须由 bot 这边先下载再以 form-data 上传。
 */
function downloadImage(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const chunks: Buffer[] = [];
    client.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

export interface SearchServiceConfig {
  searxngBaseUrl: string;
  bangumiUserAgent: string;
  saucenaoApiKey?: string;
  searchTimeoutMs: number;
  compressionModel: ModelConfig;
}

export class SearchService {
  private bangumi: BangumiSearch;
  private vndb: VNDBSearch;
  private searxng: SearXNGSearch | null;
  private saucenao: SauceNAOSearch | null;
  private tracemoe: TraceMoeSearch;
  private yandex: YandexImageSearch;
  private compressor: SearchCompressor;
  private readonly TIMEOUT_MS: number;

  constructor(llmClient: LLMClient, config: SearchServiceConfig) {
    this.bangumi = new BangumiSearch(config.bangumiUserAgent);
    this.vndb = new VNDBSearch();
    this.searxng = config.searxngBaseUrl ? new SearXNGSearch(config.searxngBaseUrl) : null;
    this.saucenao = config.saucenaoApiKey ? new SauceNAOSearch(config.saucenaoApiKey) : null;
    this.tracemoe = new TraceMoeSearch();
    this.yandex = new YandexImageSearch();
    this.compressor = new SearchCompressor(llmClient, config.compressionModel);
    this.TIMEOUT_MS = config.searchTimeoutMs;
  }

  /** 关闭持久资源（Yandex 浏览器实例等） */
  async dispose(): Promise<void> {
    await this.yandex.close();
  }

  async search(
    request: SearchRequest,
    resolveImageUrl?: (msgId: string, imageIndex: number) => string | null
  ): Promise<string> {
    const { query, hint, intent } = request;

    // 1. Select sources based on hint
    const sources: Promise<SearchResult[]>[] = [];

    switch (hint) {
      case 'anime':
        sources.push(this.bangumi.search(query || '', 'anime'));
        if (this.searxng) sources.push(this.searxng.search(query || ''));
        break;

      case 'galgame':
        sources.push(this.bangumi.search(query || '', 'galgame'));
        sources.push(this.vndb.search(query || ''));
        if (this.searxng) sources.push(this.searxng.search(query || ''));
        break;

      case 'music':
        if (this.searxng) sources.push(this.searxng.search(query || ''));
        break;

      case 'image':
        if (request.target_msg_id && resolveImageUrl) {
          const index = request.target_image_index ? request.target_image_index - 1 : 0;
          const imageUrl = resolveImageUrl(request.target_msg_id, index);
          if (!imageUrl) {
            return `（你想保存图片去搜，但图片好像已经看不到了或者出错了。）`;
          }
          // Must download locally first — SauceNAO/Trace.moe can't access QQ CDN
          const imageBuffer = await downloadImage(imageUrl).catch(() => null);
          if (!imageBuffer) {
            return `（你想搜图，但下载图片失败了。）`;
          }
          // Detect extension from URL for filename hint
          const extMatch = imageUrl.match(/\.([a-z]+)(?:[?#]|$)/i);
          const filename = `image.${extMatch?.[1] || 'jpg'}`;
          if (this.saucenao) sources.push(this.saucenao.search(imageBuffer, filename));
          sources.push(this.tracemoe.search(imageBuffer, filename));
          sources.push(this.yandex.search(imageBuffer, filename));
        } else {
          return `（没有指定要找的图片，搜图失败。）`;
        }
        break;

      case 'general':
      default:
        sources.push(this.bangumi.search(query || ''));
        if (this.searxng) sources.push(this.searxng.search(query || ''));
        break;
    }

    // 2. Parallel fetch with Promise.allSettled + global timeout
    // Image searches hit external APIs (SauceNAO, Trace.moe) which can be slow;
    // give them a longer timeout than regular text searches.
    const effectiveTimeout = hint === 'image' ? Math.max(this.TIMEOUT_MS * 3, 15000) : this.TIMEOUT_MS;
    try {
      const results = await Promise.allSettled(
        sources.map((source) => withTimeout(source, effectiveTimeout))
      );

      // 3. Collect successful results
      const allResults: SearchResult[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.length > 0) {
          allResults.push(...result.value);
        }
      }

      // 4. If no results: return fallback message
      if (allResults.length === 0) {
        return `（你刚用手机试图搜了一下「${query || '图片'}」，没搜找到什么有用的信息。）`;
      }

      // 5. Compress via LLM
      const fakeQuery = hint === 'image' ? `[图片搜索请求]` : (query || '');
      const compressed = await this.compressor.compress(fakeQuery, allResults, intent);

      return compressed;
    } catch (error) {
      console.error('Search service error:', error);
      return `（你刚用手机试图搜了一下「${query || '图片'}」，但完全没搜出来任何信息。）`;
    }
  }
}
