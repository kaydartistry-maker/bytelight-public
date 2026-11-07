// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Six-card Golf — the first game in this room nobody at the table already knew.
//
// Six cards each in two rows of three, two turned up at the deal. Take the top
// of the stock or the top of the discard; a card off the discard has to go into
// your six, a card off the stock can go in OR be thrown away so you turn one of
// your own face-down cards up instead. When somebody has all six showing,
// everyone else gets one more turn.
//
// Low wins: king nothing, ace one, a two is MINUS two, jack and queen ten, and
// a matching pair in the same COLUMN cancels to nothing. Which is why the good
// hand is the one you keep getting rid of.
//
// The companions take their turns server-side the moment the owner's turn ends, so
// the board comes back with the table already moved round to the owner again.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../bytelight';
import { useHouseRoster } from '../../lib/house';
import { SeatPending } from './SeatPending';
import { cn } from '../../lib/utils';
import type { ThemeConfig } from '../../lib/theme';

type CardId = string;

interface GolfSlot { card: CardId; faceUp: boolean }

interface GolfGame {
  order: string[];
  hands: Record<string, GolfSlot[]>;
  stock: CardId[];
  discard: CardId[];
  turn: string;
  held: { card: CardId; from: 'stock' | 'discard' } | null;
  closedBy: string | null;
  turnsLeft: number;
  phase: 'playing' | 'done';
  scores: Record<string, number> | null;
  winner: string | null;
  moves: number;
}

const artUrl = (card: CardId) => `/api/games/cards/art/${card}`;

interface GolfBoardProps {
  tableId: string | null;
  colors: ThemeConfig['light'];
  onTableId: (id: string) => void;
}

