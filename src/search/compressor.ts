import type { LLMClient, ChatMessage } from '../llm/client';
import type { ModelConfig } from '../llm/provider';
import type { SearchResult } from './types';
import { getPromptManager } from '../memory/prompt-manager';

export class SearchCompressor {
  private llmClient: LLMClient;
  private config: ModelConfig;

  constructor(llmClient: LLMClient, config: ModelConfig) {
    this.llmClient = llmClient;
    this.config = config;
  }

  /**
   * 从搜索结果里提取和意图相关的信息，用一两句话概括。
   * 没有有效结果返回 null；模型调用失败或返回空内容直接抛出。
   */
  async summarize(query: string, results: SearchResult[], intent: string): Promise<string | null> {
    const validResults = results.filter(r => r.title.trim() || r.description.trim());
    if (validResults.length === 0) return null;

    const resultsText = validResults.map((r, i) =>
      `${i + 1}. ${r.title || '(无标题)'}\n   ${r.description || '(无描述)'}\n   来源：${r.source}`
    ).join('\n\n');

    const prompt = getPromptManager().get('search_compression_prompt', {
      query,
      results: resultsText,
      intent
    });

    const response = await this.llmClient.chat([{ role: 'user', content: prompt }], this.config, {
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      purpose: "search-compression",
    });

    const compressed = response.content.trim();
    if (!compressed) throw new Error(`search compression for "${query}" returned empty content`);
    return compressed;
  }

  async compress(query: string, results: SearchResult[], intent: string): Promise<string> {
    try {
      const summary = await this.summarize(query, results, intent);
      if (summary === null) return `你刚用手机搜了一下「${query}」，没搜到什么有用的信息。`;
      return `（你刚用手机搜了一下「${query}」：${summary}）`;
    } catch (error) {
      console.error('Search compression error:', error);
      // Fallback: concatenate titles
      const titles = results.map(r => r.title).filter(t => t).join('、');
      return `（你刚用手机搜了一下「${query}」：${titles || '没搜到什么有用的信息'}）`;
    }
  }
}
