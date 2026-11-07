// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// President (Scum) — the one where the game remembers who lost.
//
// Play a set: one card, or two of a kind, or three. The next person has to play
// the SAME NUMBER of cards at a HIGHER rank, or pass. When everyone passes the
// pile is swept and whoever played last leads again with anything.
// Threes are low. TWOS ARE HIGH. First hand empty is President; last one still
// holding cards is Scum — and at the next deal the Scum pays the President
// their best card.
//
// The owner's hand is grouped by rank, so tapping a rank picks the whole set
// and they can drop one off before playing. Selecting is separate from playing
// on purpose: a set is a decision, not a tap.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../bytelight';
import { useHouseRoster } from '../../lib/house';
import { SeatPending } from './SeatPending';
import { cn } from '../../lib/utils';
import type { ThemeConfig } from '../../lib/theme';

type CardId = string;
type Title = 'president' | 'vice' | 'citizen' | 'scum';

interface PresidentGame {
  order: string[];
  hands: Record<string, CardId[]>;
  pile: CardId[][];
  setSize: number;
  turn: string;
  passed: string[];
  lastPlayed: string | null;
  finished: string[];
  titles: Record<string, Title> | null;
  phase: 'playing' | 'done';
  events: string[];
  moves: number;
}

const ORDER = ['3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king', 'ace', '2'];
const artUrl = (card: CardId) => `/api/games/cards/art/${card}`;
const rankOf = (card: CardId) => card.slice(card.indexOf('-') + 1);
const rankValue = (card: CardId) => ORDER.indexOf(rankOf(card));

interface PresidentBoardProps {
  tableId: string | null;
  colors: ThemeConfig['light'];
  onTableId: (id: string) => void;
}

