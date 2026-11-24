// Spellbook — drop a picture, cast yourselves into it; and every prompt the operator
// ever hoarded, on one wall, one tap from being made.
//
//  wall   search · All / Mine / Community / Not made · tag chips · masonry pins
//         (renders as pictures, never-made prompts as text cards with Make it)
//         · Drop a picture · Surprise me
//  spell  every render of that scene in a strip · Run with… · copy prompt /
//         no names · Share card · where it came from
//  cast   a dropped picture (Recast it) or a spell from the book (Make it):
//         who's in it, look, size. Renders queue one at a time in the house,
//         so the operator can line up five and walk away.
//  looks  style boards · vaults  the import screen
//
// Backend: packages/backend/src/routes/spellbook.ts.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft, BookOpen, Copy, ImagePlus, Loader2, Palette, Plus, Repeat, Search, Share2, Shuffle, Sparkles, Trash2, Users, Wand2,
} from 'lucide-react';
import { apiFetch } from '../../bytelight';
import { cn } from '../../lib/utils';
import { thumbSrc } from '../../lib/thumb';
import type { ThemeColors } from '../../lib/theme';
import { ACCENT_TEXT_COLOR_BY_THEME } from './constants';
import { copyStudioText } from './gallery-utils';
import type { RefDrawer, ThemeMode } from './types';
import {
  FILTERS, MARKERS, MAX_CAST, SIZES, castNames, jsonOrError, lookLine, makeShareCard, readLastCast, rememberCast, shareOrSave,
  type Look, type Render, type Spell, type SpellFilter,
} from './spellbook/shared';
import { SpellbookLooks } from './spellbook/SpellbookLooks';
import { SpellbookVaults } from './spellbook/SpellbookVaults';

interface Result { spell: Spell; prompt: string; promptNoNames: string; cast: string[]; jobId: string }
type Stage = 'idle' | 'reading' | 'casting' | 'done' | 'failed';
type View = 'wall' | 'cast' | 'spell' | 'looks' | 'vaults';
interface Job { id: string; status: string }

interface SpellbookPanelProps {
  active: boolean;
  colors: ThemeColors;
  themeMode: ThemeMode;
  /** The Create / Spellbook / GIF Lab / Cutout / Gallery switcher. */
  topSlot?: ReactNode;
  /** Open straight into Looks: 'new' starts a new look (Create's New look tile). */
  openLooks?: string | null;
}

