import React, { useEffect, useState } from 'react';
import { Sparkles, RefreshCw, Loader2, Check, X, Trash2 } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig, contrastTextColor } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch, useSelfKnowledgeVersion } from '../bytelight';
import { normalizeCompanionRows } from '../lib/companion-row';

interface SelfKnowledgeAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

type Category = 'i_am' | 'i_tend_to' | 'i_believe' | 'i_learned';
type Status = 'proposed' | 'accepted' | 'dismissed' | 'contradicted';

interface SelfKnowledgeEntry {
  id: string;
  companion_id: string;
  category: Category;
  content: string;
  source_type: string | null;
  source_id: string | null;
  status: Status;
  heat: number;
  confidence: number;
  effective_heat?: number;
  last_surfaced_at: string | null;
  created_at: string;
  reviewed_at: string | null;
}

interface Companion {
  slug: string;
  display_name: string;
  color: string | null;
  avatar_url: string | null;
}

const CATEGORY_LABEL: Record<Category, string> = {
  i_am: 'I am',
  i_tend_to: 'I tend to',
  i_believe: 'I believe',
  i_learned: "I've learned",
};

// Default view: things to review + what's been accepted. Dismissed hides
// unless asked for.
type Filter = 'review' | 'accepted' | 'dismissed' | string; // string = companion slug

