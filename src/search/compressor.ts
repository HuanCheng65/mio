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

  async compress(query: string, results: SearchResult[]): Promise<string> {
    if (results.length === 0) {
      return `你刚用手机搜了一下「${query}」，没搜到什么有用的信息。`;
    }

    // Filter out results with empty title and description
    const validResults = results.filter(r => r.title.trim() || r.description.trim());

    if (validResults.length === 0) {
      console.warn(`All search results for "${query}" have empty title and description`);
      return `你刚用手机搜了一下「${query}」，没搜到什么有用的信息。`;
    }

    try {
      // Build results text
      const resultsText = validResults.map((r, i) =>
        `${i + 1}. ${r.title || '(无标题)'}\n   ${r.description || '(无描述)'}\n   来源：${r.source}`
      ).join('\n\n');

      // Load and interpolate prompt template
      const promptManager = getPromptManager();
      const prompt = promptManager.get('search_compression_prompt', {
        query,
        results: resultsText
      });

      console.log(`[SearchCompressor] Compressing ${validResults.length} results for "${query}"`);
      console.log(`[SearchCompressor] Results text:\n${resultsText}`);

      const messages: ChatMessage[] = [
        { role: 'user', content: prompt }
      ];

      const response = await this.llmClient.chat(messages, this.config, {
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens
      });

      const compressed = response.content.trim();

      console.log(`[SearchCompressor] LLM response: ${compressed}`);

      // Fallback: if LLM fails or returns empty, concatenate titles
      if (!compressed || compressed.length === 0) {
        const titles = validResults.map(r => r.title).filter(t => t).join('、');
        return titles || '没搜到什么有用的信息';
      }

      // Format as injection text
      return `（你刚用手机搜了一下「${query}」：${compressed}）`;
    } catch (error) {
      console.error('Search compression error:', error);
      // Fallback: concatenate titles
      const titles = validResults.map(r => r.title).filter(t => t).join('、');
      return `（你刚用手机搜了一下「${query}」：${titles || '没搜到什么有用的信息'}）`;
    }
  }
}
