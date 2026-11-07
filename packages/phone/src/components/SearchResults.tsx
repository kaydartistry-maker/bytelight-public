import React from 'react';
import { Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '../lib/utils';
import type { ThemeConfig } from '../lib/theme';

export interface SearchResult {
  messageId: string;
  threadId: string;
  threadName: string;
  role: 'user' | 'companion' | 'system';
  content: string;
  highlight: string;
  createdAt: string;
}

interface SearchResultsProps {
  query: string;
  results: SearchResult[];
  total: number;
  loading: boolean;
  onSelect: (result: SearchResult) => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

// Wrap the matched query substring(s) with a highlight span. Case-insensitive,
// HTML-safe — we map characters by index rather than parsing markup.
function HighlightedText({
  text,
  query,
  accent,
}: {
  text: string;
  query: string;
  accent: string;
}) {
  if (!query.trim()) return <>{text}</>;
  const q = query.trim();
  const segments: React.ReactNode[] = [];
  const lc = text.toLowerCase();
  const lcq = q.toLowerCase();
  let cursor = 0;
  let i = lc.indexOf(lcq);
  let k = 0;
  while (i !== -1) {
    if (i > cursor) segments.push(<span key={k++}>{text.slice(cursor, i)}</span>);
    segments.push(
      <mark
        key={k++}
        className="bg-transparent font-semibold"
        style={{ color: accent, background: 'transparent' }}
      >
        {text.slice(i, i + q.length)}
      </mark>,
    );
    cursor = i + q.length;
    i = lc.indexOf(lcq, cursor);
  }
  if (cursor < text.length) segments.push(<span key={k++}>{text.slice(cursor)}</span>);
  return <>{segments}</>;
}

const ROLE_LABEL: Record<SearchResult['role'], string> = {
  user: 'You',
  companion: 'Companion',
  system: 'System',
};

export function SearchResults({
  query,
  results,
  total,
  loading,
  onSelect,
  themeConfig,
  themeMode,
}: SearchResultsProps) {
  const colors = themeConfig[themeMode];

  return (
    <div
      className={cn(
        'absolute left-3 right-3 top-full mt-2 z-30 max-h-[70vh] overflow-y-auto rounded-2xl border backdrop-blur-xl shadow-xl',
        colors.panelBg,
        colors.panelBorder,
      )}
    >
      {loading && (
        <div className={cn('flex items-center gap-2 px-4 py-3 text-xs', colors.textMuted)}>
          <Loader2 size={14} className="animate-spin" />
          Searching…
        </div>
      )}

      {!loading && query.trim() && results.length === 0 && (
        <div className={cn('px-4 py-6 text-center text-xs', colors.textMuted)}>
          No messages match “{query}”.
        </div>
      )}

      {!loading && results.length > 0 && (
        <>
          <div className={cn('px-4 py-2 text-[10px] uppercase tracking-wider opacity-60', colors.textMuted)}>
            {results.length} of {total} matches
          </div>
          <ul>
            {results.map((r) => (
              <li key={r.messageId}>
                <button
                  onClick={() => onSelect(r)}
                  className={cn(
                    'flex w-full flex-col gap-1 border-t px-4 py-3 text-left transition-colors',
                    colors.panelBorder,
                    themeMode === 'dark' ? 'hover:bg-white/5' : 'hover:bg-black/5',
                  )}
                >
                  <div className={cn('flex items-center gap-2 text-[10px] uppercase tracking-wider', colors.textMuted)}>
                    <span className="font-bold" style={{ color: colors.accent }}>
                      {ROLE_LABEL[r.role]}
                    </span>
                    <span className="truncate">{r.threadName}</span>
                    <span className="ml-auto whitespace-nowrap opacity-70">
                      {format(new Date(r.createdAt), 'MMM d, h:mm a')}
                    </span>
                  </div>
                  <p className={cn('truncate text-xs', colors.textMain)}>
                    <HighlightedText text={r.highlight || r.content} query={query} accent={colors.accent} />
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
