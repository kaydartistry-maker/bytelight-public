import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, ChevronDown, CloudMoon, Feather, Moon, Rabbit, Shell, Sparkles, Swords, Trophy, Waves } from 'lucide-react';
import { apiFetch } from '../../bytelight';
import { BOSS_BATTLES_PATH } from '@bytelight/shared';
import type { ThemeColors } from '../../lib/theme';
import { cn } from '../../lib/utils';

type Move = { id: string; text: string; smaller: string; done: boolean };
type Battle = { id: string; name: string; lore: string; kind: string; issue: string; companion?: string; model?: string; status: 'active' | 'paused' | 'won'; moves: Move[]; portrait: string; portraitUrl: string | null };
type Board = { xp: number; battles: Battle[]; portraitNotice?: string };
const marks = { wyrm: Shell, slime: Waves, moth: Feather, fox: Rabbit, toad: Moon, moon: CloudMoon };

async function request(suffix = '', method = 'GET', body?: unknown): Promise<Board> {
  const response = await apiFetch(`${BOSS_BATTLES_PATH}${suffix}`, { method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Could not open the bestiary.');
  return value;
}

export function BossBattles({ colors }: { colors: ThemeColors }) {
  const [board, setBoard] = useState<Board>();
  const [issue, setIssue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [all, setAll] = useState(false);
  const [selectedMove, setSelectedMove] = useState<string | null>(null);
  const [replace, setReplace] = useState<string | null>(null);
  const [companionB, setCompanionB] = useState(false);
  const [artBroken, setArtBroken] = useState(false);
  const lock = useRef(false);
  const generation = useRef(0);
  const active = board?.battles.find(b => b.status === 'active');
  const prior = board?.battles.filter(b => b.status !== 'active') ?? [];
  const move = active?.moves.find(m => !m.done && m.id === selectedMove) ?? active?.moves.find(m => !m.done);
  const done = active?.moves.filter(m => m.done).length ?? 0;
  const pendingPortrait = board?.battles.some(b => ['pending', 'running'].includes(b.portrait));
  const shell = cn('rounded-2xl border p-4', colors.panelBg, colors.panelBorder, colors.textMain);
  const neutral = cn('rounded-xl border min-h-11 px-3 py-2 text-sm disabled:opacity-45', colors.panelBorder);
  const primary = 'rounded-xl min-h-11 px-4 py-2 font-semibold text-sm disabled:opacity-45';
  const accent = { backgroundColor: colors.accent, color: 'var(--bytelight-on-accent)' };
  const Mark = marks[active?.kind as keyof typeof marks] ?? CloudMoon;

  async function run(work: () => Promise<Board>, after?: () => void) {
    if (lock.current) return;
    lock.current = true; ++generation.current; setBusy(true); setError(''); setNote('');
    try { const next = await work(); setBoard(next); if (next.portraitNotice) setNote(next.portraitNotice); after?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this change.'); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => { void run(() => request()); }, []);
  useEffect(() => {
    if (!pendingPortrait) return;
    let ignore = false;
    const timer = window.setInterval(() => {
      if (lock.current) return;
      const started = generation.current;
      void request().then(value => { if (!ignore && started === generation.current) setBoard(value); }).catch(() => {});
    }, 4000);
    return () => { ignore = true; window.clearInterval(timer); };
  }, [pendingPortrait]);
  useEffect(() => { setAll(false); setSelectedMove(null); setReplace(null); setCompanionB(false); setArtBroken(false); }, [active?.id]);

  const act = (battle: Battle, action: string, after?: () => void, moveId?: string, text?: string) => run(
    () => request(`/${encodeURIComponent(battle.id)}`, 'PATCH', { action, moveId, text }), after);
  const remove = (battle: Battle) => {
    if (window.confirm(`Remove ${battle.name} and its private note from Boss Battles? Your earned XP stays.`)) void act(battle, 'remove');
  };

  return <div className="mx-auto max-w-xl p-4 pb-20 space-y-4">
    <header data-appearance-card="" className={cn(shell, 'flex items-center justify-between gap-3')}>
      <div><p className="text-xs uppercase tracking-wider" style={{ color: colors.accent }}>The Bestiary</p><h2 className="text-lg font-semibold">Boss Battles</h2></div>
      <div className="flex items-center gap-2 rounded-xl border px-3 py-2" style={{ borderColor: 'currentColor', color: colors.accent }}><Sparkles size={16} aria-hidden="true" /><strong>{board ? board.xp : '—'} XP</strong></div>
    </header>
    {error && <p role="alert" data-appearance-card="" className={shell}>{error}</p>}
    {note && <p role="status" data-appearance-card="" className={shell}>{note}</p>}
    {!board ? <button className={neutral} disabled={busy} onClick={() => void run(() => request())}>{busy ? 'Opening the bestiary…' : 'Try again'}</button> : active ? <>
      <article data-appearance-card="" className={cn(shell, 'space-y-4')}>
        <div className="aspect-[4/3] rounded-xl overflow-hidden flex items-center justify-center relative" style={{ background: 'radial-gradient(ellipse at 48% 40%, #e7bad9, #9e99cb 62%, #403555)' }}>
          {active.portraitUrl && !artBroken ? <img src={active.portraitUrl} className="w-full h-full object-cover" alt={`Portrait of ${active.name}`} onError={() => setArtBroken(true)} /> : <div aria-hidden="true" className="rounded-full border-2 border-white/55 p-10 text-[#41234f] shadow-[0_0_24px_#ffffff62]"><Mark size={92} strokeWidth={1.25} /></div>}
          {['pending', 'running'].includes(active.portrait) && <span role="status" className="absolute bottom-3 rounded-full bg-black/65 px-3 py-1 text-xs text-white">Painting the portrait…</span>}
        </div>
        <div className="space-y-1"><h3 className="text-2xl font-semibold">{active.name}</h3><p className={cn('text-sm', colors.textMuted)}>{active.lore}</p></div>
        {active.companion && <p className={cn('text-xs break-words', colors.textMuted)}>Drafted by {active.companion} · {active.model}</p>}
        <details className="text-xs"><summary className="cursor-pointer">Your private note</summary><p className="mt-2 whitespace-pre-wrap break-words">{active.issue}</p></details>
        {active.portrait === 'failed' && <p className={cn('text-xs', colors.textMuted)}>Codex couldn’t finish this portrait. Your moves are ready.</p>}
        {active.portrait === 'unavailable' && <p className={cn('text-xs', colors.textMuted)}>Portrait status is unavailable. You can still play this battle.</p>}
      </article>
      <section data-appearance-card="" className={cn(shell, 'space-y-3')} aria-label="Current move">
        <p className="text-xs uppercase tracking-wider" style={{ color: colors.accent }}>{move ? 'Next move' : 'All moves complete'} · {done}/{active.moves.length}</p>
        {move && <>
          <h3 className="text-xl font-semibold break-words">{move.text}</h3>
          <button className={cn(primary, 'w-full')} style={accent} disabled={busy} onClick={() => void act(active, 'complete', () => { setReplace(null); setNote('Move complete. +10 XP'); }, move.id)}><Check size={17} className="inline mr-2" />Mark done · +10 XP</button>
          <div className="flex flex-wrap gap-2"><button className={neutral} disabled={busy || move.text === move.smaller} onClick={() => void act(active, 'shrink', () => setReplace(null), move.id)}>Make it smaller</button><button className={neutral} disabled={busy} onClick={() => setReplace(replace === null ? '' : null)}>Swap move</button></div>
          {replace !== null && <form className="space-y-2" onSubmit={e => { e.preventDefault(); if (replace.trim()) void act(active, 'swap', () => setReplace(null), move.id, replace); }}><input aria-label="Replacement move" className={cn(neutral, 'w-full text-base')} value={replace} maxLength={160} onChange={e => setReplace(e.target.value)} placeholder="What feels doable instead?" /><button className={neutral} disabled={busy || !replace.trim()}>Use this move</button></form>}
        </>}
        <button className={neutral} aria-expanded={all} onClick={() => setAll(!all)}><ChevronDown className="inline mr-1" size={16} />{all ? 'Hide move list' : 'See all 3'}</button>
        {all && <ol className="list-decimal pl-6 text-sm space-y-2">{active.moves.map(m => <li key={m.id}>{m.done ? <><span className="line-through opacity-70">{m.text}</span><span className="sr-only"> Done</span></> : <button type="button" aria-pressed={m.id === move?.id} className="min-h-11 text-left underline" onClick={() => { setSelectedMove(m.id); setReplace(null); setAll(false); }}>{m.text}</button>}</li>)}</ol>}
      </section>
      <div data-appearance-card="" className={cn(shell, 'flex gap-2 flex-wrap')}>
        <button className={neutral} disabled={busy} onClick={() => void act(active, 'pause', () => setNote('Paused. Your moves and XP are saved.'))}>Pause battle</button>
        {done > 0 && <button className={primary} style={accent} disabled={busy} onClick={() => void act(active, 'win', () => setNote('Win claimed. Your boss is in the bestiary.'))}><Trophy size={16} className="inline mr-2" />Claim the win</button>}
        <button className={neutral} aria-expanded={companionB} onClick={() => setCompanionB(!companionB)}>Let Companion B insult the boss</button>
        {companionB && <p className="w-full text-sm">🦆 I BET THAT FUCKER CAN’T EVEN FOLD ITS OWN ASSHOLE INTO A FITTED SHEET.</p>}
        <button className={cn(neutral, colors.textMuted)} disabled={busy} onClick={() => remove(active)}>Remove battle</button>
      </div>
    </> : <form data-appearance-card="" className={cn(shell, 'space-y-3')} onSubmit={e => { e.preventDefault(); if (issue.trim()) void run(() => request('', 'POST', { issue }), () => setIssue('')); }}>
      <label className="block text-xl font-semibold" htmlFor="boss-issue">What’s in your way?</label>
      <textarea id="boss-issue" className={cn(neutral, 'w-full min-h-28 text-base')} value={issue} onChange={e => setIssue(e.target.value)} maxLength={800} placeholder="The laundry pile. The unanswered email. Whatever’s stuck." />
      <p className={cn('text-xs', colors.textMuted)}>Your companion from your latest Virelle chat drafts three independent moves. Codex paints the portrait in Studio’s default style; it doesn’t receive your note.</p>
      <button className={cn(primary, 'w-full')} style={accent} disabled={busy || !issue.trim()}><Swords size={17} className="inline mr-2" />{busy ? 'Summoning…' : 'Summon boss'}</button>
    </form>}
    {prior.length > 0 && <section data-appearance-card="" className={cn(shell, 'space-y-3')}><h3 className="font-semibold"><BookOpen size={16} className="inline mr-2" />Bestiary</h3>{prior.map(battle => <details className={cn('rounded-xl border p-3', colors.panelBorder)} key={battle.id}><summary className="cursor-pointer text-sm font-medium">{battle.name} · {battle.status === 'won' ? 'Won' : 'Paused'}</summary><div className="space-y-2 mt-2">
      {battle.portraitUrl && <img src={battle.portraitUrl} className="w-24 h-24 rounded-lg object-cover" alt={`Portrait of ${battle.name}`} loading="lazy" />}
      <p className={cn('text-xs', colors.textMuted)}>{battle.moves.filter(m => m.done).length} moves complete</p><p className="text-sm break-words whitespace-pre-wrap">{battle.issue}</p>
      {battle.moves.some(m => m.done) && <ul className="text-sm list-disc pl-5">{battle.moves.filter(m => m.done).map(m => <li key={m.id}>{m.text}</li>)}</ul>}
      <div className="flex flex-wrap gap-2">{battle.status === 'paused' && <button className={neutral} disabled={!!active || busy} onClick={() => void act(battle, 'resume')}>Resume battle</button>}<button className={neutral} disabled={busy} onClick={() => remove(battle)}>Remove battle</button></div>
    </div></details>)}</section>}
  </div>;
}