export function GolfBoard({ tableId, colors, onTableId }: GolfBoardProps) {
  const { owner, loaded: rosterLoaded, labelOf, sigilOf } = useHouseRoster();
  // The owner's seat is the house's answer (GET /api/companions), never a
  // name in the code.
  const ownerSeat = owner?.slug ?? '';
  const [game, setGame] = useState<GolfGame | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tableRef = useRef<string | null>(tableId);
  const inFlight = useRef(false);

  const act = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/games/cards/golf/${path}`, {
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
      setGame(parsed.game as GolfGame);
      return parsed.game as GolfGame;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [onTableId]);

  const deal = useCallback(() => {
    // A fresh round always opens its own table, so a half-played anything else
    // is never overwritten.
    tableRef.current = null;
    void act('new');
  }, [act]);

  // Pick up an existing round if one is on this table.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!tableId) return;
      const res = await apiFetch(`/api/games/cards?id=${encodeURIComponent(tableId)}`);
      const body = await res.json().catch(() => null);
      if (cancelled || !body?.table || body.table.game !== 'golf') return;
      tableRef.current = body.table.id;
      if (body.table.state) setGame(body.table.state as GolfGame);
    })();
    return () => { cancelled = true; };
  }, [tableId]);

  const mine = game?.hands[ownerSeat] ?? [];
  const myTurn = game?.phase === 'playing' && game.turn === ownerSeat;
  const holding = myTurn ? game?.held ?? null : null;
  const canFlip = holding?.from === 'stock';

  const onSlot = (index: number) => {
    if (!myTurn || !holding) return;
    if (mine[index]?.faceUp) {
      void act('place', { index });
      return;
    }
    // A face-down slot can be swapped into as well; the flip is only offered
    // when the owner is throwing the held card away.
    void act('place', { index });
  };

  if (!game) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[12px] opacity-70">
          Six cards each. Lowest score wins — kings are nothing, a two is minus two,
          and a matching column cancels itself out.
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

  const others = game.order.filter((s) => s !== ownerSeat);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 scrollbar-hide">
      {error && <div className="text-[11px] opacity-60">{error}</div>}

      {/* the other three, their hands as they stand */}
      <div className="flex items-start justify-around gap-2">
        {others.map((slug) => {
          const hand = game.hands[slug] ?? [];
          const isTurn = game.phase === 'playing' && game.turn === slug;
          return (
            <div key={slug} className={cn('flex flex-col items-center gap-1', isTurn ? '' : 'opacity-70')}>
              <div className="grid grid-cols-3 gap-[2px]">
                {hand.map((slot, i) => (
                  <img
                    key={i}
                    src={artUrl(slot.faceUp ? slot.card : 'back')}
                    alt=""
                    draggable={false}
                    className="h-[34px] w-[23px] select-none rounded-[3px] shadow-[0_2px_6px_rgba(0,0,0,.35)]"
                  />
                ))}
              </div>
              <div className="text-[10px] font-semibold tracking-wide">
                {sigilOf(slug)} {labelOf(slug) || slug}
                {game.scores ? ` · ${game.scores[slug]}` : ''}
              </div>
            </div>
          );
        })}
      </div>

      {/* stock, discard, and whatever the owner is holding */}
      <div className="flex items-center justify-center gap-4">
        <button
          disabled={!myTurn || !!holding || busy}
          onClick={() => act('draw', { from: 'stock' })}
          className="flex flex-col items-center gap-1 disabled:opacity-40"
        >
          <img src={artUrl('back')} alt="" className="h-[76px] w-[50px] rounded-[5px]" draggable={false} />
          <span className="text-[9px] uppercase tracking-[.18em] opacity-60">stock {game.stock.length}</span>
        </button>

        <button
          disabled={!myTurn || !!holding || busy || !game.discard.length}
          onClick={() => act('draw', { from: 'discard' })}
          className="flex flex-col items-center gap-1 disabled:opacity-40"
        >
          {game.discard.at(-1)
            ? <img src={artUrl(game.discard.at(-1) as CardId)} alt="" className="h-[76px] w-[50px] rounded-[5px]" draggable={false} />
            : <div className="h-[76px] w-[50px] rounded-[5px] border border-dashed opacity-30" />}
          <span className="text-[9px] uppercase tracking-[.18em] opacity-60">discard</span>
        </button>

        {holding && (
          <div className="flex flex-col items-center gap-1">
            <img src={artUrl(holding.card)} alt=""
                 className="h-[76px] w-[50px] rounded-[5px] ring-2 ring-current" draggable={false} />
            <span className="text-[9px] uppercase tracking-[.18em]" style={{ color: colors.accent }}>holding</span>
          </div>
        )}
      </div>

      {/* what the owner is being asked for, in words */}
      <div className="text-center text-[11px] opacity-70">
        {game.phase === 'done'
          ? `${labelOf(game.winner ?? '') || game.winner} wins with ${game.scores?.[game.winner ?? ''] ?? ''}.`
          : !myTurn
            ? `${labelOf(game.turn) || game.turn} is thinking…`
            : holding
              ? (canFlip
                  ? 'Tap one of yours to swap it in, or throw it away and turn one over.'
                  : 'Off the discard — it has to go into your six. Tap a slot.')
              : 'Take the stock or the discard.'}
        {game.closedBy && game.phase === 'playing'
          ? ` · ${labelOf(game.closedBy) || game.closedBy} is out, ${game.turnsLeft} turn${game.turnsLeft === 1 ? '' : 's'} left`
          : ''}
      </div>

      {/* the owner's six */}
      <div className="flex flex-col items-center gap-2">
        <div className="grid grid-cols-3 gap-1.5">
          {mine.map((slot, i) => (
            <button
              key={i}
              disabled={!myTurn || !holding || busy}
              onClick={() => onSlot(i)}
              className={cn('transition active:scale-95', (!myTurn || !holding) && 'cursor-default')}
            >
              <img
                src={artUrl(slot.faceUp ? slot.card : 'back')}
                alt=""
                draggable={false}
                className={cn('h-[76px] w-[50px] select-none rounded-[5px] shadow-[0_4px_12px_rgba(0,0,0,.35)]',
                              myTurn && holding ? 'ring-1 ring-current' : '')}
              />
            </button>
          ))}
        </div>
        <div className="text-[10px] font-semibold tracking-wide" style={{ color: colors.accent }}>
          you{game.scores ? ` · ${game.scores[ownerSeat]}` : ''}
        </div>
      </div>

      {/* throwing the held card away is its own act, so it can never be a mis-tap */}
      {canFlip && (
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] uppercase tracking-[.18em] opacity-50">or bin it and turn one over</span>
          <div className="flex gap-1.5">
            {mine.map((slot, i) => (
              <button
                key={i}
                disabled={slot.faceUp || busy}
                onClick={() => act('flip', { index: i })}
                className={cn('rounded-lg border px-2 py-1 text-[10px] transition active:scale-95 disabled:opacity-25',
                              colors.panelBorder)}
              >
                {i + 1}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-center pt-1">
        <button
          disabled={busy}
          onClick={deal}
          className={cn('rounded-xl border px-4 py-1.5 text-[11px] transition active:scale-95', colors.panelBorder)}
        >
          {game.phase === 'done' ? 'Another round' : 'New round'}
        </button>
      </div>
    </div>
  );
}