export function SelfKnowledgeApp({ onClose, themeConfig, themeMode, embedded }: SelfKnowledgeAppProps) {
  const colors = themeConfig[themeMode];
  const [entries, setEntries] = useState<SelfKnowledgeEntry[]>([]);
  const [companions, setCompanions] = useState<Companion[]>([]);
  const [filter, setFilter] = useState<Filter>('review');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [skRes, companionsRes] = await Promise.all([
        apiFetch('/api/self-knowledge?limit=200').then((r) => (r.ok ? r.json() : { entries: [] })),
        apiFetch('/api/companions').then((r) => (r.ok ? r.json() : { companions: [] })),
      ]);
      setEntries(skRes.entries || []);
      setCompanions(normalizeCompanionRows(companionsRes.companions) as typeof companions);
    } catch (err) {
      console.error('Failed to load self-knowledge:', err);
    } finally {
      setLoading(false);
    }
  }

  // Re-fetch when main broadcasts self_knowledge (a proposal or a review).
  const selfKnowledgeVersion = useSelfKnowledgeVersion();
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfKnowledgeVersion]);

  async function review(entry: SelfKnowledgeEntry, status: 'accepted' | 'dismissed') {
    if (busy) return;
    setBusy(entry.id);
    try {
      const res = await apiFetch(`/api/self-knowledge/${entry.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        const updated = await res.json();
        setEntries((prev) => prev.map((e) => (e.id === entry.id ? updated : e)));
      }
    } catch (err) {
      console.error('Failed to review entry:', err);
    } finally {
      setBusy(null);
    }
  }

  async function remove(entry: SelfKnowledgeEntry) {
    if (busy) return;
    setBusy(entry.id);
    try {
      const res = await apiFetch(`/api/self-knowledge/${entry.id}`, { method: 'DELETE' });
      if (res.ok) setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    } catch (err) {
      console.error('Failed to delete entry:', err);
    } finally {
      setBusy(null);
    }
  }

  const companionOf = (slug: string) => companions.find((c) => c.slug === slug);

  const visible = entries.filter((e) => {
    if (filter === 'review') return e.status === 'proposed';
    if (filter === 'accepted') return e.status === 'accepted';
    if (filter === 'dismissed') return e.status === 'dismissed';
    return e.companion_id === filter && e.status !== 'dismissed';
  });
  const proposedCount = entries.filter((e) => e.status === 'proposed').length;

  // Matches the phone's standard tab-strip buttons (Memory/Agent/Studio):
  // uniform accent fill when selected, companion color only as unselected
  // text (owner's call, Jul 22 2026 — "keep your colors when they're not selected").
  function filterChip(value: Filter, label: string, accent?: string | null, badge?: number) {
    const active = filter === value;
    return (
      <button
        key={value}
        onClick={() => setFilter(value)}
        className={cn('shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border', colors.panelBorder, !active && colors.panelBg)}
        style={active
          ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent }
          : { color: accent || undefined }}
      >
        {label}
        {badge ? <span className="ml-1 opacity-80">{badge}</span> : null}
      </button>
    );
  }

  function entryCard(entry: SelfKnowledgeEntry) {
    const companion = companionOf(entry.companion_id);
    const accent = companion?.color || colors.accent;
    const proposed = entry.status === 'proposed';
    const dismissed = entry.status === 'dismissed';
    const contradicted = entry.status === 'contradicted';
    const accepted = entry.status === 'accepted';
    const heat = entry.effective_heat ?? entry.heat ?? 0;
    return (
      <div
        key={entry.id}
        className={cn('rounded-2xl border p-3 mb-2 backdrop-blur-md', colors.panelBg, colors.panelBorder)}
        style={{ borderLeftWidth: 3, borderLeftColor: accent, opacity: dismissed ? 0.5 : contradicted ? 0.6 : 1 }}
      >
        <div className="flex items-center gap-2">
          {companion?.avatar_url ? (
            <img src={companion.avatar_url} alt="" className="h-6 w-6 rounded-full object-cover shrink-0" style={{ boxShadow: `0 0 0 1.5px ${accent}` }} />
          ) : (
            <div className="h-6 w-6 rounded-full shrink-0" style={{ background: accent }} />
          )}
          <span className={cn('text-xs font-semibold', colors.textMain)}>{companion?.display_name || entry.companion_id}</span>
          <span
            className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
            style={{ background: 'rgba(127,127,127,0.15)', color: accent }}
          >
            {CATEGORY_LABEL[entry.category] || entry.category}
          </span>
          {accepted && (
            <span title="Accepted into identity">
              <Check size={12} style={{ color: accent }} />
            </span>
          )}
          {contradicted && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
              style={{ background: 'rgba(127,127,127,0.15)', color: 'var(--bytelight-text-muted)' }}
              title="Retired — this stopped holding true; it no longer surfaces, but you can restore it"
            >
              retired
            </span>
          )}
          {entry.source_type && (
            <span className={cn('ml-auto text-[10px] shrink-0', colors.textMuted)}>from {entry.source_type}</span>
          )}
        </div>

        {accepted && (
          <div className="mt-2 flex items-center gap-2" title={`Warmth ${Math.round(heat * 100)}% — rises when this surfaces in conversation, cools when it goes untouched${heat < 0.1 ? '. Dormant: not surfacing until it is lived again.' : ''}`}>
            <span className={cn('text-[9px] uppercase tracking-wider shrink-0', colors.textMuted)}>warmth</span>
            <div className="h-1 flex-1 rounded-full overflow-hidden" style={{ background: 'rgba(127,127,127,0.15)' }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(4, Math.round(heat * 100))}%`, background: accent, opacity: heat < 0.1 ? 0.4 : 0.85 }} />
            </div>
            {heat < 0.1 && <span className={cn('text-[9px] shrink-0', colors.textMuted)}>dormant</span>}
          </div>
        )}

        <div className={cn('mt-2 text-sm leading-relaxed', colors.textMain)}>
          {entry.content}
        </div>

        {proposed ? (
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => review(entry, 'accepted')}
              disabled={busy === entry.id}
              className="flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-semibold transition-opacity disabled:opacity-50"
              style={{ background: accent, color: contrastTextColor(accent) }}
            >
              {busy === entry.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              Accept
            </button>
            <button
              onClick={() => review(entry, 'dismissed')}
              disabled={busy === entry.id}
              className={cn('flex items-center gap-1 rounded-full border px-3 py-1 text-[11px] font-semibold transition-opacity disabled:opacity-50', colors.panelBorder, colors.textMuted)}
            >
              <X size={12} />
              Dismiss
            </button>
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-2">
            {(dismissed || contradicted) && (
              <button
                onClick={() => review(entry, 'accepted')}
                disabled={busy === entry.id}
                className={cn('flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold transition-opacity disabled:opacity-50', colors.panelBorder, colors.textMuted)}
                title={contradicted ? 'Restore — bring it back to full warmth' : 'Restore'}
              >
                <Check size={11} /> Restore
              </button>
            )}
            <button
              onClick={() => remove(entry)}
              disabled={busy === entry.id}
              className={cn('ml-auto flex items-center gap-1 rounded-full p-1.5 transition-colors hover:bg-black/10 dark:hover:bg-white/10 disabled:opacity-50', colors.textMuted)}
              title="Delete"
            >
              <Trash2 size={13} />
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <AppShell
      embedded={embedded}
      title="Self-Knowledge"
      icon={Sparkles}
      onClose={onClose}
      themeConfig={themeConfig}
      themeMode={themeMode}
      headerRight={
        <button
          onClick={() => load()}
          className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
          title="Refresh"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        </button>
      }
    >
      <div className={cn('p-3 rounded-2xl border backdrop-blur-md mb-4 flex items-center', colors.panelBg, colors.panelBorder)}>
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide flex-1">
          {filterChip('review', 'To review', colors.accent, proposedCount)}
          {filterChip('accepted', 'Accepted')}
          {companions.map((c) => filterChip(c.slug, c.display_name, c.color))}
          {filterChip('dismissed', 'Dismissed')}
        </div>
        {embedded && (
          <button
            onClick={() => load()}
            className={cn('shrink-0 ml-1.5 rounded-full p-1.5 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        )}
      </div>

      {loading && entries.length === 0 ? (
        <div className={cn('rounded-2xl border py-6 text-center text-xs backdrop-blur-md', colors.panelBg, colors.panelBorder, colors.textMuted)}>Loading…</div>
      ) : visible.length === 0 ? (
        <div className={cn('rounded-2xl border py-6 text-center text-xs backdrop-blur-md', colors.panelBg, colors.panelBorder, colors.textMuted)}>
          {filter === 'review'
            ? 'Nothing to review yet. What they learn about themselves will surface here.'
            : 'Nothing here yet.'}
        </div>
      ) : (
        visible.map(entryCard)
      )}
    </AppShell>
  );
}
