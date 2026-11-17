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

  /** 并行查询多个源；单个源失败或超时不影响其他源，但要记下来 */
  private async collect(sources: Promise<SearchResult[]>[], timeoutMs: number): Promise<SearchResult[]> {
    const results = await Promise.allSettled(sources.map((source) => withTimeout(source, timeoutMs)));
    const all: SearchResult[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') all.push(...result.value);
      else console.warn('[SearchService] 搜索源失败:', result.reason);
    }
    return all;
  }

  private textSources(query: string, kind: 'anime' | 'galgame' | 'music' | 'general'): Promise<SearchResult[]>[] {
    const sources: Promise<SearchResult[]>[] = [];
    if (kind === 'anime') sources.push(this.bangumi.search(query, 'anime'));
    if (kind === 'galgame') sources.push(this.bangumi.search(query, 'galgame'), this.vndb.search(query));
    if (kind === 'general') sources.push(this.bangumi.search(query));
    if (this.searxng) sources.push(this.searxng.search(query));
    return sources;
  }

  /** 文字搜索并概括；没搜到返回 null */
  async searchText(query: string, kind: 'anime' | 'galgame' | 'music' | 'general', intent: string): Promise<string | null> {
    const results = await this.collect(this.textSources(query, kind), this.TIMEOUT_MS);
    return this.compressor.summarize(query, results, intent);
  }

  /** 以图搜源（画师、出处、番剧截图）；图片由调用方提供，境外搜图服务访问不到 QQ 的图片链接 */
  async searchImage(image: Buffer, filename: string, intent: string): Promise<string | null> {
    const sources: Promise<SearchResult[]>[] = [];
    if (this.saucenao) sources.push(this.saucenao.search(image, filename));
    sources.push(this.tracemoe.search(image, filename), this.yandex.search(image, filename));
    const results = await this.collect(sources, Math.max(this.TIMEOUT_MS * 3, 15000));
    return this.compressor.summarize('[图片搜索请求]', results, intent);
  }

  /** 关闭持久资源（Yandex 浏览器实例等） */
  async dispose(): Promise<void> {
    await this.yandex.close();
  }}
