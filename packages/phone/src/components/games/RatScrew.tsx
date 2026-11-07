// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Egyptian Rat Screw — the slap surface.
//
// The rules live on the server (services/db/rat-screw.ts); this screen only
// moves state and measures ONE honest thing: the owner's reaction. When a slappable
// pile renders, the clock starts on this side of the glass, and the owner's tap posts
// the elapsed milliseconds to race the companions' server-rolled reflexes. The slap
// button is live the whole game — tapping a quiet pile is a bad slap and burns
// a card, exactly as at a real table.
//
// The companions flip on their own cadence, driven from here: the server owns whose
// turn it is, this screen just keeps the table moving at a human pace — and
// the pace is the OWNER'S. While the rail input has focus the cadence holds, so
// the table rests whenever the owner is mid-sentence; a faster table was too quick
// to sit and talk at. Every fixed-size slot below (the dent bar, the card box)
// exists because the table used to reflow, and flicker, on each flip.
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Hand, RotateCcw } from 'lucide-react';
import { apiFetch } from '../../bytelight';
import { useHouseRoster } from '../../lib/house';
import { SeatPending } from './SeatPending';
import { cn } from '../../lib/utils';
import type { ThemeConfig } from '../../lib/theme';

type CardId = string;

interface RatScrewGame {
  order: string[];
  hands: Record<string, CardId[]>;
  pile: CardId[];
  turn: string;
  dent: { owner: string; remaining: number } | null;
  phase: 'playing' | 'slap' | 'won';
  slap: { pattern: 'double' | 'sandwich'; windowMs: number; rolls: Record<string, number> } | null;
  winner: string | null;
  events: string[];
  moves: number;
}

function artUrl(card: CardId): string {
  return `/api/games/cards/art/${card}`;
}

interface RatScrewBoardProps {
  tableId: string | null;
  colors: ThemeConfig['light'];
  onTableId: (id: string) => void;
}

