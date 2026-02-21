import type { SearchRequest } from '../types/response';
import type { SearchResult } from './types';
import { BangumiSearch } from './sources/bangumi';
import { VNDBSearch } from './sources/vndb';
import { SearXNGSearch } from './sources/searxng';
import { SearchCompressor } from './compressor';
import { withTimeout } from './utils';
import type { LLMClient } from '../llm/client';
import type { ModelConfig } from '../llm/provider';

export interface SearchServiceConfig {
  searxngBaseUrl: string;
  bangumiUserAgent: string;
  searchTimeoutMs: number;
  compressionModel: ModelConfig;
}

export class SearchService {
  private bangumi: BangumiSearch;
  private vndb: VNDBSearch;
  private searxng: SearXNGSearch | null;
  private compressor: SearchCompressor;
  private readonly TIMEOUT_MS: number;

  constructor(llmClient: LLMClient, config: SearchServiceConfig) {
    this.bangumi = new BangumiSearch(config.bangumiUserAgent);
    this.vndb = new VNDBSearch();
    this.searxng = config.searxngBaseUrl ? new SearXNGSearch(config.searxngBaseUrl) : null;
    this.compressor = new SearchCompressor(llmClient, config.compressionModel);
    this.TIMEOUT_MS = config.searchTimeoutMs;
  }

  async search(request: SearchRequest): Promise<string> {
    const { query, hint } = request;

    // 1. Select sources based on hint
    const sources: Promise<SearchResult[]>[] = [];

    switch (hint) {
      case 'anime':
        sources.push(this.bangumi.search(query, 'anime'));
        if (this.searxng) sources.push(this.searxng.search(query));
        break;

      case 'galgame':
        sources.push(this.bangumi.search(query, 'galgame'));
        sources.push(this.vndb.search(query));
        if (this.searxng) sources.push(this.searxng.search(query));
        break;

      case 'music':
        if (this.searxng) sources.push(this.searxng.search(query));
        break;

      case 'general':
      default:
        sources.push(this.bangumi.search(query, 'general'));
        if (this.searxng) sources.push(this.searxng.search(query));
        break;
    }

    // 2. Parallel fetch with Promise.allSettled + global timeout
    try {
      const timeoutPromise = withTimeout(
        Promise.allSettled(sources),
        this.TIMEOUT_MS
      );

      const results = await timeoutPromise;

      // 3. Collect successful results
      const allResults: SearchResult[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.length > 0) {
          allResults.push(...result.value);
        }
      }

      // 4. If no results: return fallback message
      if (allResults.length === 0) {
        return `（你刚用手机搜了一下「${query}」，没搜到什么有用的信息。）`;
      }

      // 5. Compress via LLM
      const compressed = await this.compressor.compress(query, allResults);

      return compressed;
    } catch (error) {
      console.error('Search service error:', error);
      return `（你刚用手机搜了一下「${query}」，没搜到什么有用的信息。）`;
    }
  }
}
