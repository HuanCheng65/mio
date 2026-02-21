import type { SearchResult } from '../types';

export class VNDBSearch {
  private readonly BASE = 'https://api.vndb.org/kana';

  async search(query: string): Promise<SearchResult[]> {
    try {
      const response = await fetch(`${this.BASE}/vn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filters: ['search', '=', query],
          fields: 'title, released, rating, description',
          results: 2
        })
      });

      if (!response.ok) {
        console.warn(`VNDB API error: ${response.status}`);
        return [];
      }

      const data = await response.json();

      if (!data.results || data.results.length === 0) {
        return [];
      }

      return data.results.map((item: any) => ({
        title: item.title || '',
        description: (item.description || '').substring(0, 200),
        url: `https://vndb.org/v${item.id}`,
        source: 'vndb' as const
      }));
    } catch (error) {
      console.error('VNDB search error:', error);
      return [];
    }
  }
}
