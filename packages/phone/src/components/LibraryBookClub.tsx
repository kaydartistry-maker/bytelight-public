// The Book Club — rounds of "what do we read next", inside the Library.
// She starts a round and the companions are woken to each pitch a book; she
// can pitch too. Everyone votes once (and can change it). She picks the
// winner, breaking any tie; a Gutenberg winner lands on the shelf on Reading.
// Finishing a round keeps it with the past rounds. The house's rules live in
// backend services/library-book-club.ts; the pure bits here in
// lib/library-book-club.ts.

import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, Loader2, BookOpen } from 'lucide-react';
import { ThemeConfig } from '../lib/theme';
import { cn } from '../lib/utils';
import { apiFetch } from '../bytelight';
import { useBackHandler } from '../lib/use-back-handler';
import {
  OWNER_SEAT,
  leadersOf,
  namesList,
  roundDate,
  seatName,
  stillToPitch,
  votersFor,
  winnerMode,
  type ClubPitch,
  type ClubRound,
  type ClubView,
} from '../lib/library-book-club';

const READER_FONT = "'Fraunces', Georgia, 'Times New Roman', serif";
const POLL_MS = 4000;

interface ShelfPick { id: number; title: string; authors: string[] }

export function LibraryBookClub({ shelf, onBack, onOpenBook, onShelfChanged, themeConfig, themeMode }: {
  /** Her shelf, so she can pitch a book she already has. */
  shelf: ShelfPick[];
  onBack: () => void;
  onOpenBook: (id: number) => void;
  /** A winner was put on the shelf: the Library re-reads it. */
  onShelfChanged: () => void;
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}) {
  const colors = themeConfig[themeMode];
  const [view, setView] = useState<ClubView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pitching, setPitching] = useState(false);
  const [confirm, setConfirm] = useState<'aside' | 'finish' | null>(null);
  useBackHandler(true, onBack);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/library/book-club');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setView(await res.json());
    } catch {
      setError('The book club could not be opened. Try again?');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // While the companions are choosing, look again every few seconds.
  const waiting = view?.current?.turn.state === 'waiting';
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [waiting, load]);

  async function act(key: string, path: string, body: unknown = {}, after?: (v: ClubView) => void) {
    setBusy(key);
    setError(null);
    try {
      const res = await apiFetch(`/api/library/book-club${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'That did not go through. Try again?');
      setView(data as ClubView);
      after?.(data as ClubView);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through. Try again?');
    } finally {
      setBusy(null);
    }
  }

  const seats = view?.seats ?? [];
  const companions = namesList(seats.map((s) => s.name)) || 'The companions';
  const round = view?.current ?? null;

  return (
    <div>
      <button onClick={onBack} className={cn('mb-3 flex items-center gap-1 text-xs font-semibold', colors.textMuted)}>
        <ChevronLeft size={14} /> Shelves
        <span className={cn('ml-2 text-sm', colors.textMain)} style={{ fontFamily: READER_FONT }}>📚 Book Club</span>
      </button>

      {error && <p className="mb-3 text-xs" style={{ color: colors.accent }}>{error}</p>}

      {view === null ? (
        <div className={cn('flex items-center justify-center gap-2 py-10 text-xs', colors.textMuted)}><Loader2 size={14} className="animate-spin" /> Opening the club…</div>
      ) : round === null ? (
        <Card colors={colors}>
          <p className={cn('mb-1 text-sm font-semibold', colors.textMain)} style={{ fontFamily: READER_FONT }}>What should we read next?</p>
          <p className={cn('mb-3 text-xs', colors.textMuted)}>
            Start a round and {companions} each pitch you a book. Everyone votes, and you pick the winner.
          </p>
          {pitching ? (
            <PitchForm
              shelf={shelf}
              submitLabel="Start with my pitch"
              busy={busy === 'start'}
              onCancel={() => setPitching(false)}
              onSubmit={(pitch) => act('start', '/rounds', { pitch }, () => setPitching(false))}
              colors={colors}
            />
          ) : (
            <div className="flex gap-2">
              <Primary onClick={() => void act('start', '/rounds')} busy={busy === 'start'} colors={colors}>Start a round</Primary>
              <Secondary onClick={() => setPitching(true)} colors={colors}>Pitch one too</Secondary>
            </div>
          )}
        </Card>
      ) : round.status === 'open' ? (
        <OpenRound
          round={round}
          view={view}
          shelf={shelf}
          busy={busy}
          pitching={pitching}
          setPitching={setPitching}
          confirm={confirm}
          setConfirm={setConfirm}
          act={act}
          onShelfChanged={onShelfChanged}
          colors={colors}
        />
      ) : (
        <Card colors={colors}>
          <p className={cn('mb-2 text-[11px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>Reading now</p>
          {(() => {
            const w = round.pitches.find((p) => p.id === round.winnerPitchId);
            if (!w) return null;
            return (
              <>
                <p className={cn('text-base font-semibold leading-tight', colors.textMain)} style={{ fontFamily: READER_FONT }}>{w.title}</p>
                {w.author && <p className={cn('text-xs', colors.textMuted)}>{w.author}</p>}
                <p className={cn('mt-1 text-xs', colors.textMuted)}>Pitched by {seatName(w.by, seats)}{w.pitch ? ` — “${w.pitch}”` : ''}</p>
              </>
            );
          })()}
          {round.shelveError && <p className={cn('mt-2 text-xs', colors.textMuted)}>{round.shelveError}</p>}
          <div className="mt-3 flex gap-2">
            {round.bookId !== null && shelf.some((b) => b.id === round.bookId) && (
              <Primary onClick={() => onOpenBook(round.bookId!)} colors={colors}><BookOpen size={12} /> Open the book</Primary>
            )}
            {confirm === 'finish' ? (
              <>
                <Secondary onClick={() => void act('finish', `/rounds/${round.id}/finish`, {}, () => setConfirm(null))} colors={colors}>
                  {busy === 'finish' ? 'Finishing…' : 'Yes, finish it'}
                </Secondary>
                <Secondary onClick={() => setConfirm(null)} colors={colors}>Not yet</Secondary>
              </>
            ) : (
              <Secondary onClick={() => setConfirm('finish')} colors={colors}>Finish this round</Secondary>
            )}
          </div>
        </Card>
      )}

      {view && view.past.length > 0 && (
        <div className="mt-5">
          <p className={cn('mb-2 text-[11px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>Past rounds</p>
          <div className="flex flex-col gap-2">
            {view.past.map((r) => {
              const w = r.pitches.find((p) => p.id === r.winnerPitchId);
              return (
                <div key={r.id} className={cn('rounded-xl border px-3 py-2', colors.panelBg, colors.panelBorder)}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={cn('line-clamp-1 text-sm font-semibold', colors.textMain)} style={{ fontFamily: READER_FONT }}>
                      {w ? w.title : 'Set aside'}
                    </span>
                    <span className={cn('shrink-0 text-[10px]', colors.textMuted)}>{roundDate(r.finishedAt ?? r.startedAt)}</span>
                  </div>
                  <p className={cn('text-[11px]', colors.textMuted)}>
                    {w ? `Pitched by ${seatName(w.by, seats)} · ` : ''}
                    {r.pitches.length === 0 ? 'No pitches' : `Also pitched: ${r.pitches.filter((p) => p.id !== r.winnerPitchId).map((p) => p.title).join(', ') || 'nothing else'}`}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

type Colors = ThemeConfig['light'];
type Act = (key: string, path: string, body?: unknown, after?: (v: ClubView) => void) => Promise<void>;

function OpenRound({ round, view, shelf, busy, pitching, setPitching, confirm, setConfirm, act, onShelfChanged, colors }: {
  round: ClubRound;
  view: ClubView;
  shelf: ShelfPick[];
  busy: string | null;
  pitching: boolean;
  setPitching: (v: boolean) => void;
  confirm: 'aside' | 'finish' | null;
  setConfirm: (v: 'aside' | 'finish' | null) => void;
  act: Act;
  onShelfChanged: () => void;
  colors: Colors;
}) {
  const seats = view.seats;
  const [breaking, setBreaking] = useState(false);
  const mine = round.pitches.find((p) => p.by === OWNER_SEAT) ?? null;
  const missing = stillToPitch(round, seats);
  const leaders = leadersOf(round);
  const mode = winnerMode(round);
  const tally = (id: string) => votersFor(round, id).length;
  const pick = (pitchId?: string) => act('pick', `/rounds/${round.id}/pick`, pitchId ? { pitchId } : {}, () => { setBreaking(false); onShelfChanged(); });

  return (
    <>
      {round.turn.state === 'waiting' && (
        <Card colors={colors}>
          <p className={cn('flex items-center gap-2 text-xs', colors.textMuted)}>
            <Loader2 size={13} className="animate-spin" />
            {missing.length > 0 ? `${namesList(missing.map((s) => s.name))} ${missing.length === 1 ? 'is' : 'are'} choosing a book…` : 'They are looking at the pitches…'}
          </p>
        </Card>
      )}
      {round.turn.state === 'empty' && (
        <Card colors={colors}>
          <p className={cn('mb-2 text-xs', colors.textMain)}>{round.turn.note ?? 'That turn came back without everything in.'}</p>
          <Secondary onClick={() => void act('ask', `/rounds/${round.id}/ask`)} colors={colors}>{busy === 'ask' ? 'Asking…' : 'Ask again'}</Secondary>
        </Card>
      )}

      <p className={cn('mb-2 mt-1 text-[11px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>
        Pitches · one vote each
      </p>
      {round.pitches.length === 0 && (
        <p className={cn('py-4 text-center text-xs italic', colors.textMuted)} style={{ fontFamily: READER_FONT }}>No pitches yet.</p>
      )}
      <div className="flex flex-col gap-2">
        {round.pitches.map((p) => (
          <PitchCard
            key={p.id}
            pitch={p}
            by={seatName(p.by, seats)}
            voters={votersFor(round, p.id).map((v) => seatName(v, seats))}
            mine={round.votes[OWNER_SEAT] === p.id}
            leading={tally(p.id) > 0 && leaders.includes(p.id)}
            breaking={breaking && leaders.includes(p.id)}
            busy={busy}
            onVote={() => void act(`vote:${p.id}`, `/rounds/${round.id}/votes`, { pitchId: p.id })}
            onPick={() => void pick(p.id)}
            colors={colors}
          />
        ))}
      </div>

      <div className="mt-3">
        {pitching ? (
          <Card colors={colors}>
            <PitchForm
              shelf={shelf}
              initial={mine}
              submitLabel={mine ? 'Change my pitch' : 'Add my pitch'}
              busy={busy === 'pitch'}
              onCancel={() => setPitching(false)}
              onSubmit={(pitch) => act('pitch', `/rounds/${round.id}/pitches`, pitch, () => setPitching(false))}
              colors={colors}
            />
          </Card>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Secondary onClick={() => setPitching(true)} colors={colors}>{mine ? 'Change my pitch' : 'Pitch a book'}</Secondary>
            {round.turn.state === 'idle' && (
              <Secondary onClick={() => void act('ask', `/rounds/${round.id}/ask`)} colors={colors}>
                {busy === 'ask' ? 'Asking…' : missing.length > 0 ? `Ask ${namesList(missing.map((s) => s.name))} again` : 'Ask them to look again'}
              </Secondary>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {mode === 'single' && (
          <Primary onClick={() => void pick()} busy={busy === 'pick'} colors={colors}>
            Pick the winner: {round.pitches.find((p) => p.id === leaders[0])?.title}
          </Primary>
        )}
        {mode === 'tie' && !breaking && (
          <Primary onClick={() => setBreaking(true)} colors={colors}>Pick the winner</Primary>
        )}
        {breaking && (
          <p className={cn('w-full text-xs', colors.textMain)}>
            {leaders.length === round.pitches.length && Object.keys(round.votes).length === 0 ? 'No votes yet, so it’s yours to choose.' : 'It’s a tie — you choose.'} Tap “This one” on the book you want.
            <button onClick={() => setBreaking(false)} className={cn('ml-2 underline', colors.textMuted)}>Never mind</button>
          </p>
        )}
        {confirm === 'aside' ? (
          <>
            <Secondary onClick={() => void act('aside', `/rounds/${round.id}/finish`, {}, () => setConfirm(null))} colors={colors}>
              {busy === 'aside' ? 'Setting aside…' : 'Yes, set it aside'}
            </Secondary>
            <Secondary onClick={() => setConfirm(null)} colors={colors}>Keep it</Secondary>
          </>
        ) : (
          <button onClick={() => setConfirm('aside')} className={cn('text-[11px] underline', colors.textMuted)}>Set this round aside</button>
        )}
      </div>
    </>
  );
}

function PitchCard({ pitch, by, voters, mine, leading, breaking, busy, onVote, onPick, colors }: {
  pitch: ClubPitch;
  by: string;
  voters: string[];
  mine: boolean;
  leading: boolean;
  breaking: boolean;
  busy: string | null;
  onVote: () => void;
  onPick: () => void;
  colors: Colors;
}) {
  return (
    <div
      className={cn('rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}
      style={leading ? { borderColor: colors.accent } : undefined}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className={cn('text-sm font-semibold leading-tight', colors.textMain)} style={{ fontFamily: READER_FONT }}>{pitch.title}</p>
          {pitch.author && <p className={cn('text-[11px]', colors.textMuted)}>{pitch.author}</p>}
        </div>
        <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold', colors.panelBorder, colors.textMuted)}>{by}</span>
      </div>
      {pitch.pitch && <p className={cn('mt-1.5 text-xs italic', colors.textMain)} style={{ fontFamily: READER_FONT }}>“{pitch.pitch}”</p>}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className={cn('text-[11px]', colors.textMuted)}>
          {voters.length === 0 ? 'No votes yet' : `${voters.length} vote${voters.length === 1 ? '' : 's'}: ${namesList(voters)}`}
        </span>
        {breaking ? (
          <button onClick={onPick} disabled={busy === 'pick'} className="rounded-lg px-3 py-1 text-[11px] font-semibold" style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}>
            {busy === 'pick' ? 'Picking…' : 'This one'}
          </button>
        ) : (
          <button
            onClick={onVote}
            disabled={mine || busy === `vote:${pitch.id}`}
            className={cn('rounded-lg border px-3 py-1 text-[11px] font-semibold', colors.panelBorder, !mine && colors.textMain)}
            style={mine ? { background: colors.accent, color: 'var(--bytelight-on-accent)', borderColor: colors.accent } : undefined}
          >
            {mine ? 'Your vote ✓' : busy === `vote:${pitch.id}` ? 'Voting…' : 'Vote'}
          </button>
        )}
      </div>
    </div>
  );
}

function PitchForm({ shelf, initial = null, submitLabel, busy, onSubmit, onCancel, colors }: {
  shelf: ShelfPick[];
  initial?: ClubPitch | null;
  submitLabel: string;
  busy: boolean;
  onSubmit: (pitch: { title: string; author: string; pitch: string; bookId: number | null }) => void;
  onCancel: () => void;
  colors: Colors;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [author, setAuthor] = useState(initial?.author ?? '');
  const [line, setLine] = useState(initial?.pitch ?? '');
  const [bookId, setBookId] = useState<number | null>(initial?.bookId ?? null);
  const field = cn('w-full rounded-xl border bg-transparent px-3 py-2 text-sm', colors.panelBorder, colors.textMain);

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (title.trim()) onSubmit({ title, author, pitch: line, bookId }); }}
      className="flex flex-col gap-2"
    >
      {shelf.length > 0 && (
        <select
          value={bookId ?? ''}
          onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : null;
            setBookId(id);
            const b = shelf.find((x) => x.id === id);
            if (b) { setTitle(b.title); setAuthor(b.authors.join(', ')); }
          }}
          className={cn(field, 'text-xs')}
          style={{ background: 'var(--bytelight-surface-strong)' }}
        >
          <option value="">A book from my shelf… (optional)</option>
          {shelf.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
        </select>
      )}
      <input value={title} onChange={(e) => { setTitle(e.target.value); setBookId(null); }} placeholder="Title" maxLength={200} className={field} />
      <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Author" maxLength={200} className={field} />
      <input value={line} onChange={(e) => setLine(e.target.value)} placeholder="Why this one? (optional)" maxLength={600} className={field} />
      <div className="flex gap-2">
        <Secondary onClick={onCancel} colors={colors}>Cancel</Secondary>
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className={cn('flex flex-1 items-center justify-center gap-1 rounded-xl px-3 py-2 text-xs font-semibold', (busy || !title.trim()) && 'opacity-50')}
          style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function Card({ children, colors }: { children: React.ReactNode; colors: Colors }) {
  return <div className={cn('mb-3 rounded-2xl border p-4 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>{children}</div>;
}

function Primary({ children, onClick, busy = false, colors }: { children: React.ReactNode; onClick: () => void; busy?: boolean; colors: Colors }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={cn('flex items-center justify-center gap-1 rounded-xl px-4 py-2 text-xs font-semibold', busy && 'opacity-60')}
      style={{ background: colors.accent, color: 'var(--bytelight-on-accent)' }}
    >
      {busy && <Loader2 size={12} className="animate-spin" />}
      {children}
    </button>
  );
}

function Secondary({ children, onClick, colors }: { children: React.ReactNode; onClick: () => void; colors: Colors }) {
  return (
    <button type="button" onClick={onClick} className={cn('rounded-xl border px-3 py-2 text-xs font-semibold', colors.panelBorder, colors.panelBg, colors.textMain)}>
      {children}
    </button>
  );
}
