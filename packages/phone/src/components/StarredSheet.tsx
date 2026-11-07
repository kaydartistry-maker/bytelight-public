// Starred — every starred message across threads, by whoever starred it.
// Behaviour ported from main's Svelte StarredDrawer: actor tabs, newest
// first, tap to open the message in its thread, unstar in place. Styled as
// the phone's search panel.
import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '../lib/utils';
import type { ThemeConfig } from '../lib/theme';
import { useHouseRoster } from '../lib/house';
import { HUMAN_STAR_ACTOR, listStarred, unstar as unstarMessage, type StarredItem } from '../bytelight';

interface StarredSheetProps {
  onSelect: (threadId: string, messageId: string) => void;
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

function snippet(content: string, contentType: string): string {
  if (contentType === 'image') return '🖼 image';
  if (contentType === 'audio') return '🎤 voice';
  if (contentType === 'file') return '📎 file';
  const trimmed = content.replace(/\s+/g, ' ').trim();
  return trimmed.length > 140 ? `${trimmed.slice(0, 140)}…` : trimmed;
}

export function StarredSheet({ onSelect, onClose, themeConfig, themeMode }: StarredSheetProps) {
  const colors = themeConfig[themeMode];
  const { companionSlugs, labelOf } = useHouseRoster();
  const [actor, setActor] = useState<string>(HUMAN_STAR_ACTOR);
  const [items, setItems] = useState<StarredItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    listStarred(actor)
      .then((data) => {
        if (stale) return;
        setItems(data.items);
        setCounts(data.counts);
      })
      .catch((err) => { if (!stale) setError(err instanceof Error ? err.message : 'Failed to load stars'); })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [actor]);

  // The viewer first, then the house's companions, then any other actor that
  // has starred something — a new companion appears without a code change.
  const tabs = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of [HUMAN_STAR_ACTOR, ...companionSlugs, ...Object.keys(counts), 'all']) {
      if (!seen.has(a)) { seen.add(a); out.push(a); }
    }
    return out;
  }, [companionSlugs, counts]);

  const tabLabel = (a: string) => {
    if (a === HUMAN_STAR_ACTOR) return 'Yours';
    if (a === 'all') return 'All';
    return labelOf(a);
  };

  const unstar = async (item: StarredItem, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await unstarMessage(item.message_id, item.starred_by);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setCounts((prev) => ({ ...prev, [item.starred_by]: Math.max((prev[item.starred_by] ?? 1) - 1, 0) }));
    } catch (err) {
      console.error('[Bytelight] Unstar failed:', err);
    }
  };

  return (
    <div
      className={cn(
        'absolute left-3 right-3 top-full mt-2 z-30 max-h-[70vh] overflow-y-auto rounded-2xl border backdrop-blur-xl shadow-xl',
        colors.panelBg,
        colors.panelBorder,
      )}
      role="dialog"
      aria-label="Starred messages"
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        <span className={cn('text-xs font-bold uppercase tracking-wider', colors.textMain)}>Starred</span>
        <span className={cn('text-[10px] opacity-60', colors.textMuted)}>
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </span>
        <button onClick={onClose} className={cn('ml-auto p-1 rounded-full opacity-60 hover:opacity-100', colors.textMuted)} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <div className="flex gap-1.5 overflow-x-auto px-4 py-2">
        {tabs.map((a) => {
          const active = a === actor;
          const count = a === 'all' ? Object.values(counts).reduce((s, n) => s + n, 0) : counts[a] ?? 0;
          return (
            <button
              key={a}
              onClick={() => setActor(a)}
              className={cn(
                'whitespace-nowrap rounded-full border px-3 py-1 text-[11px] transition-opacity',
                colors.panelBorder,
                active ? 'opacity-100 font-semibold' : 'opacity-60 hover:opacity-100',
              )}
              style={active ? { color: colors.accent, borderColor: colors.accent } : undefined}
            >
              {tabLabel(a)}{count > 0 ? ` · ${count}` : ''}
            </button>
          );
        })}
      </div>

      {loading && (
        <div className={cn('flex items-center gap-2 px-4 py-3 text-xs', colors.textMuted)}>
          <Loader2 size={14} className="animate-spin" />
          Loading…
        </div>
      )}

      {!loading && error && (
        <div className={cn('px-4 py-6 text-center text-xs', colors.textMuted)}>{error}</div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className={cn('px-4 py-6 text-center text-xs', colors.textMuted)}>Nothing starred here yet.</div>
      )}

      {!loading && !error && items.length > 0 && (
        <ul>
          {items.map((item) => {
            const gone = Boolean(item.message_deleted_at);
            return (
              <li key={item.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => { if (!gone) onSelect(item.thread_id, item.message_id); }}
                  onKeyDown={(e) => { if (!gone && (e.key === 'Enter' || e.key === ' ')) onSelect(item.thread_id, item.message_id); }}
                  className={cn(
                    'flex w-full flex-col gap-1 border-t px-4 py-3 text-left transition-colors',
                    colors.panelBorder,
                    gone ? 'opacity-50' : themeMode === 'dark' ? 'cursor-pointer hover:bg-white/5' : 'cursor-pointer hover:bg-black/5',
                  )}
                >
                  <div className={cn('flex items-center gap-2 text-[10px] uppercase tracking-wider', colors.textMuted)}>
                    <span className="font-bold" style={{ color: colors.accent }}>
                      {item.message_role === 'user' ? 'You' : item.message_role === 'system' ? 'System' : 'Companion'}
                    </span>
                    <span className="truncate">{item.thread_title || 'Thread'}</span>
                    {actor === 'all' && <span className="truncate opacity-70">★ {tabLabel(item.starred_by)}</span>}
                    <span className="ml-auto whitespace-nowrap opacity-70">
                      {format(new Date(item.starred_at), 'MMM d, h:mm a')}
                    </span>
                    <button
                      onClick={(e) => unstar(item, e)}
                      className="p-0.5 opacity-60 hover:opacity-100"
                      aria-label="Unstar"
                      title="Unstar"
                    >
                      <X size={12} />
                    </button>
                  </div>
                  <p className={cn('text-xs', colors.textMain)}>
                    {gone ? 'Message deleted' : snippet(item.message_content, item.message_content_type)}
                  </p>
                  {item.note && <p className={cn('text-[11px] italic opacity-70', colors.textMuted)}>{item.note}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
