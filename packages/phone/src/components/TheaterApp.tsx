// The Theater — your companions on the couch while she watches something on
// her TV. She starts a night (what's playing, how chatty, no spoilers), loads
// the subtitles, and runs the clock beside the TV; anything she says or taps
// on the couch wakes them for one turn that sees only what has already played.
// While the show plays they may also react on their own at natural beats (the
// Mouth); "Let them react" and the chatty slider on the start form steer it.
// Ending a night keeps it: past nights reopen read-only.
//
// Subtitles: as she types the title (and season + episode for a show), the
// start form asks the house to search OpenSubtitles (free) and shows the best
// match; Start downloads that one onto the night (backend
// services/theater-subs-fetch.ts, the key stays in the house). "Try another"
// swaps in the next file it found; "Load .srt / .vtt" stays the fallback.
//
// "On the computer" nights hear the show through the Ear, a Chrome extension
// (packages/theater-ear/) that reads the subtitles off Netflix or Hulu and
// drives the clock from the video itself: no subtitle search, no clock
// buttons. She pairs it here ("Connect the Ear": a one-time code she pastes
// into the extension) and can disconnect it (backend services/theater-ear.ts).
//
// The house owns the clock (backend services/theater-clock.ts); the phone
// runs it on locally between reads. Pure bits live in lib/theater.ts.
//
// LAYOUT NOTE: AppShell paints no background, so everything sits on a panel,
// mixed from the theme's own variables; the marquee is the house accent.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronLeft, Clapperboard, Loader2, Pause, Play, RefreshCw, Search, Upload } from 'lucide-react';
import { AppShell } from './AppShell';
import { RoomTalk, type RoomLine } from './RoomTable';
import type { ThemeColors, ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch, markRead, usePresence } from '../bytelight';
import { useBackHandler } from '../lib/use-back-handler';
import { getOwnerAvatar, useHouseRoster, type HouseCompanion } from '../lib/house';
import { RoomBubbleContext, type RoomBubbleSettings } from './RoomBubble';
import {
  DEFAULT_REACTIONS,
  canTryAnother,
  captionAt,
  chattyLabel,
  episodeLabel,
  formatClock,
  formatDuration,
  isNightView,
  isTheaterHome,
  mouthLine,
  nightDate,
  parseClockInput,
  projectPosition,
  scrubLength,
  isSubtitleMatch,
  matchLine,
  subtitleLine,
  subtitleSearchQuery,
  type PastNight,
  type SubtitleMatch,
  type TheaterCue,
  type TheaterHome,
  type TheaterNightView,
  handoffDelay,
  earLine,
  isEarPairing,
  minutesLeft,
  pairingCodeLabel,
  startNightBody,
  type TheaterEarPairing,
  type TheaterMode,
} from '../lib/theater';

interface TheaterAppProps {
  onClose: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

const LABEL = 'text-[10px] font-bold uppercase tracking-[0.14em]';
const ACCENT_FILL = { background: 'var(--bytelight-selected-fill)', color: 'var(--bytelight-on-accent)' } as const;
/** The screen: a dark well pressed into the panel, whatever the theme. */
const SCREEN = 'color-mix(in oklch, oklch(0.12 0.01 280) 72%, var(--bytelight-panel-base))';
const SCREEN_INK = 'oklch(0.95 0.01 280)';
const MARQUEE = 'color-mix(in oklch, var(--bytelight-accent) 55%, transparent)';
const WAITING_POLL_MS = 4000;
const LIVE_POLL_MS = 20_000;
/** A computer night re-reads more often, so the Ear's line stays fresh. */
const EAR_POLL_MS = 6000;
/** The start form searches for subtitles this long after she stops typing. */
const SUBS_SEARCH_DEBOUNCE_MS = 600;

async function postJson(path: string, body: unknown = {}): Promise<Response> {
  return apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null) as { error?: string } | null;
  return data?.error || fallback;
}

