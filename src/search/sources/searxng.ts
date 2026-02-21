import type { SearchResult } from '../types';

export class SearXNGSearch {
  constructor(private readonly baseUrl: string) {}

  async search(query: string, language: string = 'zh-CN'): Promise<SearchResult[]> {
    try {
      const url = new URL(`${this.baseUrl}/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('categories', 'general');
      url.searchParams.set('language', language);

      const response = await fetch(url.toString());

      if (!response.ok) {
        console.warn(`SearXNG API error: ${response.status}`);
        return [];
      }

      const data = await response.json();

      if (!data.results || data.results.length === 0) {
        return [];
      }

      // Return top 3 results
      return data.results.slice(0, 3).map((item: any) => ({
        title: item.title || '',
        description: (item.content || '').substring(0, 200),
        url: item.url || '',
        source: 'searxng' as const
      }));
    } catch (error) {
      console.error('SearXNG search error:', error);
      return [];
    }
  }
}