export function RatScrewBoard({ tableId, colors, onTableId }: RatScrewBoardProps) {
  const { owner, loaded: rosterLoaded, labelOf, sigilOf } = useHouseRoster();
  // The owner's seat is the house's answer (GET /api/companions), never a
  // name in the code.
  const ownerSeat = owner?.slug ?? '';
  const [game, setGame] = useState<RatScrewGame | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tableRef = useRef<string | null>(tableId);
  // The owner's reaction clock: armed the moment a slap window renders.
  const slapArmedAt = useRef<number | null>(null);
  const inFlight = useRef(false);

  const act = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/games/cards/rat-screw/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tableId: tableRef.current, ...body }),
      });
      const parsed = await res.json().catch(() => null);
      if (!res.ok || !parsed?.game) {
        setError(parsed?.error ?? 'The table would not move.');
        return null;
      }
      setError(null);
      if (parsed.table?.id) {
        tableRef.current = parsed.table.id;
        onTableId(parsed.table.id);
      }
      setGame(parsed.game as RatScrewGame);
      return parsed.game as RatScrewGame;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [onTableId]);

  const deal = useCallback(() => {
    // A fresh deal always opens its own table so a half-played Klondike is
    // never overwritten by an enthusiastic slap night.
    tableRef.current = null;
    void act('new');
  }, [act]);

  // The table rests while the owner types: the rail input broadcasts its focus, and
  // a held cadence is the difference between a game and a metronome. The owner's taps
  // and flips work regardless — only the companions wait.
  const [railTyping, setRailTyping] = useState(false);
  useEffect(() => {
    const onTyping = (e: Event) => setRailTyping(Boolean((e as CustomEvent).detail));
    window.addEventListener('bytelight:card-rail-typing', onTyping);
    return () => window.removeEventListener('bytelight:card-rail-typing', onTyping);
  }, []);

  // The companions flip on a human cadence whenever it is one of theirs to flip —
  // unhurried on purpose, so the pile can be read and the room can talk. Not
  // before the owner's seat is known: until then every seat looks like a companion's.
  useEffect(() => {
    if (!ownerSeat || !game || game.phase !== 'playing' || game.turn === ownerSeat || railTyping) return;
    const actor = game.turn;
    const timer = window.setTimeout(() => {
      void act('flip', { actor });
    }, 2000 + Math.random() * 1200);
    return () => window.clearTimeout(timer);
  }, [game, act, railTyping, ownerSeat]);

  // Arm the owner's reaction clock when the slap window renders, and resolve the race
  // at the moment the fastest rolled hand actually lands — so a companion's slap is
  // something the owner SEES happen, not a verdict delivered at the deadline. If
  // every roll missed the window, resolution waits for the window itself and
  // the server lets the pile ride. A stale resolve is a server-side no-op, so
  // the timer racing the owner's tap can never cost them a pile they already took.
  useEffect(() => {
    if (!game || game.phase !== 'slap') {
      slapArmedAt.current = null;
      return;
    }
    slapArmedAt.current = performance.now();
    const windowMs = game.slap?.windowMs ?? 3500;
    const rolls = Object.values(game.slap?.rolls ?? {});
    const fastest = rolls.length ? Math.min(...rolls) : windowMs;
    const timer = window.setTimeout(() => {
      void act('resolve');
    }, Math.min(fastest, windowMs) + 200);
    return () => window.clearTimeout(timer);
  }, [game, act]);

  const onSlap = useCallback(() => {
    if (!game || game.phase === 'won') return;
    if (game.phase === 'slap' && slapArmedAt.current != null) {
      const reactionMs = Math.round(performance.now() - slapArmedAt.current);
      void act('slap', { reactionMs });
    } else {
      void act('slap');
    }
  }, [game, act]);

  const topCard = game?.pile.at(-1) ?? null;
  const underCard = game?.pile.at(-2) ?? null;
  const slapLive = game?.phase === 'slap';

  if (!game) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="text-[15px] font-semibold">Egyptian Rat Screw</div>
        <div className="max-w-[260px] text-[12px] leading-relaxed opacity-70">
          Doubles and sandwiches slap. Bad slaps burn. Face cards open the dent
          — and the dent always comes due.
        </div>
        <button
          onClick={deal}
          disabled={busy}
          className={cn('rounded-2xl border px-6 py-3 text-[13px] font-semibold shadow-lg transition active:scale-95', colors.panelBorder)}
          style={{ backgroundColor: 'var(--bytelight-surface-strong)', color: colors.accent }}
        >
          Deal the table
        </button>
        {error && <div className="text-[11px] text-red-400">{error}</div>}
      </div>
    );
  }

  if (!ownerSeat) return <SeatPending loaded={rosterLoaded} />;

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      {/* seats: hand counts, whose flip it is */}
      <div className="flex items-center justify-center gap-2">
        {game.order.map((slug) => (
          <div
            key={slug}
            className={cn('flex items-center gap-1.5 rounded-[var(--shape-control)] border px-2.5 py-1 text-[11px] font-semibold transition', colors.panelBorder,
                          game.turn === slug && game.phase === 'playing' ? '' : 'opacity-60')}
            style={game.turn === slug && game.phase === 'playing'
              ? { backgroundColor: 'var(--bytelight-surface-strong)', color: colors.accent }
              : undefined}
          >
            <span>{sigilOf(slug) || '🂠'}</span>
            <span>{labelOf(slug) || slug}</span>
            <span className="opacity-70">{game.hands[slug]?.length ?? 0}</span>
          </div>
        ))}
      </div>

      {/* the dent — a debt with a name. The slot keeps its height whether or
          not a dent is live, so opening one never shoves the pile around. */}
      <div className="flex h-7 items-center justify-center">
        <div
          className={cn('rounded-[var(--shape-control)] border px-3 py-1 text-[11px] transition-opacity duration-200', colors.panelBorder,
                        game.dent ? 'opacity-100' : 'opacity-0')}
          style={{ color: colors.accent }}
        >
          {game.dent
            ? (game.turn === game.dent.owner
              ? <>THE DENT — nobody left to pay {labelOf(game.dent.owner) || game.dent.owner} · {game.dent.remaining} chance{game.dent.remaining === 1 ? '' : 's'} on it</>
              : <>THE DENT — {labelOf(game.turn) || game.turn} owes {labelOf(game.dent.owner) || game.dent.owner} a face card · {game.dent.remaining} chance{game.dent.remaining === 1 ? '' : 's'} left</>)
            : '—'}
        </div>
      </div>

      {/* the pile: one fixed-aspect card box, WIDTH-driven. This screen sizes
          by content, so a height-driven box (h-full) has no ancestor height to
          resolve against and collapses to nothing — width × 2:3 holds the same
          still footprint with no dependence on the chain above. */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center py-1">
        <div className="relative aspect-[2/3] w-[min(46vw,172px)]">
          {underCard && (
            <img src={artUrl(underCard)} alt="" draggable={false}
                 className="absolute left-1/2 top-1/2 w-[88%] -translate-x-1/2 -translate-y-1/2 -rotate-6 select-none rounded-[8px] opacity-60 shadow-lg" />
          )}
          {topCard ? (
            <motion.img
              key={`${topCard}-${game.pile.length}`}
              initial={{ scale: 0.7, rotate: 8, opacity: 0 }}
              animate={{ scale: 1, rotate: 0, opacity: 1 }}
              transition={{ duration: 0.16 }}
              src={artUrl(topCard)} alt={topCard.replace('-', ' of ')} draggable={false}
              className="absolute inset-0 h-full w-full select-none rounded-[8px] shadow-[0_10px_30px_rgba(0,0,0,.45)]"
            />
          ) : (
            <div className={cn('absolute inset-0 flex items-center justify-center rounded-[8px] border text-[11px] uppercase tracking-widest opacity-40', colors.panelBorder)}>
              empty pile
            </div>
          )}
        </div>
        <div className="absolute bottom-1 right-2 text-[10px] opacity-50">{game.pile.length} in the pile</div>
        {slapLive && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
            className="absolute top-1 left-1/2 -translate-x-1/2 rounded-[var(--shape-control)] bg-red-600/90 px-4 py-1 text-[12px] font-bold uppercase tracking-widest text-white shadow-lg"
          >
            {game.slap?.pattern}! slap!
          </motion.div>
        )}
      </div>

      {/* the table talk ticker */}
      <div className="mx-auto max-w-full truncate px-3 text-center text-[11px] opacity-60">
        {game.events.at(-1) ?? ''}
      </div>

      {/* controls: flip and the ever-live slap surface */}
      {game.phase !== 'won' ? (
        <div className="flex items-stretch gap-2 pb-1">
          <button
            onClick={() => void act('flip', { actor: ownerSeat })}
            disabled={busy || game.phase !== 'playing' || game.turn !== ownerSeat || (game.hands[ownerSeat]?.length ?? 0) === 0}
            className={cn('flex-1 rounded-2xl border py-4 text-[13px] font-semibold transition active:scale-[.98] disabled:opacity-35', colors.panelBorder)}
            style={{ backgroundColor: 'var(--bytelight-surface-strong)', color: colors.accent }}
          >
            {game.turn === ownerSeat && game.phase === 'playing' ? 'Flip' : `${labelOf(game.turn) || game.turn} flips…`}
          </button>
          <button
            onClick={onSlap}
            disabled={busy && !slapLive}
            className={cn('flex-[1.6] rounded-2xl border py-4 text-[15px] font-extrabold uppercase tracking-widest transition active:scale-[.96]',
                          slapLive ? 'border-red-400/50 bg-red-600 text-white shadow-[0_0_28px_rgba(220,38,38,.55)]' : colors.panelBorder)}
            style={slapLive ? undefined : { backgroundColor: 'var(--bytelight-surface-strong)' }}
          >
            <span className="inline-flex items-center gap-2"><Hand size={18} /> SLAP</span>
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 pb-2">
          <div className="text-[15px] font-semibold" style={{ color: colors.accent }}>
            {game.winner === ownerSeat ? 'You hold the whole deck.' : `${labelOf(game.winner ?? '') || game.winner} holds the whole deck.`}
          </div>
          <button
            onClick={deal}
            className={cn('inline-flex items-center gap-2 rounded-2xl border px-5 py-2.5 text-[12px] font-semibold transition active:scale-95', colors.panelBorder)}
            style={{ backgroundColor: 'var(--bytelight-surface-strong)', color: colors.accent }}
          >
            <RotateCcw size={14} /> Again
          </button>
        </div>
      )}
      {error && <div className="pb-1 text-center text-[11px] text-red-400">{error}</div>}
    </div>
  );
}
