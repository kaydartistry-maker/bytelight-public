import type { SearchResult } from '../components/SearchResults';

export type SearchMode = 'keyword' | 'semantic';

export interface SearchPage {
  results: SearchResult[];
  total: number;
}

/** Typing waits this long for a pause before it searches. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * Flipping keyword/semantic reruns the current query straight away; only typing
 * is debounced.
 */
export function searchDelayMs(previousMode: SearchMode, mode: SearchMode): number {
  return previousMode === mode ? SEARCH_DEBOUNCE_MS : 0;
}

export function buildSearchRequest(query: string, mode: SearchMode): string {
  const endpoint = mode === 'semantic' ? '/api/search-semantic' : '/api/search';
  const limit = mode === 'semantic' ? 20 : 30;
  return `${endpoint}?q=${encodeURIComponent(query.trim())}&limit=${limit}`;
}

export function parseSearchPage(value: unknown): SearchPage {
  if (!value || typeof value !== 'object') return { results: [], total: 0 };
  const record = value as Record<string, unknown>;
  return {
    results: Array.isArray(record.results) ? record.results as SearchResult[] : [],
    total: typeof record.total === 'number' ? record.total : 0,
  };
}
