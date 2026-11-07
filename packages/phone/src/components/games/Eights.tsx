// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Crazy Eights — the one everybody already half knows under another name.
//
// Match the suit or the number on the pile. An eight goes on anything, and
// whoever plays it says what suit it counts as from then on. Stuck means draw
// until you can go. Empty your hand and you win.
//
// The owner's hand is a fan they can tap; anything unplayable is dimmed rather than
// hidden, so the rule teaches itself by being visible.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../bytelight';
import { useHouseRoster } from '../../lib/house';
import { SeatPending } from './SeatPending';
import { cn } from '../../lib/utils';
import type { ThemeConfig } from '../../lib/theme';

type CardId = string;
type Suit = 'spades' | 'clubs' | 'diamonds' | 'hearts';

interface EightsGame {
  order: string[];
  hands: Record<string, CardId[]>;
  stock: CardId[];
  pile: CardId[];
  suit: Suit;
  turn: string;
  phase: 'playing' | 'won';
  winner: string | null;
  events: string[];
  moves: number;
}

const SUITS: Suit[] = ['spades', 'clubs', 'diamonds', 'hearts'];
const SUIT_MARK: Record<Suit, string> = { spades: '♠', clubs: '♣', diamonds: '♦', hearts: '♥' };
const artUrl = (card: CardId) => `/api/games/cards/art/${card}`;

const rankOf = (card: CardId) => card.slice(card.indexOf('-') + 1);
const suitOf = (card: CardId) => card.slice(0, card.indexOf('-')) as Suit;

function playable(card: CardId, top: CardId, suit: Suit): boolean {
  if (rankOf(card) === '8') return true;
  return suitOf(card) === suit || rankOf(card) === rankOf(top);
}

interface EightsBoardProps {
  tableId: string | null;
  colors: ThemeConfig['light'];
  onTableId: (id: string) => void;
}

export function EightsBoard({ tableId, colors, onTableId }: EightsBoardProps) {
  const { owner, loaded: rosterLoaded, labelOf, sigilOf } = useHouseRoster();
  // The owner's seat is the house's answer (GET /api/companions), never a
  // name in the code.
  const ownerSeat = owner?.slug ?? '';
  const [game, setGame] = useState<EightsGame | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** the eight the owner has tapped, waiting on a suit */
  const [calling, setCalling] = useState<CardId | null>(null);
  const tableRef = useRef<string | null>(tableId);
  const inFlight = useRef(false);

  const act = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/games/cards/eights/${path}`, {
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
      setGame(parsed.game as EightsGame);
      return parsed.game as EightsGame;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [onTableId]);

  const deal = useCallback(() => {
    tableRef.current = null;
    setCalling(null);
    void act('new');
  }, [act]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!tableId) return;
      const res = await apiFetch(`/api/games/cards?id=${encodeURIComponent(tableId)}`);
      const body = await res.json().catch(() => null);
      if (cancelled || !body?.table || body.table.game !== 'eights') return;
      tableRef.current = body.table.id;
      if (body.table.state) setGame(body.table.state as EightsGame);
    })();
    return () => { cancelled = true; };
  }, [tableId]);

  if (!game) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[12px] opacity-70">
          Match the suit or the number on the pile. Eights go on anything — and you
          say what suit they count as. Empty your hand to win.
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

  const top = game.pile.at(-1) as CardId;
  const mine = game.hands[ownerSeat] ?? [];
  const myTurn = game.phase === 'playing' && game.turn === ownerSeat;
  const canGo = mine.some((c) => playable(c, top, game.suit));
  const others = game.order.filter((s) => s !== ownerSeat);
  const wildOnTop = rankOf(top) === '8';

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 scrollbar-hide">
      {error && <div className="text-[11px] opacity-60">{error}</div>}

      {/* the other three and how close they are to out */}
      <div className="flex items-start justify-around gap-2">
        {others.map((slug) => {
          const n = game.hands[slug]?.length ?? 0;
          const isTurn = game.phase === 'playing' && game.turn === slug;
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
            </div>
          );
        })}
      </div>

      {/* the pile, and what it currently counts as */}
      <div className="flex items-center justify-center gap-4">
        <button
          disabled={!myTurn || busy || canGo}
          onClick={() => act('draw')}
          className="flex flex-col items-center gap-1 disabled:opacity-40"
        >
          <img src={artUrl('back')} alt="" className="h-[76px] w-[50px] rounded-[5px]" draggable={false} />
          <span className="text-[9px] uppercase tracking-[.18em] opacity-60">draw {game.stock.length}</span>
        </button>
        <div className="flex flex-col items-center gap-1">
          <img src={artUrl(top)} alt="" className="h-[76px] w-[50px] rounded-[5px]" draggable={false} />
          <span className="text-[9px] uppercase tracking-[.18em]"
                style={{ color: wildOnTop ? colors.accent : undefined, opacity: wildOnTop ? 1 : 0.6 }}>
            {wildOnTop ? `called ${SUIT_MARK[game.suit]}` : SUIT_MARK[game.suit]}
          </span>
        </div>
      </div>

      <div className="text-center text-[11px] opacity-70">
        {game.phase === 'won'
          ? `${labelOf(game.winner ?? '') || game.winner} went out.`
          : !myTurn
            ? `${labelOf(game.turn) || game.turn} is thinking…`
            : calling
              ? 'Which suit does it count as?'
              : canGo ? 'Tap a card that matches the suit or the number.'
                      : 'Nothing goes — draw until something does.'}
      </div>

      {/* naming a suit for an eight */}
      {calling && (
        <div className="flex justify-center gap-2">
          {SUITS.map((s) => (
            <button
              key={s}
              disabled={busy}
              onClick={() => { const card = calling; setCalling(null); void act('play', { card, suit: s }); }}
              className={cn('rounded-xl border px-3 py-1.5 text-[15px] transition active:scale-95', colors.panelBorder)}
              style={{ color: s === 'hearts' || s === 'diamonds' ? '#c0392b' : undefined }}
            >
              {SUIT_MARK[s]}
            </button>
          ))}
          <button onClick={() => setCalling(null)}
                  className={cn('rounded-xl border px-3 py-1.5 text-[11px] opacity-60', colors.panelBorder)}>
            back
          </button>
        </div>
      )}

      {/* the owner's hand — unplayable cards stay visible and dimmed, so the rule shows */}
      <div className="flex flex-wrap items-end justify-center gap-1.5 pb-2">
        {mine.map((card) => {
          const ok = myTurn && playable(card, top, game.suit) && !calling;
          return (
            <button
              key={card}
              disabled={!ok || busy}
              onClick={() => (rankOf(card) === '8' ? setCalling(card) : void act('play', { card }))}
              className={cn('transition active:scale-95', ok ? '' : 'opacity-35')}
            >
              <img src={artUrl(card)} alt="" draggable={false}
                   className={cn('h-[84px] w-[55px] select-none rounded-[5px] shadow-[0_4px_12px_rgba(0,0,0,.35)]',
                                 ok ? 'ring-1 ring-current' : '')} />
            </button>
          );
        })}
      </div>

      <div className="flex justify-center pb-1">
        <button disabled={busy} onClick={deal}
                className={cn('rounded-xl border px-4 py-1.5 text-[11px] transition active:scale-95', colors.panelBorder)}>
          {game.phase === 'won' ? 'Another round' : 'New round'}
        </button>
      </div>
    </div>
  );
}
