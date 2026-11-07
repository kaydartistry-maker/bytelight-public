// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Hearts — four players, no partners, and everyone quietly trying to ruin one
// specific person.
//
// Pass three cards (left, right, across, then a hand where nobody passes).
// The two of clubs leads. Follow suit if you can. Hearts cannot be LED until
// somebody has thrown one away. Every heart is a point, the queen of spades is
// thirteen, and points are bad — unless you take all twenty-six, which hands
// everybody else twenty-six instead.
//
// Illegal cards stay on screen and dimmed rather than vanishing, same as Crazy
// Eights: the rules are easier to learn when you can see what they forbid.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../bytelight';
import { useHouseRoster } from '../../lib/house';
import { SeatPending } from './SeatPending';
import { cn } from '../../lib/utils';
import type { ThemeConfig } from '../../lib/theme';

type CardId = string;

interface HeartsGame {
  order: string[];
  hands: Record<string, CardId[]>;
  passing: Record<string, CardId[]>;
  direction: 'left' | 'right' | 'across' | 'hold';
  handNumber: number;
  trick: Array<{ slug: string; card: CardId }>;
  trickNumber: number;
  led: string | null;
  turn: string;
  heartsBroken: boolean;
  taken: Record<string, number>;
  totals: Record<string, number>;
  phase: 'passing' | 'playing' | 'handOver' | 'done';
  events: string[];
  moves: number;
}

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king', 'ace'];
const QUEEN = 'spades-queen';
const artUrl = (card: CardId) => `/api/games/cards/art/${card}`;
const rankOf = (c: CardId) => c.slice(c.indexOf('-') + 1);
const suitOf = (c: CardId) => c.slice(0, c.indexOf('-'));
const rankValue = (c: CardId) => RANKS.indexOf(rankOf(c));

/** The same rule the server enforces, so the owner's hand can show what is allowed. */
function legalFor(game: HeartsGame, hand: CardId[]): CardId[] {
  if (!hand.length) return [];
  const firstTrick = game.trickNumber === 0;
  if (firstTrick && game.trick.length === 0 && hand.includes('clubs-2')) return ['clubs-2'];
  if (game.trick.length === 0) {
    if (game.heartsBroken) return [...hand];
    const notHearts = hand.filter((c) => suitOf(c) !== 'hearts');
    return notHearts.length ? notHearts : [...hand];
  }
  const following = hand.filter((c) => suitOf(c) === game.led);
  if (following.length) return following;
  if (firstTrick) {
    const safe = hand.filter((c) => c !== QUEEN && suitOf(c) !== 'hearts');
    if (safe.length) return safe;
  }
  return [...hand];
}

interface HeartsBoardProps {
  tableId: string | null;
  colors: ThemeConfig['light'];
  onTableId: (id: string) => void;
}

