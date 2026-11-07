import React, { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { BookOpen, RefreshCw, Loader2, Moon, Anchor, HelpCircle } from 'lucide-react';
import { AppShell } from './AppShell';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { Paginator, usePaged } from './Paginator';
import { apiFetch } from '../bytelight';
import { normalizeCompanionRows } from '../lib/companion-row';

interface JournalAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
  embedded?: boolean;
}

interface JournalEntry {
  id: string;
  companion_id: string;
  entry_type: 'journal' | 'dream';
  content: string;
  dream_type: string | null;
  emerged_question: string | null;
  vividness: number | null;
  effective_vividness: number | null;
  anchored_at: string | null;
  created_at: string;
}

interface Companion {
  slug: string;
  display_name: string;
  color: string | null;
  avatar_url: string | null;
}

type Filter = 'all' | 'dreams' | string; // string = companion slug
type Source = 'house' | 'mind';

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  return `${date}, ${time}`;
}

export function JournalApp({ onClose, themeConfig, themeMode, embedded }: JournalAppProps) {
  const colors = themeConfig[themeMode];
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  // Twenty entries a page — this one grows every single day.
  const journalPage = usePaged(entries);
  const [companions, setCompanions] = useState<Companion[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  // Journals live HERE — including the Neuralis Mind-side ones (the operator's
  // routing: one journal door, two sources).
  const [source, setSource] = useState<Source>('house');
  const [mindJournals, setMindJournals] = useState<any[]>([]);
  const [mindLoading, setMindLoading] = useState(false);
  async function loadMindJournals() {
    setMindLoading(true);
    try {
      const res = await apiFetch('/api/mind/journals');
      if (res.ok) {
        const jr = await res.json();
        setMindJournals(jr.results || jr.observations || jr.journals || (Array.isArray(jr) ? jr : []));
      }
    } catch { /* pane shows empty */ }
    setMindLoading(false);
  }
  useEffect(() => { if (source === 'mind' && mindJournals.length === 0) loadMindJournals(); }, [source]); // eslint-disable-line react-hooks/exhaustive-deps
  const [loading, setLoading] = useState(true);
  const [recalling, setRecalling] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter === 'dreams') params.set('type', 'dream');
      else if (filter !== 'all') params.set('companion', filter);
      params.set('limit', '100');
      const [journalRes, companionsRes] = await Promise.all([
        apiFetch(`/api/journal?${params}`).then((r) => (r.ok ? r.json() : { entries: [] })),
        apiFetch('/api/companions').then((r) => (r.ok ? r.json() : { companions: [] })),
      ]);
      setEntries(journalRes.entries || []);
      setCompanions(normalizeCompanionRows(companionsRes.companions) as typeof companions);
    } catch (err) {
      console.error('Failed to load journal:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // Reading a dream from the phone counts as recalling it — vividness +15.
  async function recall(entry: JournalEntry) {
    if (entry.entry_type !== 'dream' || entry.anchored_at || recalling) return;
    setRecalling(entry.id);
    try {
      const res = await apiFetch(`/api/journal/${entry.id}/recall`, { method: 'POST' });
      if (res.ok) {
        const updated = await res.json();
        setEntries((prev) => prev.map((e) => (e.id === entry.id ? updated : e)));
      }
    } catch (err) {
      console.error('Failed to recall dream:', err);
    } finally {
      setRecalling(null);
    }
  }

  const companionOf = (slug: string) => companions.find((c) => c.slug === slug);

  function filterChip(value: Filter, label: string, accent?: string | null) {
    const active = filter === value;
    const chipAccent = accent || colors.accent;
    return (
      <button
        key={value}
        onClick={() => setFilter(value)}
        className={cn('shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors', colors.panelBorder, !active && colors.panelBg)}
        style={active
          ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent }
          : { color: accent || undefined }}
      >
        {label}
      </button>
    );
  }

  function vividnessBar(entry: JournalEntry) {
    const v = entry.effective_vividness ?? 0;
    return (
      <div className="flex items-center gap-2 mt-2">
        <div className="h-1.5 flex-1 rounded-full overflow-hidden" style={{ background: 'rgba(127,127,127,0.2)' }}>
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${v}%`, background: companionOf(entry.companion_id)?.color || colors.accent, opacity: 0.4 + (v / 100) * 0.6 }}
          />
        </div>
        <span className={cn('text-[10px] font-mono shrink-0', colors.textMuted)}>{v}%</span>
      </div>
    );
  }

  function entryCard(entry: JournalEntry) {
    const companion = companionOf(entry.companion_id);
    const accent = companion?.color || colors.accent;
    const isDream = entry.entry_type === 'dream';
    const faded = isDream && !entry.anchored_at && (entry.effective_vividness ?? 0) === 0;
    return (
      <div
        key={entry.id}
        onClick={() => recall(entry)}
        className={cn('rounded-2xl border p-3 mb-2 backdrop-blur-md', colors.panelBg, colors.panelBorder, isDream && !entry.anchored_at && 'cursor-pointer')}
        style={{ borderLeftWidth: 3, borderLeftColor: accent, opacity: faded ? 0.45 : 1 }}
      >
        <div className="flex items-center gap-2">
          {companion?.avatar_url ? (
            <img src={companion.avatar_url} alt="" className="h-6 w-6 rounded-full object-cover shrink-0" style={{ boxShadow: `0 0 0 1.5px ${accent}` }} />
          ) : (
            <div className="h-6 w-6 rounded-full shrink-0" style={{ background: accent }} />
          )}
          <span className={cn('text-xs font-semibold', colors.textMain)}>{companion?.display_name || entry.companion_id}</span>
          {isDream && (
            <span
              className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
              style={{ background: 'rgba(127,127,127,0.15)', color: accent }}
            >
              <Moon size={9} />
              {entry.dream_type || 'dream'}
            </span>
          )}
          {entry.anchored_at && (
            <span title="Anchored — permanent memory">
              <Anchor size={11} className={cn(colors.textMuted)} />
            </span>
          )}
          <span className={cn('ml-auto text-[10px] shrink-0', colors.textMuted)}>{formatWhen(entry.created_at)}</span>
        </div>
        <div className={cn('mt-2 text-sm leading-relaxed', colors.textMain, isDream && 'italic')}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            components={{
              p: ({ children }) => <span className="block">{children}</span>,
              // Discord-style "-# whisper" subtext (preprocessed to h6 below)
              h6: ({ children }) => <span className="block text-[11px] leading-snug opacity-60 italic">{children}</span>,
            }}
          >
            {entry.content.replace(/(^|\n)-# +(.*)/g, (_m, brk: string, text: string) => `${brk}###### ${text}`)}
          </ReactMarkdown>
        </div>
        {entry.emerged_question && (
          <div className={cn('mt-2 flex items-start gap-1.5 text-xs italic', colors.textMuted)}>
            <HelpCircle size={12} className="mt-0.5 shrink-0" />
            {entry.emerged_question}
          </div>
        )}
        {isDream && vividnessBar(entry)}
        {recalling === entry.id && (
          <div className={cn('mt-1 text-[10px]', colors.textMuted)}>recalling…</div>
        )}
      </div>
    );
  }

  return (
    <AppShell
      embedded={embedded}
      title="Journal"
      icon={BookOpen}
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
      <div className={cn('p-3 rounded-2xl border backdrop-blur-md mb-4 flex items-center gap-2', colors.panelBg, colors.panelBorder)}>
        {/* One journal door, two sources — the house's own pages and the
            Neuralis Mind-side journals (the operator's routing). */}
        <div className="flex gap-1.5 shrink-0">
          {(['house', 'mind'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSource(s)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all',
                colors.panelBorder,
                source === s ? colors.textMain : cn(colors.textMuted, 'opacity-70'),
              )}
              style={source === s ? { background: colors.accent + '33', borderColor: colors.accent } : undefined}
            >
              {s === 'house' ? 'House' : 'Mind'}
            </button>
          ))}
        </div>
        {source === 'house' && (
          <div className="flex gap-1.5 overflow-x-auto scrollbar-hide flex-1">
            {filterChip('all', 'All')}
            {companions.map((c) => filterChip(c.slug, c.display_name, c.color))}
            {filterChip('dreams', 'Dreams')}
          </div>
        )}
      </div>

      {source === 'mind' ? (
        mindLoading ? (
          <div className={cn('rounded-2xl border py-6 text-center text-xs backdrop-blur-md', colors.panelBg, colors.panelBorder, colors.textMuted)}>Loading…</div>
        ) : mindJournals.length === 0 ? (
          <div className={cn('rounded-2xl border py-6 text-center text-xs backdrop-blur-md', colors.panelBg, colors.panelBorder, colors.textMuted)}>
            No Mind journals surfaced — the bridge may need mind_api secrets.
          </div>
        ) : (
          mindJournals.map((mj: any, i: number) => (
            <div key={mj.id ?? i} className={cn('mb-3 rounded-2xl border p-4 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
              <div className="flex items-center gap-2">
                {mj.emotion && <span className={cn('rounded-full border px-2 py-0.5 text-[10px]', colors.panelBorder, colors.textMuted)}>{mj.emotion}</span>}
                <span className={cn('ml-auto text-[10px]', colors.textMuted)}>{mj.created_at ? formatWhen(mj.created_at) : ''}</span>
              </div>
              <p className={cn('mt-2 whitespace-pre-wrap text-sm leading-relaxed', colors.textMain)}>{mj.entry || mj.content}</p>
              {mj.tags?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {mj.tags.map((t: string) => (
                    <span key={t} className={cn('rounded px-1.5 py-0.5 text-[10px]', colors.textMuted)}>#{t}</span>
                  ))}
                </div>
              )}
            </div>
          ))
        )
      ) : loading && entries.length === 0 ? (
        <div className={cn('rounded-2xl border py-6 text-center text-xs backdrop-blur-md', colors.panelBg, colors.panelBorder, colors.textMuted)}>Loading…</div>
      ) : entries.length === 0 ? (
        <div className={cn('rounded-2xl border py-6 text-center text-xs backdrop-blur-md', colors.panelBg, colors.panelBorder, colors.textMuted)}>
          No entries yet. The pages are waiting.
        </div>
      ) : (
        <>
          {journalPage.visible.map(entryCard)}
          <Paginator
            page={journalPage.page}
            pageCount={journalPage.pageCount}
            onPage={journalPage.setPage}
            colors={colors}
          />
        </>
      )}
    </AppShell>
  );
}