export function SpellbookPanel({ active, colors, themeMode, topSlot, openLooks }: SpellbookPanelProps) {
  const [view, setView] = useState<View>(openLooks ? 'looks' : 'wall');
  const [drawers, setDrawers] = useState<RefDrawer[]>([]);
  const [looks, setLooks] = useState<Look[]>([]);
  const [looksStart, setLooksStart] = useState<string | null>(openLooks ?? null);

  // The wall
  const [spells, setSpells] = useState<Spell[]>([]);
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [counts, setCounts] = useState<Record<SpellFilter, number>>({ all: 0, mine: 0, community: 0, unmade: 0 });
  const [filter, setFilter] = useState<SpellFilter>('all');
  const [tag, setTag] = useState('');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [stale, setStale] = useState(true);
  const [queue, setQueue] = useState<Job[]>([]);

  // An open spell
  const [openSpell, setOpenSpell] = useState<Spell | null>(null);
  const [renders, setRenders] = useState<Render[]>([]);
  const [shown, setShown] = useState(0);

  // Casting
  const [castSpell, setCastSpell] = useState<Spell | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [cast, setCast] = useState<string[]>(readLastCast);
  const [look, setLook] = useState('');
  const [size, setSize] = useState('portrait');
  const [credit, setCredit] = useState('');
  const [link, setLink] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [stage, setStage] = useState<Stage>('idle');
  const [result, setResult] = useState<Result | null>(null);
  const [resultUrl, setResultUrl] = useState('');
  const [failure, setFailure] = useState('');
  const [note, setNote] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const castRef = useRef<HTMLDivElement>(null);
  const lookRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const watching = useRef<string | null>(null);
  useEffect(() => () => { alive.current = false; }, []);

  const busy = stage === 'reading';
  const accentStyle = { backgroundColor: colors.accent, color: ACCENT_TEXT_COLOR_BY_THEME[themeMode] };
  const nameFor = useCallback((slug: string) => drawers.find((d) => d.slug === slug)?.label ?? slug, [drawers]);
  const marker = (d: RefDrawer) => (d.isDefault ? (MARKERS[d.slug] ?? '') : (d.emoji ?? ''));
  const defaultLookId = useMemo(() => looks.find((l) => l.isDefault)?.id ?? 'grungy-film', [looks]);
  const lookById = (id: string | null | undefined) => looks.find((l) => l.id === id);

  // ─── Loading ──────────────────────────────────────────────────
  const loadSetup = useCallback(async () => {
    const [r, l] = await Promise.all([apiFetch('/api/studio/refs'), apiFetch('/api/studio/spellbook/looks')]).catch(() => [null, null] as const);
    if (!alive.current) return;
    if (r?.ok) {
      const ds: RefDrawer[] = (await r.json()).drawers ?? [];
      setDrawers(ds);
      setCast((c) => c.filter((s) => ds.some((d) => d.slug === s)));
    }
    if (l?.ok) setLooks((await l.json()).looks ?? []);
  }, []);

  const loadWall = useCallback(async () => {
    const qs = new URLSearchParams({ filter });
    if (tag) qs.set('tag', tag);
    if (debounced.trim()) qs.set('q', debounced.trim());
    try {
      const d = await jsonOrError(await apiFetch(`/api/studio/spellbook/spells?${qs}`));
      if (!alive.current) return;
      setSpells(d.spells ?? []); setTags(d.tags ?? []); if (d.counts) setCounts(d.counts);
    } catch { /* keep the wall that is up */ }
    setLoaded(true); setStale(false);
  }, [filter, tag, debounced]);

  useEffect(() => { if (active && !drawers.length) void loadSetup(); }, [active, drawers.length, loadSetup]);
  useEffect(() => { const t = setTimeout(() => setDebounced(query), 300); return () => clearTimeout(t); }, [query]);
  useEffect(() => { setStale(true); }, [filter, tag, debounced]);
  useEffect(() => { if (active && view === 'wall' && stale) void loadWall(); }, [active, view, stale, loadWall]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(''), 2400); return () => clearTimeout(t); }, [note]);
  useEffect(() => () => { if (preview.startsWith('blob:')) URL.revokeObjectURL(preview); }, [preview]);

  // The line: renders waiting or running, visible from the wall.
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const tick = async () => {
      const r = await apiFetch('/api/studio/jobs').catch(() => null);
      if (stop || !r?.ok) return;
      const jobs: Job[] = ((await r.json()).jobs ?? []).filter((j: Job) => j.status === 'pending' || j.status === 'running');
      setQueue((prev) => { if (prev.length && jobs.length < prev.length) setStale(true); return jobs; });
    };
    void tick();
    const t = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [active]);

  const openSpellPage = async (s: Spell) => {
    setOpenSpell(s); setRenders([]); setShown(0); setView('spell');
    try {
      const d = await jsonOrError(await apiFetch(`/api/studio/spellbook/spells/${encodeURIComponent(s.id)}`));
      if (alive.current) { setOpenSpell(d.spell); setRenders(d.renders ?? []); }
    } catch { /* the card data is enough to show */ }
  };

  // ─── Casting ──────────────────────────────────────────────────
  const toggleCast = (slug: string) => setCast((c) => (c.includes(slug) ? c.filter((s) => s !== slug) : c.length >= MAX_CAST ? c : [...c, slug]));

  const resetCast = () => { setStage('idle'); setResult(null); setResultUrl(''); setFailure(''); watching.current = null; };

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    setCastSpell(null); setFile(f); setPreview(URL.createObjectURL(f)); resetCast(); setView('cast');
  };

  // The picker belongs to the input on the screen that opened it. Flipping to
  // the cast screen first unmounts that input, so the first picture was lost;
  // with no file yet, the flip waits for pickFile.
  const startDrop = () => {
    setCastSpell(null); setLook(defaultLookId); resetCast();
    if (!file) { fileInput.current?.click(); return; }
    setView('cast');
  };

  const startRun = (s: Spell) => {
    setCastSpell(s); setFile(null); setPreview(s.cover ?? s.sourceUrl ?? '');
    setLook(s.look && lookById(s.look) ? s.look : defaultLookId);
    resetCast(); setView('cast');
  };

  const watchJob = async (jobId: string) => {
    watching.current = jobId;
    setStage('casting');
    for (;;) {
      await new Promise((res) => setTimeout(res, 3000));
      if (!alive.current || watching.current !== jobId) return;
      const r = await apiFetch(`/api/studio/jobs/${encodeURIComponent(jobId)}`).catch(() => null);
      if (watching.current !== jobId) return;
      if (!r?.ok) { setStage('failed'); setFailure('Lost track of the render. It will still pin itself to the wall.'); return; }
      const j = await r.json();
      if (j.status === 'completed') { setResultUrl(j.url); setStage('done'); setStale(true); return; }
      if (j.status === 'failed') { setStage('failed'); setFailure(j.error || 'The render failed.'); return; }
    }
  };

  const landed = (d: any, withCast: string[]) => {
    rememberCast(withCast);
    setResult({ spell: d.spell, prompt: d.prompt, promptNoNames: d.promptNoNames, cast: [...withCast], jobId: d.jobId });
    setStale(true);
    void watchJob(d.jobId);
  };

  const castDropped = async () => {
    if (!file || !cast.length || busy) return;
    resetCast(); setStage('reading');
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('cast', JSON.stringify(cast));
    fd.append('look', look || defaultLookId);
    fd.append('size', size);
    if (credit.trim()) fd.append('credit', credit.trim());
    if (link.trim()) fd.append('link', link.trim());
    try {
      const d = await jsonOrError(await apiFetch('/api/studio/spellbook/cast', { method: 'POST', body: fd }));
      landed(d, cast);
      setCastSpell(d.spell); setFile(null);
    } catch (e) { setStage('failed'); setFailure(e instanceof Error ? e.message : 'The spell fizzled.'); }
  };

  const runSpell = async (s: Spell, withCast: string[], withLook: string) => {
    if (!withCast.length || busy) return;
    resetCast();
    // The house fits the scene to who's in it (parts, wardrobe) before it renders.
    setStage('reading');
    try {
      const d = await jsonOrError(await apiFetch('/api/studio/spellbook/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spellId: s.id, cast: withCast, look: withLook, size }),
      }));
      landed(d, withCast);
      setNote(queue.length ? `In the line · ${queue.length + 1} rendering` : 'Casting');
    } catch (e) { setStage('failed'); setFailure(e instanceof Error ? e.message : 'The spell fizzled.'); }
  };

  const surprise = async () => {
    const qs = new URLSearchParams({ filter });
    if (tag) qs.set('tag', tag);
    if (view === 'spell' && openSpell) qs.set('exclude', openSpell.id);
    try {
      const d = await jsonOrError(await apiFetch(`/api/studio/spellbook/surprise?${qs}`));
      void openSpellPage(d.spell);
    } catch (e) { setNote(e instanceof Error ? e.message : 'Nothing to pull.'); }
  };

  const copy = async (text: string, what: string) => {
    try { await copyStudioText(text); setNote(`${what} copied`); }
    catch { setNote('Copy failed — long-press the prompt instead'); }
  };

  const share = async (imageUrl: string, title: string, promptNoNames: string, spellCredit: string | null) => {
    try {
      const blob = await makeShareCard({ imageUrl, title, prompt: promptNoNames, credit: spellCredit, accent: colors.accent });
      const how = await shareOrSave(blob, `${title.replace(/[^\w -]/g, '').trim() || 'spell'}.png`);
      setNote(how === 'shared' ? 'Card shared' : 'Card saved');
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setNote(e instanceof Error ? e.message : 'Could not make the card.');
    }
  };

  const removeSpell = async (s: Spell) => {
    if (!window.confirm(`Take "${s.title}" out of the book? Its pictures stay in Gallery.`)) return;
    try { await jsonOrError(await apiFetch(`/api/studio/spellbook/spells/${encodeURIComponent(s.id)}`, { method: 'DELETE' })); setStale(true); setView('wall'); setNote('Taken out of the book'); }
    catch (e) { setNote(e instanceof Error ? e.message : 'Could not take it out.'); }
  };

  // ─── Shared pieces ────────────────────────────────────────────
  const card = cn('rounded-2xl border p-4 backdrop-blur-md', colors.panelBg, colors.panelBorder);
  const soft = cn('flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors disabled:opacity-40', colors.panelBorder, colors.textMain, 'hover:bg-black/5 dark:hover:bg-white/5');
  const chip = (on: boolean) => cn('shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors disabled:opacity-40', on ? 'font-semibold' : cn(colors.panelBorder, colors.textMain));
  const chipStyle = (on: boolean) => (on ? { borderColor: colors.accent, color: colors.accent, backgroundColor: 'color-mix(in srgb, ' + colors.accent + ' 14%, transparent)' } : undefined);
  const label = cn('mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em]', colors.textMuted);
  const backBtn = (onClick: () => void, disabled = false) => (
    <button type="button" onClick={onClick} disabled={disabled} aria-label="Back to the Spellbook"
      className={cn('rounded-xl border p-2 transition-colors disabled:opacity-40', colors.panelBorder, colors.textMain)}>
      <ArrowLeft className="h-4 w-4" />
    </button>
  );
  const hiddenInput = (
    <input ref={fileInput} type="file" accept="image/*" className="hidden"
      onChange={(e) => { pickFile(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
  );
  const toast = note ? (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-30 flex justify-center">
      <span className="rounded-full px-4 py-2 text-sm font-medium shadow-lg" style={accentStyle}>{note}</span>
    </div>
  ) : null;
  const creditBadge = (s: Spell) => (s.credit ? <span className={cn('inline-block rounded-full border px-2 py-0.5 text-[11px]', colors.panelBorder, colors.textMuted)}>{s.credit}</span> : null);

  // ─── Looks / vaults ───────────────────────────────────────────
  if (view === 'looks') {
    return (
      <>
        <SpellbookLooks colors={colors} accentStyle={accentStyle} looks={looks} startWith={looksStart}
          onBack={() => { setLooksStart(null); setView(castSpell || file ? 'cast' : 'wall'); }}
          onChanged={setLooks} onNote={setNote} />
        {toast}
      </>
    );
  }
  if (view === 'vaults') {
    return (
      <>
        <SpellbookVaults colors={colors} accentStyle={accentStyle} onBack={() => setView('wall')} onImported={() => setStale(true)} onNote={setNote} />
        {toast}
      </>
    );
  }

  // ─── The wall ─────────────────────────────────────────────────
  if (view === 'wall') {
    return (
      <div className="bytelight-app-body relative flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-32">
          {topSlot}
          <div className="mb-3 flex items-center gap-2">
            <h3 className={cn('flex-1 text-lg font-semibold', colors.textMain)}>Spellbook</h3>
            <button type="button" onClick={() => { setLooksStart(null); setView('looks'); }} className={cn(soft, 'px-2.5 py-2')}><Palette className="h-4 w-4" /> Looks</button>
            <button type="button" onClick={() => setView('vaults')} className={cn(soft, 'px-2.5 py-2')}><BookOpen className="h-4 w-4" /> Vaults</button>
          </div>

          <label className={cn('mb-3 flex items-center gap-2 rounded-xl border px-3 py-2', colors.panelBorder)}>
            <Search className={cn('h-4 w-4', colors.textMuted)} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search spells, tags, credits…"
              className={cn('min-w-0 flex-1 bg-transparent text-sm outline-none', colors.textMain)} />
          </label>

          <div className="scrollbar-hide -mx-4 mb-2 flex gap-1.5 overflow-x-auto px-4">
            {FILTERS.map((f) => (
              <button key={f.value} type="button" onClick={() => setFilter(f.value)} className={chip(filter === f.value)} style={chipStyle(filter === f.value)}>
                {f.label} <span className="opacity-60">{counts[f.value]}</span>
              </button>
            ))}
          </div>
          {tags.length > 0 && (
            <div className="scrollbar-hide -mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4">
              {tags.slice(0, 30).map((t) => {
                const on = tag.toLowerCase() === t.tag.toLowerCase();
                return <button key={t.tag} type="button" onClick={() => setTag(on ? '' : t.tag)} className={cn(chip(on), 'text-xs')} style={chipStyle(on)}>{t.tag}</button>;
              })}
            </div>
          )}

          {queue.length > 0 && (
            <div className={cn('mb-3 flex items-center gap-2 rounded-xl border px-3 py-2 text-sm', colors.panelBorder, colors.textMain)}>
              <Loader2 className="h-4 w-4 animate-spin" style={{ color: colors.accent }} />
              {queue.length === 1 ? 'One render in the line' : `${queue.length} renders in the line`} — they pin themselves here.
            </div>
          )}

          {!loaded ? (
            <p className={cn('py-10 text-center text-sm', colors.textMuted)}>Opening the book…</p>
          ) : spells.length === 0 ? (
            <div className={cn('py-12 text-center', colors.textMuted)}>
              <p className={cn('text-base', colors.textMain)}>{counts.all ? 'Nothing matches that.' : 'No spells yet.'}</p>
              <p className="mt-1 text-sm">{counts.all ? 'Try another filter or tag.' : 'Drop a picture, or bring a vault in.'}</p>
            </div>
          ) : (
            <div className="columns-2 gap-3">
              {spells.map((s) => (
                s.cover ? (
                  <button key={s.id} type="button" onClick={() => openSpellPage(s)}
                    className={cn('mb-3 block w-full break-inside-avoid overflow-hidden rounded-2xl border text-left', colors.panelBg, colors.panelBorder)}>
                    <img src={thumbSrc(s.cover, 480)} alt={s.title} loading="lazy" className="block w-full" />
                    <span className={cn('block px-3 pt-2 text-sm font-medium', colors.textMain)}>{s.title}</span>
                    <span className="block px-3 pb-2.5 pt-1">{creditBadge(s) ?? <span className={cn('text-xs', colors.textMuted)}>{s.renderCount > 1 ? `${s.renderCount} renders` : 'Mine'}</span>}</span>
                  </button>
                ) : (
                  <div key={s.id} className={cn('mb-3 break-inside-avoid rounded-2xl border p-3', colors.panelBg, colors.panelBorder)}>
                    <button type="button" onClick={() => openSpellPage(s)} className="block w-full text-left">
                      <span className={cn('mb-1 block text-sm font-semibold', colors.textMain)}>{s.title}</span>
                      <span className={cn('mb-2 line-clamp-6 text-xs leading-relaxed', colors.textMuted)}>{s.scene}</span>
                    </button>
                    <div className="mb-2 flex flex-wrap gap-1">{creditBadge(s)}{s.tags.slice(0, 2).map((t) => <span key={t} className={cn('rounded-full border px-2 py-0.5 text-[11px]', colors.panelBorder, colors.textMuted)}>{t}</span>)}</div>
                    <button type="button" onClick={() => startRun(s)} className="flex w-full items-center justify-center gap-1 rounded-xl py-2 text-sm font-semibold" style={accentStyle}>
                      <Wand2 className="h-4 w-4" /> Make it
                    </button>
                  </div>
                )
              ))}
            </div>
          )}
        </div>
        <div className="absolute inset-x-0 bottom-0 flex gap-2 p-4" style={{ paddingBottom: 'calc(var(--sab, 0px) + 1rem)' }}>
          <button type="button" onClick={startDrop} className="flex flex-1 items-center justify-center gap-2 rounded-2xl py-4 text-base font-semibold shadow-lg" style={accentStyle}>
            <Plus className="h-5 w-5" /> Drop a picture
          </button>
          <button type="button" onClick={surprise} aria-label="Surprise me" className={cn('flex w-16 items-center justify-center rounded-2xl border shadow-lg backdrop-blur-md', colors.panelBg, colors.panelBorder, colors.textMain)}>
            <Shuffle className="h-5 w-5" />
          </button>
        </div>
        {hiddenInput}
        {toast}
      </div>
    );
  }

  // ─── An open spell ────────────────────────────────────────────
  if (view === 'spell' && openSpell) {
    const sp = openSpell;
    const current = renders[shown];
    const spLook = lookById(sp.look) ?? lookById(defaultLookId);
    const promptNamed = current?.prompt ?? `${castNames(sp.scene, readLastCast().map(nameFor))}${lookLine(spLook)}`;
    const promptNoNames = `${sp.scene}${lookLine(spLook)}`;
    return (
      <div className="bytelight-app-body min-h-0 flex-1 overflow-y-auto p-4 pb-10">
        <div className="mb-4 flex items-center gap-3">
          {backBtn(() => setView('wall'))}
          <h3 className={cn('flex-1 text-lg font-semibold', colors.textMain)}>{sp.title}</h3>
          <button type="button" onClick={surprise} aria-label="Another surprise" className={cn('rounded-xl border p-2', colors.panelBorder, colors.textMain)}><Shuffle className="h-4 w-4" /></button>
        </div>

        {current ? (
          <img src={current.url} alt={sp.title} className="mb-2 w-full rounded-2xl" />
        ) : sp.sourceUrl ? (
          <img src={sp.sourceUrl} alt="The original inspiration" className="mb-2 w-full rounded-2xl opacity-80" />
        ) : (
          <div className={cn('mb-3 rounded-2xl border p-4 text-sm', colors.panelBorder, colors.textMuted)}>Never made yet. One tap and it's on the wall.</div>
        )}
        {renders.length > 1 && (
          <div className="scrollbar-hide -mx-4 mb-3 flex gap-2 overflow-x-auto px-4">
            {renders.map((r, i) => (
              <button key={r.filename} type="button" onClick={() => setShown(i)} className="shrink-0">
                <img src={thumbSrc(r.url, 256)} alt="" className="h-20 w-16 rounded-lg object-cover" style={i === shown ? { outline: `2px solid ${colors.accent}` } : undefined} />
              </button>
            ))}
          </div>
        )}
        {current && <p className={cn('mb-3 text-xs', colors.textMuted)}>Cast · {current.cast.map(nameFor).join(', ')}</p>}

        <div className="mb-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => startRun(sp)} className="flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-semibold" style={accentStyle}>
            {renders.length ? <><Repeat className="h-4 w-4" /> Run with…</> : <><Wand2 className="h-4 w-4" /> Make it</>}
          </button>
          <button type="button" onClick={() => copy(promptNamed, 'Prompt')} className={soft}><Copy className="h-4 w-4" /> Copy prompt</button>
          <button type="button" onClick={() => copy(promptNoNames, 'Prompt without names')} className={soft}>Copy, no names</button>
          <button type="button" disabled={!current} onClick={() => current && share(current.url, sp.title, promptNoNames, sp.credit)} className={soft}><Share2 className="h-4 w-4" /> Share card</button>
        </div>

        <section className={cn(card, 'mb-3')}>
          <span className={label}>Where it came from</span>
          <div className="mb-3 flex gap-3">
            {sp.sourceUrl && current && <img src={sp.sourceUrl} alt="Original inspiration" className="h-24 w-20 shrink-0 rounded-xl object-cover" />}
            <div className={cn('flex flex-col gap-1 text-sm', colors.textMuted)}>
              <span className={colors.textMain}>{sp.origin === 'community' ? 'Community' : 'Mine'}{sp.vault === 'notion' ? ' · from Notion' : sp.vault === 'archive' ? ' archive' : ''}</span>
              {sp.credit && <span className={colors.textMain}>Credit · {sp.credit}</span>}
              {sp.engine && <span>Written for · {sp.engine}</span>}
              {sp.link && <a href={sp.link} target="_blank" rel="noopener noreferrer" style={{ color: colors.accent }}>Open the source</a>}
              <span>Look · {spLook?.name ?? sp.look ?? 'default'}</span>
              <span>{sp.timesCast ? `Made ${sp.timesCast}×` : 'Not made yet'}{sp.castSize ? ` · written for ${sp.castSize}` : ''}</span>
            </div>
          </div>
          <p className={cn('mb-3 whitespace-pre-wrap text-sm leading-relaxed', colors.textMain)}>{promptNamed}</p>
          {sp.originalText && sp.originalText !== sp.scene && (
            <details className={cn('mb-3 text-sm', colors.textMuted)}>
              <summary>As it was first written</summary>
              <p className="mt-2 whitespace-pre-wrap leading-relaxed">{sp.originalText}</p>
            </details>
          )}
          {!sp.neutralized && <p className={cn('mb-3 text-xs', colors.textMuted)}>Still waiting for its names to be taken out. It can be cast as it is.</p>}
          {sp.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {sp.tags.map((t) => <button key={t} type="button" onClick={() => { setTag(t); setView('wall'); }} className={cn('rounded-full border px-2.5 py-0.5 text-xs', colors.panelBorder, colors.textMuted)}>{t}</button>)}
            </div>
          )}
        </section>
        <button type="button" onClick={() => removeSpell(sp)} className={cn(soft, 'w-full text-red-400')}><Trash2 className="h-4 w-4" /> Take it out of the book</button>
        {toast}
      </div>
    );
  }

  // ─── The cast screen ──────────────────────────────────────────
  const running = !!castSpell;
  const canGo = running ? cast.length > 0 : !!file && cast.length > 0;
  const go = () => (running && castSpell ? runSpell(castSpell, cast, look || defaultLookId) : castDropped());
  const castFrame = preview
    ? <img src={preview.startsWith('/api/studio/gallery/') ? thumbSrc(preview, 480) : preview} alt="" className="h-full w-full object-cover" />
    : running
      ? <span className={cn('line-clamp-[8] px-2 text-left text-[11px] leading-snug', colors.textMuted)}>{castSpell?.scene}</span>
      : <span className="flex flex-col items-center gap-1 px-2"><ImagePlus className="h-5 w-5" />Tap to pick a picture</span>;

  return (
    <div className="bytelight-app-body min-h-0 flex-1 overflow-y-auto p-4 pb-10">
      <div className="mb-4 flex items-center gap-3">
        {backBtn(() => { setView(openSpell && running ? 'spell' : 'wall'); }, busy)}
        <h3 className={cn('flex-1 truncate text-lg font-semibold', colors.textMain)}>{running ? castSpell?.title : 'Recast'}</h3>
      </div>

      <section className={cn(card, 'mb-4')}>
        <div className="mb-4 flex gap-3" ref={castRef}>
          <button type="button" onClick={() => fileInput.current?.click()} disabled={busy || running}
            className={cn('flex h-36 w-28 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-dashed text-center text-xs disabled:cursor-default', colors.panelBorder, colors.textMuted)}>
            {castFrame}
          </button>
          <div className="min-w-0 flex-1">
            <span className={label}>Who's in it</span>
            <div className="flex flex-wrap gap-1.5">
              {drawers.map((d) => {
                const on = cast.includes(d.slug);
                return (
                  <button key={d.slug} type="button" disabled={busy} onClick={() => toggleCast(d.slug)} className={chip(on)} style={chipStyle(on)}>
                    {marker(d)} {d.label}{on && cast.length > 1 ? <sup className="ml-0.5">{cast.indexOf(d.slug) + 1}</sup> : null}
                  </button>
                );
              })}
            </div>
            <p className={cn('mt-2 text-xs', colors.textMuted)}>
              {running && castSpell && castSpell.castSize > 0 && castSpell.castSize !== cast.length && cast.length
                ? `Written for ${castSpell.castSize}. We'll rewrite it for ${cast.length}.`
                : 'Parts and wardrobe go to whoever suits them.'}
            </p>
          </div>
        </div>

        <div ref={lookRef}>
          <span className={label}>Look</span>
          <div className="mb-4 flex flex-wrap gap-1.5">
            {looks.map((l) => (
              <button key={l.id} type="button" disabled={busy} onClick={() => setLook(l.id)} className={cn(chip((look || defaultLookId) === l.id), 'rounded-xl')} style={chipStyle((look || defaultLookId) === l.id)}>
                {l.favorite ? '★ ' : ''}{l.name}{l.isDefault ? ' · default' : ''}
              </button>
            ))}
            <button type="button" onClick={() => { setLooksStart('new'); setView('looks'); }} className={cn(chip(false), 'rounded-xl')}><Plus className="inline h-3.5 w-3.5" /> New look</button>
          </div>
        </div>

        <button type="button" onClick={() => setMoreOpen((o) => !o)} className={cn('mb-3 text-sm', colors.textMuted)}>
          {moreOpen ? '▾' : '▸'} {running ? 'Size' : 'Credit, link, size'}
        </button>
        {moreOpen && (
          <div className="mb-4 grid gap-2">
            {!running && (
              <>
                <input value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="Credit — who posted it" maxLength={120}
                  className={cn('rounded-xl border bg-transparent px-3 py-2 text-sm outline-none', colors.panelBorder, colors.textMain)} />
                <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Link — https://…" maxLength={500} inputMode="url"
                  className={cn('rounded-xl border bg-transparent px-3 py-2 text-sm outline-none', colors.panelBorder, colors.textMain)} />
              </>
            )}
            <select value={size} onChange={(e) => setSize(e.target.value)}
              className={cn('rounded-xl border bg-transparent px-3 py-2 text-sm outline-none', colors.panelBorder, colors.textMain)}>
              {SIZES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
        )}

        <button type="button" onClick={go} disabled={!canGo || busy}
          className="flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-base font-semibold disabled:opacity-40" style={accentStyle}>
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : running ? <Users className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
          {stage === 'reading' ? (running ? 'Fitting it to your cast…' : 'Reading the picture…') : running ? (result ? 'Make it again' : 'Make it') : 'Recast it'}
        </button>
        {!running && !file ? <p className={cn('mt-2 text-center text-xs', colors.textMuted)}>Pick a picture to start.</p>
          : !cast.length ? <p className={cn('mt-2 text-center text-xs', colors.textMuted)}>Pick who's in it.</p>
          : running ? <p className={cn('mt-2 text-center text-xs', colors.textMuted)}>Renders wait in line one at a time. You can leave; they pin themselves.</p> : null}
      </section>

      {stage === 'failed' && <p role="alert" className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">{failure}</p>}

      {result && (stage === 'casting' || stage === 'done') && (
        <>
          <div className={cn('my-3 flex items-center gap-3 text-xs', colors.textMuted)}>
            <span className={cn('h-px flex-1 border-t', colors.panelBorder)} />what comes back<span className={cn('h-px flex-1 border-t', colors.panelBorder)} />
          </div>
          {stage === 'done' && resultUrl
            ? <img src={resultUrl} alt={result.spell.title} className="mb-4 w-full rounded-2xl" />
            : <div className={cn('mb-4 flex aspect-[4/5] w-full items-center justify-center rounded-2xl border text-sm', colors.panelBg, colors.panelBorder, colors.textMuted)}>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />Casting {result.cast.map(nameFor).join(' + ')}…
              </div>}
          <section className={card}>
            <h4 className={cn('mb-2 text-lg font-semibold', colors.textMain)}>{result.spell.title}</h4>
            <p className={cn('mb-3 whitespace-pre-wrap text-sm leading-relaxed', colors.textMain)}>{result.prompt}</p>
            <div className="mb-2 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => copy(result.prompt, 'Prompt')} className={cn(soft, 'font-semibold')}>Copy prompt</button>
              <button type="button" onClick={() => copy(result.promptNoNames, 'Prompt without names')} className={soft}>Copy, no names</button>
            </div>
            {stage === 'done' && (
              <div className="mb-2 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => runSpell(result.spell, result.cast, look || defaultLookId)} className={soft}>Again</button>
                <button type="button" onClick={() => castRef.current?.scrollIntoView({ behavior: 'smooth' })} className={soft}>Swap cast</button>
                <button type="button" onClick={() => lookRef.current?.scrollIntoView({ behavior: 'smooth' })} className={soft}>Try a look</button>
                <button type="button" onClick={() => share(resultUrl, result.spell.title, result.promptNoNames, result.spell.credit)} className={soft}><Share2 className="h-4 w-4" /> Share card</button>
              </div>
            )}
            <p className={cn('text-xs', colors.textMuted)}>Pinned to your wall automatically. The stranger in the original picture is never sent to the engine.</p>
          </section>
        </>
      )}
      {hiddenInput}
      {toast}
    </div>
  );
}