export function HeartsBoard({ tableId, colors, onTableId }: HeartsBoardProps) {
  const { owner, loaded: rosterLoaded, labelOf, sigilOf } = useHouseRoster();
  // The owner's seat is the house's answer (GET /api/companions), never a
  // name in the code.
  const ownerSeat = owner?.slug ?? '';
  const [game, setGame] = useState<HeartsGame | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<CardId[]>([]);
  const tableRef = useRef<string | null>(tableId);
  const inFlight = useRef(false);

  const act = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/games/cards/hearts/${path}`, {
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
      setPicked([]);
      if (parsed.table?.id) {
        tableRef.current = parsed.table.id;
        onTableId(parsed.table.id);
      }
      setGame(parsed.game as HeartsGame);
      return parsed.game as HeartsGame;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [onTableId]);

  // A new hand on the SAME table, so the running totals and the pass rotation
  // both carry — a hand is a deal, not a new game.
  const deal = useCallback(() => { setPicked([]); void act('new'); }, [act]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!tableId) return;
      const res = await apiFetch(`/api/games/cards?id=${encodeURIComponent(tableId)}`);
      const body = await res.json().catch(() => null);
      if (cancelled || !body?.table || body.table.game !== 'hearts') return;
      tableRef.current = body.table.id;
      if (body.table.state) setGame(body.table.state as HeartsGame);
    })();
    return () => { cancelled = true; };
  }, [tableId]);

  if (!game) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[12px] opacity-70">
          Take no points. Every heart is one, the queen of spades is thirteen.
          Follow suit if you can. Lowest total wins — unless somebody takes all
          twenty-six, and then everyone else does instead.
        </p>
        <button
          disabled={busy}
          onClick={deal}
          className={cn('rounded-2xl border px-5 py-2 text-[12px] transition active:scale-95', colors.panelBorder)}
          style={{ backgroundColor: 'var(--bytelight-surface-strong)', color: colors.accent }}
        >
          Deal a hand
        </button>
        {error && <p className="text-[11px] opacity-60">{error}</p>}
      </div>
    );
  }

  if (!ownerSeat) return <SeatPending loaded={rosterLoaded} />;

  const mine = game.hands[ownerSeat] ?? [];
  const passingNow = game.phase === 'passing' && !game.passing[ownerSeat];
  const myTurn = game.phase === 'playing' && game.turn === ownerSeat;
  const legal = myTurn ? legalFor(game, mine) : [];
  const others = game.order.filter((s) => s !== ownerSeat);

  const tapCard = (card: CardId) => {
    if (passingNow) {
      setPicked((p) => (p.includes(card) ? p.filter((c) => c !== card) : p.length < 3 ? [...p, card] : p));
      return;
    }
    if (myTurn && legal.includes(card)) void act('play', { card });
  };

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3 scrollbar-hide">
      {error && <div className="text-[11px] opacity-60">{error}</div>}

      {/* running totals — the thing the whole game is actually about */}
      <div className="flex items-center justify-around">
        {game.order.map((slug) => (
          <div key={slug} className={cn('flex flex-col items-center',
                                        game.turn === slug && game.phase === 'playing' ? '' : 'opacity-65')}>
            <span className="text-[10px] font-semibold tracking-wide">
              {slug === ownerSeat ? 'you' : `${sigilOf(slug)} ${labelOf(slug) || slug}`}
            </span>
            <span className="text-[13px] font-semibold" style={{ color: colors.accent }}>{game.totals[slug]}</span>
            <span className="text-[9px] opacity-60">
              +{game.taken[slug]} this hand · {game.hands[slug]?.length ?? 0} left
            </span>
          </div>
        ))}
      </div>

      {/* the trick on the table */}
      <div className="flex min-h-[92px] items-center justify-center gap-1">
        {game.trick.length
          ? game.trick.map((e) => (
              <div key={e.card} className="flex flex-col items-center gap-0.5">
                <img src={artUrl(e.card)} alt="" draggable={false}
                     className="h-[76px] w-[50px] rounded-[5px] shadow-[0_4px_12px_rgba(0,0,0,.35)]" />
                <span className="text-[9px] opacity-55">{e.slug === ownerSeat ? 'you' : labelOf(e.slug) || e.slug}</span>
              </div>
            ))
          : <span className="text-[11px] opacity-45">
              {game.phase === 'passing' ? `passing ${game.direction}` : 'nothing on the table'}
            </span>}
      </div>

      <div className="text-center text-[11px] opacity-70">
        {game.phase === 'done'
          ? 'Game over — lowest total wins.'
          : game.phase === 'handOver'
            ? 'Hand over. Deal again to carry the totals on.'
            : passingNow
              ? `Choose three to pass ${game.direction}. (${picked.length}/3)`
              : game.phase === 'passing'
                ? 'Waiting on the others…'
                : !myTurn
                  ? `${labelOf(game.turn) || game.turn} is thinking…`
                  : game.heartsBroken ? 'Your turn — hearts are broken.' : 'Your turn — hearts not broken yet.'}
      </div>

      {passingNow && (
        <div className="flex justify-center">
          <button
            disabled={picked.length !== 3 || busy}
            onClick={() => act('pass', { cards: picked })}
            className={cn('rounded-xl border px-4 py-1.5 text-[11px] transition active:scale-95 disabled:opacity-35',
                          colors.panelBorder)}
            style={picked.length === 3 ? { backgroundColor: 'var(--bytelight-surface-strong)', color: colors.accent } : undefined}
          >
            Pass these three
          </button>
        </div>
      )}

      {/* the owner's hand */}
      <div className="flex flex-wrap items-end justify-center gap-1 pb-1">
        {mine.map((card) => {
          const ok = passingNow || (myTurn && legal.includes(card));
          const chosen = picked.includes(card);
          return (
            <button
              key={card}
              disabled={!ok || busy}
              onClick={() => tapCard(card)}
              className={cn('transition active:scale-95', ok ? '' : 'opacity-30')}
            >
              <img src={artUrl(card)} alt="" draggable={false}
                   className={cn('h-[78px] w-[51px] select-none rounded-[5px] shadow-[0_4px_12px_rgba(0,0,0,.35)]',
                                 chosen ? 'ring-2 ring-current' : ok ? 'ring-1 ring-current' : '')}
                   style={chosen ? { transform: 'translateY(-8px)' } : undefined} />
            </button>
          );
        })}
      </div>

      {game.events.length > 0 && (
        <div className="text-center text-[10px] opacity-45">{game.events.at(-1)}</div>
      )}

      <div className="flex justify-center pb-1">
        <button disabled={busy} onClick={deal}
                className={cn('rounded-xl border px-4 py-1.5 text-[11px] transition active:scale-95', colors.panelBorder)}>
          {game.phase === 'handOver' || game.phase === 'done' ? 'Next hand' : 'New hand'}
        </button>
      </div>
    </div>
  );
}