export function PresidentBoard({ tableId, colors, onTableId }: PresidentBoardProps) {
  const { owner, loaded: rosterLoaded, labelOf, sigilOf } = useHouseRoster();
  // The owner's seat is the house's answer (GET /api/companions), never a
  // name in the code.
  const ownerSeat = owner?.slug ?? '';
  const [game, setGame] = useState<PresidentGame | null>(null);
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
      const res = await apiFetch(`/api/games/cards/president/${path}`, {
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
      setGame(parsed.game as PresidentGame);
      return parsed.game as PresidentGame;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [onTableId]);

  // A new round on the SAME table, so the tax carries over from last time.
  const deal = useCallback(() => { setPicked([]); void act('new'); }, [act]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!tableId) return;
      const res = await apiFetch(`/api/games/cards?id=${encodeURIComponent(tableId)}`);
      const body = await res.json().catch(() => null);
      if (cancelled || !body?.table || body.table.game !== 'president') return;
      tableRef.current = body.table.id;
      if (body.table.state) setGame(body.table.state as PresidentGame);
    })();
    return () => { cancelled = true; };
  }, [tableId]);

  if (!game) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[12px] opacity-70">
          Play a set — one, two or three of a kind. The next player has to match the
          count and beat the rank, or pass. Threes are low and twos are high.
          First hand empty is President. Last one holding cards is Scum, and pays for it.
        </p>
        <button
          disabled={busy}
          onClick={deal}
          className={cn('rounded-2xl border px-5 py-2 text-[12px] transition active:scale-95', colors.panelBorder)}
          style={{ backgroundColor: 'var(--bytelight-surface-strong)', color: colors.accent }}
        >
          Deal a round
        </button>
        {error && <p className="text-[11px] opacity-60">{error}</p>}
      </div>
    );
  }

  if (!ownerSeat) return <SeatPending loaded={rosterLoaded} />;

  const mine = game.hands[ownerSeat] ?? [];
  const myTurn = game.phase === 'playing' && game.turn === ownerSeat;
  const top = game.pile.at(-1) ?? null;
  const leading = !top;
  const others = game.order.filter((s) => s !== ownerSeat);

  // The owner's hand, grouped by rank so a set is one thing to reach for.
  const byRank = new Map<string, CardId[]>();
  for (const card of [...mine].sort((a, b) => rankValue(a) - rankValue(b))) {
    const r = rankOf(card);
    byRank.set(r, [...(byRank.get(r) ?? []), card]);
  }

  const legal = picked.length > 0
    && (leading || (picked.length === game.setSize && rankValue(picked[0]) > rankValue(top![0])));

  const togglePick = (cards: CardId[]) => {
    if (!myTurn) return;
    const same = picked.length && rankOf(picked[0]) === rankOf(cards[0]);
    if (same) {
      // Tapping the same rank again drops one off the set, so the owner can answer a
      // single with a single out of a pair they are holding.
      setPicked((p) => (p.length > 1 ? p.slice(0, p.length - 1) : []));
      return;
    }
    setPicked(leading ? cards : cards.slice(0, Math.max(1, game.setSize)));
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 scrollbar-hide">
      {error && <div className="text-[11px] opacity-60">{error}</div>}

      <div className="flex items-start justify-around gap-2">
        {others.map((slug) => {
          const n = game.hands[slug]?.length ?? 0;
          const isTurn = game.phase === 'playing' && game.turn === slug;
          const title = game.titles?.[slug];
          return (
            <div key={slug} className={cn('flex flex-col items-center gap-1', isTurn ? '' : 'opacity-70')}>
              <div className="relative h-[54px] w-[62px]">
                {Array.from({ length: Math.min(n, 5) }).map((_, i) => (
                  <img key={i} src={artUrl('back')} alt="" draggable={false}
                       className="absolute left-0 top-0 h-[54px] w-[36px] select-none rounded-[4px] shadow-[0_3px_9px_rgba(0,0,0,.35)]"
                       style={{ transform: `translateX(${i * 6}px) rotate(${(i - 2) * 2.5}deg)` }} />
                ))}
                {n === 0 && <div className="h-[54px] w-[36px] rounded-[4px] border border-dashed opacity-30" />}
              </div>
              <div className="text-[10px] font-semibold tracking-wide">
                {sigilOf(slug)} {labelOf(slug) || slug} · {n}
              </div>
              {title && <div className="text-[9px] uppercase tracking-[.16em]" style={{ color: colors.accent }}>{title}</div>}
              {game.passed.includes(slug) && !title && <div className="text-[9px] opacity-50">passed</div>}
            </div>
          );
        })}
      </div>

      {/* what is on the table */}
      <div className="flex min-h-[86px] items-center justify-center gap-1">
        {top
          ? top.map((card) => (
              <img key={card} src={artUrl(card)} alt="" draggable={false}
                   className="h-[76px] w-[50px] rounded-[5px] shadow-[0_4px_12px_rgba(0,0,0,.35)]" />
            ))
          : <span className="text-[11px] opacity-50">nothing down — a fresh lead</span>}
      </div>

      <div className="text-center text-[11px] opacity-70">
        {game.phase === 'done'
          ? `${labelOf(game.finished[0]) || game.finished[0]} is President. ${labelOf(game.finished.at(-1) ?? '') || game.finished.at(-1)} is Scum.`
          : !myTurn
            ? `${labelOf(game.turn) || game.turn} is thinking…`
            : leading
              ? 'Your lead — put down any set.'
              : `Beat it with ${game.setSize} card${game.setSize === 1 ? '' : 's'}, higher rank, or pass.`}
      </div>

      {/* the owner's hand, grouped */}
      <div className="flex flex-wrap items-end justify-center gap-1.5">
        {[...byRank.entries()].map(([rank, cards]) => {
          const isPicked = picked.length > 0 && rankOf(picked[0]) === rank;
          return (
            <button
              key={rank}
              disabled={!myTurn || busy}
              onClick={() => togglePick(cards)}
              className={cn('relative transition active:scale-95', myTurn ? '' : 'opacity-60')}
            >
              <div className="relative" style={{ width: 55 + (cards.length - 1) * 10, height: 84 }}>
                {cards.map((card, i) => (
                  <img key={card} src={artUrl(card)} alt="" draggable={false}
                       className={cn('absolute top-0 h-[84px] w-[55px] select-none rounded-[5px] shadow-[0_4px_12px_rgba(0,0,0,.35)]',
                                     isPicked && i < picked.length ? 'ring-2 ring-current' : '')}
                       style={{ left: i * 10, transform: isPicked && i < picked.length ? 'translateY(-8px)' : undefined }} />
                ))}
              </div>
            </button>
          );
        })}
      </div>

      {myTurn && (
        <div className="flex items-center justify-center gap-2 pb-1">
          <button
            disabled={!legal || busy}
            onClick={() => act('play', { cards: picked })}
            className={cn('rounded-xl border px-4 py-1.5 text-[11px] transition active:scale-95 disabled:opacity-35',
                          colors.panelBorder)}
            style={legal ? { backgroundColor: 'var(--bytelight-surface-strong)', color: colors.accent } : undefined}
          >
            {picked.length ? `Play ${picked.length}` : 'Play'}
          </button>
          <button
            disabled={leading || busy}
            onClick={() => act('pass')}
            className={cn('rounded-xl border px-4 py-1.5 text-[11px] transition active:scale-95 disabled:opacity-35',
                          colors.panelBorder)}
          >
            Pass
          </button>
        </div>
      )}

      {game.events.length > 0 && (
        <div className="text-center text-[10px] opacity-45">{game.events.at(-1)}</div>
      )}

      <div className="flex justify-center pb-1">
        <button disabled={busy} onClick={deal}
                className={cn('rounded-xl border px-4 py-1.5 text-[11px] transition active:scale-95', colors.panelBorder)}>
          {game.phase === 'done' ? 'Next round (the Scum pays)' : 'New round'}
        </button>
      </div>
    </div>
  );
}