export function TheaterApp({ onClose, themeConfig, themeMode }: TheaterAppProps) {
  const colors = themeConfig[themeMode];
  const { companions } = useHouseRoster();
  const [home, setHome] = useState<TheaterHome | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** A past night open to read. */
  const [reading, setReading] = useState<TheaterNightView | null>(null);
  /** Why the match found on the start form didn't load (out of downloads…), shown on the live night. */
  const [startSubsNote, setStartSubsNote] = useState<string | null>(null);

  const reads = useRef(0);
  const loadHome = useCallback(async () => {
    const mine = ++reads.current;
    setLoading(true);
    try {
      const res = await apiFetch('/api/theater');
      const data: unknown = await res.json().catch(() => null);
      if (mine !== reads.current) return;
      if (res.ok && isTheaterHome(data)) {
        setHome(data);
        setTrouble(null);
      } else {
        setTrouble(res.ok ? 'The Theater is not open on the house yet. It may need a restart.' : 'The Theater could not be reached just now.');
      }
    } catch {
      if (mine === reads.current) setTrouble('The Theater could not be reached just now.');
    } finally {
      if (mine === reads.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void loadHome(); }, [loadHome]);

  const openPast = async (id: string) => {
    try {
      const res = await apiFetch(`/api/theater/nights/${encodeURIComponent(id)}`);
      const data: unknown = await res.json().catch(() => null);
      if (res.ok && isNightView(data)) setReading(data);
      else setTrouble('That night could not be opened.');
    } catch {
      setTrouble('That night could not be opened.');
    }
  };

  useBackHandler(reading !== null, () => setReading(null));
  const handleBack = () => (reading ? setReading(null) : onClose());

  const live = home?.live ?? null;
  // The couch draws the chat's own bubble (RoomTable.tsx): bold names,
  // italics and faces. Without these settings it fell back to plain text and
  // showed the raw `**Companion A —**` markers (Nov 2026).
  const roomBubbles = useMemo<RoomBubbleSettings>(() => {
    const owner = getOwnerAvatar();
    return { themeConfig, themeMode, userAvatar: owner.url, userAvatarColor: owner.color };
  }, [themeConfig, themeMode]);

  return (
    <RoomBubbleContext.Provider value={roomBubbles}>
    <AppShell
      title="The Theater"
      icon={Clapperboard}
      onClose={handleBack}
      themeConfig={themeConfig}
      themeMode={themeMode}
      headerRight={
        <button
          onClick={() => void loadHome()}
          className={cn('rounded-full p-2 transition-colors hover:bg-black/10 dark:hover:bg-white/10', colors.textMuted)}
          aria-label="Refresh the Theater"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        </button>
      }
    >
      <div className="mx-auto w-full max-w-md space-y-3 pb-6">
        {trouble && <p className="text-xs" style={{ color: 'var(--bytelight-accent)' }}>{trouble}</p>}
        {reading ? (
          <PastNightView view={reading} companions={companions} colors={colors} onBack={() => setReading(null)} />
        ) : home === null ? (
          loading && <div className={cn('flex items-center justify-center gap-2 py-10 text-xs', colors.textMuted)}><Loader2 size={14} className="animate-spin" /> Dimming the lights…</div>
        ) : live ? (
          <LiveNight
            key={live.night.id}
            initial={live}
            companions={companions}
            colors={colors}
            subsNoteAtStart={startSubsNote}
            onEnded={() => { setStartSubsNote(null); void loadHome(); }}
          />
        ) : (
          <>
            <StartNight colors={colors} onStarted={(note) => { setStartSubsNote(note); void loadHome(); }} />
            <PastNights nights={home.past} colors={colors} onOpen={(id) => void openPast(id)} />
          </>
        )}
      </div>
    </AppShell>
    </RoomBubbleContext.Provider>
  );
}

// ─── pieces ─────────────────────────────────────────────────────────

function Panel({ colors, children, className, style }: { colors: ThemeColors; children: ReactNode; className?: string; style?: CSSProperties }) {
  return <section className={cn('rounded-[var(--shape-control)] border p-3', colors.panelBg, colors.panelBorder, className)} style={style}>{children}</section>;
}

function Primary({ children, onClick, disabled, busy }: { children: ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled || busy} className="flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[14px] font-semibold disabled:opacity-50" style={ACCENT_FILL}>
      {busy && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
}

// ─── start a theater night ──────────────────────────────────────────

type MatchState = { query: string; status: 'searching' } | { query: string; status: 'done'; match: SubtitleMatch } | { query: string; status: 'error'; message: string };

function StartNight({ colors, onStarted }: { colors: ThemeColors; onStarted: (subsNote: string | null) => void }) {
  const [title, setTitle] = useState('');
  const [season, setSeason] = useState('');
  const [episode, setEpisode] = useState('');
  const [chatty, setChatty] = useState(50);
  const [noSpoilers, setNoSpoilers] = useState(true);
  const [reacting, setReacting] = useState(true);
  const [mode, setMode] = useState<TheaterMode>('tv');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<MatchState | null>(null);

  // Search for subtitles a moment after she stops typing (free; nothing downloads until Start).
  // On the computer the Ear hears the lines, so there is nothing to search for.
  const query = mode === 'tv' ? subtitleSearchQuery(title, season, episode) : null;
  useEffect(() => {
    if (!query) { setFound(null); return; }
    let stale = false;
    const t = window.setTimeout(async () => {
      setFound({ query, status: 'searching' });
      try {
        const res = await apiFetch(`/api/theater/subtitles/search?${query}`);
        const data: unknown = await res.json().catch(() => null);
        if (stale) return;
        if (res.ok && isSubtitleMatch(data)) setFound({ query, status: 'done', match: data });
        else setFound({ query, status: 'error', message: (data as { error?: string } | null)?.error || 'Subtitles could not be searched just now. You can load a file.' });
      } catch {
        if (!stale) setFound({ query, status: 'error', message: 'Subtitles could not be searched just now. You can load a file.' });
      }
    }, SUBS_SEARCH_DEBOUNCE_MS);
    return () => { stale = true; window.clearTimeout(t); };
  }, [query]);
  const current = found && found.query === query ? found : null;
  const match = current?.status === 'done' ? current.match.best : null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await postJson('/api/theater/nights', startNightBody({
        title, season, episode, mode, chatty, noSpoilers, mouthOn: reacting, matchFileId: match?.fileId ?? null,
      }));
      if (!res.ok) throw new Error(await errorOf(res, 'The night could not start. Try again?'));
      const data = await res.json().catch(() => null) as { subtitleError?: string | null } | null;
      onStarted(data?.subtitleError ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The night could not start. Try again?');
    } finally {
      setBusy(false);
    }
  };

  const input = cn('w-full rounded-lg border bg-transparent px-3 py-2 text-[14px] outline-none', colors.panelBorder, colors.textMain);
  return (
    <Panel colors={colors} style={{ boxShadow: `inset 0 0 0 1px ${MARQUEE}` }}>
      <h2 className={cn('mb-3 text-[17px] font-semibold', colors.textMain)}>Start a theater night</h2>

      <label className={cn(LABEL, colors.textMuted)}>What are we watching?</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className={cn(input, 'mt-1')} maxLength={200} />
      <div className="mt-2 flex gap-2">
        <input value={season} onChange={(e) => setSeason(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="Season (optional)" className={input} />
        <input value={episode} onChange={(e) => setEpisode(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="Episode (optional)" className={input} />
      </div>
      {current && (
        <p className={cn('mt-2 flex items-center gap-1.5 text-[12px]', colors.textMuted)} aria-live="polite">
          {current.status === 'searching' ? (
            <><Loader2 size={12} className="animate-spin" /> Looking for subtitles…</>
          ) : current.status === 'done' ? (
            <span className="truncate" title={matchLine(current.match)}>{matchLine(current.match)}</span>
          ) : (
            <span>{current.message}</span>
          )}
        </p>
      )}

      <p className={cn('mt-4', LABEL, colors.textMuted)}>How the Theater hears it</p>
      <div className="mt-1 grid grid-cols-2 gap-2">
        {([
          ['computer', '💻 On the computer', 'The Ear hears it, the clock follows'],
          ['tv', '📺 On the TV', 'Subtitles found for you, run the clock'],
        ] as const).map(([value, name, hint]) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            aria-pressed={mode === value}
            className={cn('rounded-lg px-3 py-2 text-left', mode === value ? 'border-2' : cn('border', colors.panelBorder))}
            style={mode === value ? { borderColor: 'var(--bytelight-accent)' } : undefined}
          >
            <div className={cn('text-[14px] font-semibold', colors.textMain)}>{name}</div>
            <div className={cn('text-[12px]', colors.textMuted)}>{hint}</div>
          </button>
        ))}
      </div>
      {mode === 'computer' && <EarPanel colors={colors} className="mt-2" />}

      <label className="mt-4 flex items-center justify-between gap-3">
        <span className={cn('text-[14px]', colors.textMain)}>Let them react</span>
        <input type="checkbox" checked={reacting} onChange={(e) => setReacting(e.target.checked)} className="h-5 w-5" style={{ accentColor: 'var(--bytelight-accent)' }} aria-describedby="theater-start-react-hint" />
      </label>
      <p id="theater-start-react-hint" className={cn('mt-0.5 text-[12px]', colors.textMuted)}>
        {reacting ? 'They can speak up on their own at good moments, or stay quiet.' : 'They only answer when you say something.'}
      </p>
      {reacting && (<>
      <div className="mt-3 flex items-center justify-between">
        <label htmlFor="theater-chatty" className={cn(LABEL, colors.textMuted)}>How chatty</label>
        <span className={cn('text-[12px]', colors.textMuted)}>{chattyLabel(chatty)}</span>
      </div>
      <input id="theater-chatty" type="range" min={0} max={100} value={chatty} onChange={(e) => setChatty(Number(e.target.value))} className="mt-1 w-full" style={{ accentColor: 'var(--bytelight-accent)' }} />
      </>)}

      <label className="mt-3 flex items-center justify-between gap-3">
        <span className={cn('text-[14px]', colors.textMain)}>No spoilers</span>
        <input type="checkbox" checked={noSpoilers} onChange={(e) => setNoSpoilers(e.target.checked)} className="h-5 w-5" style={{ accentColor: 'var(--bytelight-accent)' }} />
      </label>

      {error && <p className="mt-3 text-xs" style={{ color: 'var(--bytelight-accent)' }}>{error}</p>}
      <div className="mt-4 flex">
        <Primary onClick={() => void start()} disabled={!title.trim()} busy={busy}>Start theater night 🍿</Primary>
      </div>
    </Panel>
  );
}

// ─── past nights ────────────────────────────────────────────────────

function PastNights({ nights, colors, onOpen }: { nights: PastNight[]; colors: ThemeColors; onOpen: (id: string) => void }) {
  if (nights.length === 0) return null;
  return (
    <Panel colors={colors}>
      <h3 className={cn(LABEL, colors.textMuted)}>Past theater nights</h3>
      <ul className="mt-2 divide-y" style={{ borderColor: 'var(--bytelight-border)' }}>
        {nights.map((n) => (
          <li key={n.id}>
            <button onClick={() => onOpen(n.id)} className="flex w-full items-center justify-between gap-3 py-2.5 text-left">
              <span className="min-w-0">
                <span className={cn('block truncate text-[14px] font-semibold', colors.textMain)}>
                  {n.title}{episodeLabel(n) && <span className={cn('font-normal', colors.textMuted)}> · {episodeLabel(n)}</span>}
                </span>
                <span className={cn('block text-[12px]', colors.textMuted)}>
                  {nightDate(n.startedAt)} · {formatDuration(n.durationSeconds)} · {n.said} {n.said === 1 ? 'thing' : 'things'} said
                </span>
              </span>
              <span className={cn('shrink-0 text-[12px]', colors.textMuted)}>Read</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function talkLines(view: TheaterNightView): RoomLine[] {
  return view.talk.map((l) => ({ id: l.id, role: l.role, content: l.content, createdAt: l.createdAt, companionSlug: l.companionSlug }));
}

/** Only who's seated on this couch (the house's own companions) shows up at the
 *  table, typing dots included; a guest registered elsewhere never does. */
function onCouch(companions: HouseCompanion[], seats: Array<{ id: string }> | undefined): HouseCompanion[] {
  if (!seats || seats.length === 0) return companions;
  const ids = new Set(seats.map((s) => s.id));
  return companions.filter((c) => ids.has(c.slug));
}

function PastNightView({ view, companions, colors, onBack }: { view: TheaterNightView; companions: HouseCompanion[]; colors: ThemeColors; onBack: () => void }) {
  const lines = useMemo(() => talkLines(view), [view]);
  return (
    <>
      <button onClick={onBack} className={cn('flex items-center gap-1 text-xs font-semibold', colors.textMuted)}>
        <ChevronLeft size={14} /> Theater
      </button>
      <ScreenCard view={view} />
      <Panel colors={colors}>
        <h3 className={cn(LABEL, colors.textMuted)}>On the couch</h3>
        <RoomTalk className="mt-2" lines={lines} companions={onCouch(companions, view.seats)} empty={<p className={cn('py-4 text-center text-[13px]', colors.textMuted)}>Nobody said a word. A good show, then.</p>} />
      </Panel>
    </>
  );
}

// The slate folds the screen: tap 🎬 and the big clock tucks away so the
// couch gets the room, the time riding small in the corner. Remembered on
// this phone only.
const FOLD_KEY = 'theater.screenFolded';
function readFolded(): boolean {
  try { return localStorage.getItem(FOLD_KEY) === '1'; } catch { return false; }
}
function saveFolded(on: boolean): void {
  try { localStorage.setItem(FOLD_KEY, on ? '1' : '0'); } catch { /* no storage, no memory */ }
}

function ScreenCard({ view, children, folded, onFold, foldedClock }: { view: TheaterNightView; children?: ReactNode; folded?: boolean; onFold?: () => void; foldedClock?: string }) {
  const ep = episodeLabel(view.night);
  const shut = Boolean(onFold && folded);
  return (
    <section className={cn('overflow-hidden rounded-[var(--shape-control)] px-4', shut ? 'py-3' : 'py-4')} style={{ background: SCREEN, color: SCREEN_INK, boxShadow: `inset 0 0 0 1px ${MARQUEE}, 0 10px 24px -14px oklch(0 0 0 / 0.7)` }}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[16px] font-semibold">{view.night.title}</div>
          <div className="truncate text-[12px] opacity-70">
            {[ep, view.night.status === 'live' ? (view.night.mode === 'computer' ? 'Live, on the computer' : 'Live, on the TV') : nightDate(view.night.startedAt)].filter(Boolean).join(' · ')}
          </div>
        </div>
        {onFold ? (
          <button
            onClick={onFold}
            className="flex shrink-0 items-center gap-2 rounded-full py-1 pl-2 pr-1"
            aria-expanded={!folded}
            aria-label={folded ? 'Show the clock' : 'Tuck the clock away'}
          >
            {shut && foldedClock && <span className="font-mono text-[14px] font-semibold tabular-nums opacity-90">{foldedClock}</span>}
            <span aria-hidden="true" className={cn('text-[20px] transition-transform', shut && 'opacity-80')}>🎬</span>
          </button>
        ) : (
          <span aria-hidden="true">🎬</span>
        )}
      </div>
      {!shut && children}
    </section>
  );
}

// ─── live, on the TV ────────────────────────────────────────────────

function LiveNight({ initial, companions, colors, subsNoteAtStart, onEnded }: { initial: TheaterNightView; companions: HouseCompanion[]; colors: ThemeColors; subsNoteAtStart?: string | null; onEnded: () => void }) {
  const id = initial.night.id;
  const base = `/api/theater/nights/${encodeURIComponent(id)}`;
  const [view, setView] = useState<TheaterNightView>(initial);
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [cues, setCues] = useState<TheaterCue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [setting, setSetting] = useState(false);
  const [typedTime, setTypedTime] = useState('');
  const [scrub, setScrub] = useState<number | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [folded, setFolded] = useState(readFolded);
  const fileRef = useRef<HTMLInputElement>(null);
  /** A quiet word about finding subtitles (none found, out of downloads, no key). */
  const [subsNote, setSubsNote] = useState<string | null>(subsNoteAtStart ?? null);

  const land = useCallback((data: TheaterNightView) => {
    setView(data);
    setReceivedAt(Date.now());
  }, []);

  const reload = useCallback(async () => {
    try {
      const res = await apiFetch(base);
      const data: unknown = await res.json().catch(() => null);
      if (res.ok && isNightView(data)) land(data);
    } catch {
      /* the next poll tries again */
    }
  }, [base, land]);

  const loadCues = useCallback(async () => {
    try {
      const res = await apiFetch(`${base}/cues`);
      const data = await res.json().catch(() => null) as { cues?: TheaterCue[] } | null;
      if (res.ok && Array.isArray(data?.cues)) setCues(data.cues);
    } catch {
      /* the caption just stays empty */
    }
  }, [base]);

  // Read again whenever the subtitles change under her (the house may still be
  // loading them when the screen opens, as on a next episode).
  const cueCount = view.night.cueCount;
  const subtitleName = view.night.subtitleName;
  useEffect(() => { void loadCues(); }, [loadCues, cueCount, subtitleName]);

  // The clock ticks here; the house is asked again now and then.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, []);
  const waiting = view.night.turn.state === 'waiting';
  const onComputer = view.night.mode === 'computer';
  useEffect(() => {
    const t = window.setInterval(() => void reload(), waiting ? WAITING_POLL_MS : onComputer ? EAR_POLL_MS : LIVE_POLL_MS);
    return () => window.clearInterval(t);
  }, [waiting, onComputer, reload]);

  // The socket says when a reply is being written in this night's thread.
  const [writing, setWriting] = useState(false);
  useEffect(() => {
    const stream = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string; writing?: boolean }>).detail;
      if (detail?.threadId !== view.night.threadId) return;
      setWriting(Boolean(detail.writing));
      if (!detail.writing) void reload();
    };
    window.addEventListener('bytelight:thread-stream', stream);
    return () => window.removeEventListener('bytelight:thread-stream', stream);
  }, [view.night.threadId, reload]);
  const presence = usePresence();
  useEffect(() => {
    if (presence === 'dormant' || presence === 'offline') setWriting(false);
  }, [presence]);
  useEffect(() => {
    const woke = () => { if (document.visibilityState === 'visible') void reload(); };
    document.addEventListener('visibilitychange', woke);
    return () => document.removeEventListener('visibilitychange', woke);
  }, [reload]);

  const act = async (key: string, path: string, body: unknown = {}): Promise<boolean> => {
    setBusy(key);
    setError(null);
    try {
      const res = await postJson(`${base}${path}`, body);
      if (!res.ok) throw new Error(await errorOf(res, 'That did not go through. Try again?'));
      const data: unknown = await res.json().catch(() => null);
      if (isNightView(data)) land(data);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through. Try again?');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const clock = (body: Record<string, unknown>) => act('clock', '/clock', body);
  const say = async (text: string) => {
    const words = text.trim();
    if (!words) return;
    if (await act('say', '/say', { text: words })) setDraft('');
  };

  const uploadSubs = async (file: File) => {
    setBusy('subs');
    setError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await apiFetch(`${base}/subtitles`, { method: 'POST', body });
      if (!res.ok) throw new Error(await errorOf(res, 'Those subtitles could not be loaded.'));
      const data: unknown = await res.json().catch(() => null);
      if (isNightView(data)) land(data);
      setSubsNote(null);
      await loadCues();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Those subtitles could not be loaded.');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /** The house finds the subtitles itself; `another` swaps in the next file it found. */
  const findSubs = useCallback(async (another: boolean) => {
    setBusy('find');
    setSubsNote(null);
    try {
      const res = await postJson(`${base}/subtitles/find`, { another });
      if (!res.ok) {
        setSubsNote(await errorOf(res, 'Subtitles could not be found just now. Load a file instead.'));
        void reload();
        return;
      }
      const data: unknown = await res.json().catch(() => null);
      if (isNightView(data)) land(data);
      await loadCues();
    } catch {
      setSubsNote('Subtitles could not be found just now. Load a file instead.');
    } finally {
      setBusy(null);
    }
  }, [base, land, loadCues, reload]);

  const end = async () => {
    if (await act('end', '/end')) onEnded();
  };

  /** Her button for the same move as saying "next one" on the couch. */
  const hasNext = view.night.season != null && view.night.episode != null;
  const next = async () => {
    if (await act('next', '/next')) onEnded();
  };

  // Ended without her tapping End (she asked them for the next episode, or
  // it ended somewhere else): move on to whatever is on now by itself, once
  // their reply has landed (handoffDelay in lib/theater.ts).
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;
  const handoff = handoffDelay(view.night);
  useEffect(() => {
    if (handoff === null) return;
    const t = window.setTimeout(() => endedRef.current(), handoff);
    return () => window.clearTimeout(t);
  }, [handoff]);

  const watching = mouthLine(view);

  const position = projectPosition(view.clock, receivedAt, now);
  const paused = view.clock.paused;
  const caption = captionAt(cues, position);
  const length = scrubLength(cues, position);
  const lines = useMemo(() => talkLines(view), [view]);
  const reactions = view.reactions?.length ? view.reactions : DEFAULT_REACTIONS;

  // Reading the couch here is reading it.
  const latestId = lines.length > 0 ? lines[lines.length - 1].id : null;
  useEffect(() => {
    if (!latestId || document.visibilityState !== 'visible') return;
    markRead(view.night.threadId, latestId);
  }, [view.night.threadId, latestId]);
  const talkBox = useRef<HTMLDivElement>(null);
  const typing = writing || waiting;
  useLayoutEffect(() => {
    const box = talkBox.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [latestId, typing, folded]);

  const controlBtn = 'flex h-11 min-w-11 items-center justify-center rounded-full px-3 text-[13px] font-semibold disabled:opacity-50';
  const ghost = { background: 'oklch(1 0 0 / 0.08)', color: SCREEN_INK } as const;

  return (
    <>
      {error && <p className="text-xs" style={{ color: 'var(--bytelight-accent)' }}>{error}</p>}
      {view.night.status === 'ended' && view.night.nextNightId && (
        <p className={cn('flex items-center gap-1.5 text-xs', colors.textMuted)} aria-live="polite">
          <Loader2 size={12} className="animate-spin" /> On to the next episode…
        </p>
      )}

      <ScreenCard view={view} folded={folded} onFold={() => setFolded((f) => { saveFolded(!f); return !f; })} foldedClock={formatClock(scrub ?? position)}>
        <div className="mt-4 text-center font-mono text-[40px] font-semibold tabular-nums tracking-wider" aria-live="off">
          {formatClock(scrub ?? position)}
        </div>
        {onComputer ? (
          <p className="mt-1 text-center text-[12px] opacity-70">
            {view.clock.started ? (paused ? 'Paused on the computer.' : 'Following the video on the computer.') : 'Press play on the computer; the clock follows it.'}
          </p>
        ) : (<>
        <div className="mt-2 flex items-center justify-center gap-3">
          <button className={controlBtn} style={ghost} disabled={busy === 'clock'} onClick={() => void clock({ action: 'seek', delta: -5 })} aria-label="Back 5 seconds">−5s</button>
          <button
            className={cn(controlBtn, 'h-14 w-14')}
            style={ACCENT_FILL}
            disabled={busy === 'clock'}
            onClick={() => void clock({ action: paused ? 'play' : 'pause' })}
            aria-label={paused ? 'Play' : 'Pause'}
          >
            {paused ? <Play size={22} /> : <Pause size={22} />}
          </button>
          <button className={controlBtn} style={ghost} disabled={busy === 'clock'} onClick={() => void clock({ action: 'seek', delta: 5 })} aria-label="Forward 5 seconds">+5s</button>
        </div>
        <input
          type="range"
          min={0}
          max={length}
          step={1}
          value={Math.min(length, Math.floor(scrub ?? position))}
          onChange={(e) => setScrub(Number(e.target.value))}
          onPointerUp={() => { if (scrub !== null) { void clock({ action: 'set', position: scrub }); setScrub(null); } }}
          onKeyUp={() => { if (scrub !== null) { void clock({ action: 'set', position: scrub }); setScrub(null); } }}
          className="mt-3 w-full"
          style={{ accentColor: 'var(--bytelight-accent)' }}
          aria-label="Drag the clock"
        />
        <p className="mt-1 text-center text-[12px] opacity-70">
          {view.clock.started ? 'Running with the TV. Tap ❚❚ when you pause.' : 'Tap ▶ when you press play on the TV.'}
        </p>

        {setting ? (
          <div className="mt-2 flex items-center justify-center gap-2">
            <input
              value={typedTime}
              onChange={(e) => setTypedTime(e.target.value)}
              placeholder="23:41"
              inputMode="numeric"
              className="w-24 rounded-lg border bg-transparent px-2 py-1 text-center font-mono text-[14px] outline-none"
              style={{ borderColor: 'oklch(1 0 0 / 0.25)', color: SCREEN_INK }}
              aria-label="The time on your TV"
            />
            <button
              className="rounded-lg px-3 py-1 text-[13px] font-semibold"
              style={ACCENT_FILL}
              onClick={async () => {
                const at = parseClockInput(typedTime);
                if (at === null) { setError('Type the time off the TV, like 23:41 or 1:02:03.'); return; }
                if (await clock({ action: 'resync', position: at, playing: !paused })) { setSetting(false); setTypedTime(''); }
              }}
            >
              Sync
            </button>
            <button className="text-[12px] opacity-70" onClick={() => setSetting(false)}>Cancel</button>
          </div>
        ) : (
          <div className="mt-1 text-center">
            <button className="text-[12px] underline opacity-70" onClick={() => { setTypedTime(formatClock(position)); setSetting(true); }}>Match the TV's time</button>
          </div>
        )}
        </>)}

        <div className="mt-3 min-h-[2.5rem] text-center text-[13px] italic leading-5 opacity-45" aria-label="The last lines behind the clock">
          {caption.map((cue, i) => <div key={`${cue.start}-${i}`} className="whitespace-pre-line">{cue.text}</div>)}
        </div>
        {watching && (
          <p className="mt-1 flex items-center justify-center gap-1.5 text-[11px] opacity-60" aria-live="polite">
            {view.mouth?.armed && <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: 'var(--bytelight-accent)' }} />}
            {watching}
          </p>
        )}

        {onComputer ? (
          <div className="mt-3 text-[12px]" aria-live="polite">
            <p className="flex items-center gap-1.5 opacity-80">
              <span aria-hidden="true" className={cn('inline-block h-1.5 w-1.5 rounded-full', view.ear?.listening && 'animate-pulse')} style={{ background: view.ear?.listening ? 'var(--bytelight-accent)' : 'oklch(1 0 0 / 0.35)' }} />
              👂 {earLine(view.ear)}
            </p>
            {view.ear?.lastLine && (
              <p className="mt-0.5 truncate opacity-60" title={view.ear.lastLine}>Last heard: “{view.ear.lastLine.replace(/\n/g, ' / ')}”</p>
            )}
          </div>
        ) : (<>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <span className="min-w-0 flex-1 truncate opacity-70" title={view.night.subtitleName ?? undefined}>
            {busy === 'find' ? 'Finding subtitles…' : subtitleLine(view.night)}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {busy === 'find' ? (
              <Loader2 size={14} className="animate-spin opacity-70" aria-label="Finding subtitles" />
            ) : canTryAnother(view.night) ? (
              <button className="flex items-center gap-1 rounded-full px-3 py-1.5 font-semibold" style={ghost} disabled={busy !== null} onClick={() => void findSubs(true)}>
                <RefreshCw size={12} /> Try another
              </button>
            ) : view.night.cueCount === 0 && view.night.subtitleSearched !== undefined ? (
              <button className="flex items-center gap-1 rounded-full px-3 py-1.5 font-semibold" style={ghost} disabled={busy !== null} onClick={() => void findSubs(false)}>
                <Search size={12} /> Find subtitles
              </button>
            ) : null}
            <button className="flex items-center gap-1 rounded-full px-3 py-1.5 font-semibold opacity-80" style={ghost} disabled={busy === 'subs' || busy === 'find'} onClick={() => fileRef.current?.click()}>
              {busy === 'subs' ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
              {view.night.cueCount > 0 ? 'Replace' : 'Load .srt / .vtt'}
            </button>
          </div>
          <input ref={fileRef} type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadSubs(f); }} />
        </div>
        {subsNote && <p className="mt-1 text-[11px] opacity-70" aria-live="polite">{subsNote}</p>}
        </>)}
      </ScreenCard>
      {onComputer && !view.ear?.paired && <EarPanel colors={colors} onChange={() => void reload()} />}

      <Panel colors={colors}>
        <h3 className={cn(LABEL, colors.textMuted)}>On the couch</h3>
        <RoomTalk
          scrollRef={talkBox}
          className={cn('mt-2', folded ? 'max-h-[62vh]' : 'max-h-[42vh]')}
          lines={lines}
          companions={onCouch(companions, view.seats)}
          typing={typing}
          empty={<p className={cn('py-4 text-center text-[13px]', colors.textMuted)}>Popcorn's out. Say something when it gets good.</p>}
        />
        {view.night.turn.state === 'empty' && view.night.turn.note && (
          <p className={cn('mt-2 text-[12px]', colors.textMuted)}>{view.night.turn.note}</p>
        )}
        <div className="mt-2 flex gap-2">
          {reactions.map((r) => (
            <button
              key={r}
              onClick={() => void say(r)}
              disabled={busy === 'say'}
              className={cn('flex h-10 flex-1 items-center justify-center rounded-xl border text-[20px] disabled:opacity-50', colors.panelBorder)}
              aria-label={`React ${r}`}
            >
              {r}
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void say(draft); } }}
            rows={1}
            maxLength={1000}
            placeholder="Say something on the couch…"
            className={cn('min-h-[40px] flex-1 resize-none rounded-xl border bg-transparent px-3 py-2 text-[14px] outline-none', colors.panelBorder, colors.textMain)}
          />
          <button onClick={() => void say(draft)} disabled={!draft.trim() || busy === 'say'} className="rounded-xl px-3 py-2 text-[13px] font-semibold disabled:opacity-50" style={ACCENT_FILL}>
            Say it
          </button>
        </div>
      </Panel>

      <div className="flex justify-center">
        {confirmEnd ? (
          <div className="flex items-center gap-3">
            <span className={cn('text-[13px]', colors.textMuted)}>Roll the credits? The night is kept.</span>
            <button className="rounded-xl px-3 py-1.5 text-[13px] font-semibold" style={ACCENT_FILL} disabled={busy === 'end'} onClick={() => void end()}>End night</button>
            <button className={cn('text-[13px]', colors.textMuted)} onClick={() => setConfirmEnd(false)}>Not yet</button>
          </div>
        ) : (
          <div className="flex items-center gap-4">
            {hasNext && (
              <button className="rounded-xl px-3 py-1.5 text-[13px] font-semibold disabled:opacity-50" style={ACCENT_FILL} disabled={busy === 'next'} onClick={() => void next()}>
                {busy === 'next' ? 'Finding the next one…' : `Next episode · E${(view.night.episode ?? 0) + 1}`}
              </button>
            )}
            <button className={cn('text-[13px] underline', colors.textMuted)} onClick={() => setConfirmEnd(true)}>End theater night</button>
          </div>
        )}
      </div>
    </>
  );
}

// ─── the Ear (browser extension) ────────────────────────────────────

/**
 * Pair the Ear: "Connect the Ear" makes a one-time code (10 minutes) she
 * pastes into the extension's popup; once claimed it shows Connected.
 * "Disconnect the Ear" stops its token working at once.
 */
function EarPanel({ colors, className, onChange }: { colors: ThemeColors; className?: string; onChange?: () => void }) {
  const [ear, setEar] = useState<TheaterEarPairing | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/theater/ear');
      const data: unknown = await res.json().catch(() => null);
      if (res.ok && isEarPairing(data)) setEar(data);
    } catch {
      /* the next look tries again */
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // While a code waits, look now and then: it disappears once the Ear claims it.
  useEffect(() => {
    if (!code) return;
    const t = window.setInterval(() => { setNow(Date.now()); void load(); }, 4000);
    return () => window.clearInterval(t);
  }, [code, load]);
  const left = code ? minutesLeft(code.expiresAt, now) : 0;
  const claimed = Boolean(code && ear?.paired && !ear.codeWaitingUntil);
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    if (!claimed) return;
    setCode(null);
    changed.current?.();
  }, [claimed]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await postJson('/api/theater/ear/pair');
      if (!res.ok) throw new Error(await errorOf(res, 'A code could not be made just now.'));
      const data = await res.json() as { code: string; expiresAt: string; ear?: unknown };
      setCode({ code: data.code, expiresAt: data.expiresAt });
      if (isEarPairing(data.ear)) setEar(data.ear);
      setNow(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'A code could not be made just now.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await postJson('/api/theater/ear/disconnect');
      if (!res.ok) throw new Error(await errorOf(res, 'The Ear could not be disconnected just now.'));
      const data: unknown = await res.json().catch(() => null);
      if (isEarPairing(data)) setEar(data);
      setConfirmOff(false);
      changed.current?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The Ear could not be disconnected just now.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel colors={colors} className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className={cn(LABEL, colors.textMuted)}>👂 The Ear</h3>
        <span className={cn('text-[12px]', colors.textMuted)}>
          {ear === null ? '…' : ear.paired ? (ear.listening ? 'Connected · listening' : 'Connected') : 'Not connected'}
        </span>
      </div>
      <p className={cn('mt-1 text-[12px]', colors.textMuted)}>
        A Chrome extension on the computer that hears the subtitles on Netflix or Hulu as they play. Turn subtitles on in the show.
      </p>
      {code && left > 0 ? (
        <div className="mt-2 text-center">
          <div className={cn('font-mono text-[26px] font-semibold tracking-[0.2em]', colors.textMain)} aria-label="Pairing code">{pairingCodeLabel(code.code)}</div>
          <p className={cn('text-[12px]', colors.textMuted)}>Paste this into the Ear on the computer. Good for {left} {left === 1 ? 'minute' : 'minutes'}, once.</p>
        </div>
      ) : code ? (
        <p className={cn('mt-2 text-[12px]', colors.textMuted)}>That code ran out. Make a new one.</p>
      ) : null}
      {error && <p className="mt-2 text-xs" style={{ color: 'var(--bytelight-accent)' }}>{error}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {(!ear?.paired || code) && (
          <Primary onClick={() => void connect()} busy={busy}>{code ? 'New code' : 'Connect the Ear'}</Primary>
        )}
        {ear?.paired && !code && (
          confirmOff ? (
            <>
              <span className={cn('text-[13px]', colors.textMuted)}>Stop the Ear listening?</span>
              <button className="rounded-xl px-3 py-1.5 text-[13px] font-semibold" style={ACCENT_FILL} disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
              <button className={cn('text-[13px]', colors.textMuted)} onClick={() => setConfirmOff(false)}>Keep it</button>
            </>
          ) : (
            <button className={cn('text-[13px] underline', colors.textMuted)} onClick={() => setConfirmOff(true)}>Disconnect the Ear</button>
          )
        )}
      </div>
    </Panel>
  );
}
