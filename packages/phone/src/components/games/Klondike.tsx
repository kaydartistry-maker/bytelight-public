// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Klondike, with the companions at the table.
//
// Tap to pick a card up, tap where it goes. Drag is worse on a phone — a
// mis-drag loses the card, a mis-tap costs nothing and the selection is visible
// the whole time. Tapping a card that is already picked up sends it home if it
// fits, which is the move people make ninety percent of the time.
//
// The rules are NOT in here. Every move is posted to the server, which owns the
// only copy of the board — so a bug in this file can make the screen wrong but
// can never make the game wrong.
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { RotateCcw, Sparkles, Undo2 } from 'lucide-react';
import { apiFetch } from '../../bytelight';
import { cn } from '../../lib/utils';
import { CardCascade } from './CardCascade';
import type { ThemeConfig } from '../../lib/theme';

type CardId = string;
type Suit = 'spades' | 'clubs' | 'diamonds' | 'hearts';

interface TableauCard { card: CardId; faceUp: boolean }

interface Klondike {
  drawCount: 1 | 3;
  stock: CardId[];
  waste: CardId[];
  foundations: Record<Suit, CardId[]>;
  tableau: TableauCard[][];
  moves: number;
  wonAt: string | null;
  history: string[];
}

interface Selection {
  from: 'waste' | 'tableau' | 'foundation';
  index?: number;
  suit?: Suit;
  count?: number;
  card: CardId;
}

const SUITS: Suit[] = ['spades', 'hearts', 'clubs', 'diamonds'];
const RANK_ORDER = ['ace','2','3','4','5','6','7','8','9','10','jack','queen','king'];
const art = (card: CardId) => `/api/games/cards/art/${card}`;

// The board is laid out at full size from the deal rather than growing under
// the player's hand. A column is one card tall plus a sliver per card beneath it, and
// every column reserves a full King-to-Ace run whether it holds one or twelve
// — so moving a stack across changes what is on the table, never its shape.
const CARD_FAN = 17;
const CARD_BASE = 62;
const RESERVED_DEPTH = 13;
const columnHeight = (cards: number) => CARD_BASE + cards * CARD_FAN;
const COLUMN_RESERVE = columnHeight(RESERVED_DEPTH);

function Slot({ children, className, onClick, live }: {
  children?: React.ReactNode; className?: string; onClick?: () => void; live?: boolean;
}) {
  // An empty slot needs its own surface. Border alone was 25% of the text color
  // at 40% opacity, which vanishes completely over a busy wallpaper — and an
  // invisible foundation is a game with nowhere to put the aces.
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative aspect-[2/3] w-full rounded-[6px] border border-dashed transition-colors',
        live ? 'border-current opacity-100' : 'border-current/40 bg-black/35 opacity-80',
        className,
      )}
    >
      {children}
    </button>
  );
}

interface KlondikeProps {
  tableId: string | null;
  colors: ThemeConfig['light'];
  onTableId: (id: string) => void;
}

export function KlondikeBoard({ tableId, colors, onTableId }: KlondikeProps) {
  const [game, setGame] = useState<Klondike | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canFinish, setCanFinish] = useState(false);
  const [cascade, setCascade] = useState<string[]>([]);
  const [drawCount, setDrawCount] = useState<1 | 3>(1);
  const [dealing, setDealing] = useState(false);
  const busy = useRef(false);

  const post = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await apiFetch(`/api/games/cards/solitaire${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tableId, ...body }),
      });
      const parsed = await res.json().catch(() => null);
      if (!parsed || !('game' in parsed)) {
        setError(parsed?.error ?? 'The Card Room needs one byte-light restart to open.');
        return null;
      }
      setError(null);
      setGame(parsed.game as Klondike);
      setCanFinish(Boolean(parsed.canAutoFinish));
      if (parsed.table?.id) onTableId(parsed.table.id);
      if (Array.isArray(parsed.order) && parsed.order.length) setCascade(parsed.order);
      return parsed;
    } finally {
      busy.current = false;
      setSelected(null);
    }
  }, [tableId, onTableId]);

  // The board is the server's. Anything the room does to it arrives here — and
  // ON MOUNT we go and ASK, because this only ever listened for a push. Walking
  // out of the Card Room and back showed a Deal screen over a game that was
  // sitting safe on the server the whole time.
  useEffect(() => {
    let stale = false;
    const refresh = async () => {
      const res = await apiFetch('/api/games/cards');
      const body = await res.json().catch(() => null);
      if (stale) return;
      if (body?.table?.game === 'klondike' && body.table.state) {
        setGame(body.table.state as Klondike);
        // ABSENT IS NOT FALSE. This response used to be read for a field it
        // does not carry, so every move's own broadcast came straight back
        // and switched Finish It off again — it appeared and vanished in the
        // same breath. Only a response that actually answers gets to decide.
        if ('canAutoFinish' in (body ?? {})) setCanFinish(Boolean(body.canAutoFinish));
      }
    };
    void refresh();
    const onUpdate = () => void refresh();
    window.addEventListener('bytelight:card-table-update', onUpdate);
    return () => { stale = true; window.removeEventListener('bytelight:card-table-update', onUpdate); };
  }, []);

  // The pill clears itself: a split second, not a sticky note.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 1700);
    return () => clearTimeout(timer);
  }, [error]);

  // Would this single card be accepted by its foundation right now? Used only
  // to decide whether a second tap means "send it home" or "put it down".
  const canGoHome = useCallback((card: CardId): boolean => {
    if (!game) return false;
    const [suit, rank] = card.split('-') as [Suit, string];
    const top = game.foundations[suit]?.at(-1);
    const order = RANK_ORDER.indexOf(rank);
    if (order < 0) return false;
    if (!top) return order === 0;
    return order === RANK_ORDER.indexOf(top.split('-')[1]) + 1;
  }, [game]);

  const move = useCallback((to: 'tableau' | 'foundation', toIndex?: number, toSuit?: Suit) => {
    if (!selected) return;
    void post('/move', {
      move: {
        from: selected.from, fromIndex: selected.index, fromSuit: selected.suit,
        count: selected.count, to, toIndex, toSuit,
      },
    });
  }, [selected, post]);

  const tapCard = useCallback((sel: Selection) => {
    // Second tap on the same card = send it home, which is the common move.
    // But a card holding a run behind it can't go home, and neither can one
    // whose foundation isn't ready — so in that case the second tap is a
    // DESELECT instead. Nothing is lost: the move it used to attempt was one
    // the server was always going to refuse.
    if (selected && selected.card === sel.card && selected.from === sel.from) {
      if ((sel.count ?? 1) > 1 || !canGoHome(sel.card)) {
        setSelected(null);
        return;
      }
      void post('/move', {
        move: {
          from: sel.from, fromIndex: sel.index, fromSuit: sel.suit, count: 1,
          to: 'foundation', toSuit: sel.card.split('-')[0] as Suit,
        },
      });
      return;
    }
    setSelected(sel);
  }, [selected, post, canGoHome]);

  // The draw count is only choosable at the deal, so New has to come back
  // through here — it used to re-deal on the count already being played,
  // which made draw three a room with no door out of it.
  if (!game || dealing) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        {error && <div className="text-center text-xs opacity-70">{error}</div>}
        <div className="flex items-center gap-2 text-xs">
          <span className="opacity-60">draw</span>
          {([1, 3] as const).map((n) => (
            <button key={n} onClick={() => setDrawCount(n)}
                    className={cn('rounded-[var(--shape-control)] border px-3 py-1', colors.panelBorder,
                                  drawCount === n ? 'opacity-100' : 'opacity-40')}>
              {n}
            </button>
          ))}
        </div>
        <button
          onClick={() => { setDealing(false); void post('/new', { drawCount }); }}
          className={cn('rounded-[var(--shape-control)] border px-6 py-3 text-sm', colors.panelBg, colors.panelBorder)}
        >
          Deal
        </button>
        {game && (
          <button
            onClick={() => setDealing(false)}
            className="text-[11px] uppercase tracking-[.2em] opacity-50"
          >
            keep the game I'm on
          </button>
        )}
      </div>
    );
  }

  const wasteTop = game.waste.at(-1) ?? null;
  const won = Boolean(game.wonAt);

  return (
    <div className="relative flex h-full flex-col gap-2 p-2">
      {/* A pill, not a row. As a row it pushed the whole board down and let it
          snap back on the next move, and one fix covers both. It floats over the board and clears itself. */}
      {error && (
        <div className="pointer-events-none absolute inset-x-0 top-1 z-40 flex justify-center">
          <motion.div
            key={error}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: [0, 1, 0.45, 1, 0], y: 0 }}
            transition={{ duration: 1.6, times: [0, 0.15, 0.4, 0.6, 1] }}
            className={cn('rounded-[var(--shape-control)] border px-3 py-1 text-[11px] shadow-lg', colors.panelBg, colors.panelBorder)}
          >
            {error}
          </motion.div>
        </div>
      )}

      {/* stock, waste, foundations */}
      <div className="grid grid-cols-7 gap-1">
        <Slot onClick={() => post('/draw')} live={game.stock.length > 0}>
          {game.stock.length > 0 && (
            <img src={art('back')} alt="" draggable={false}
                 className="absolute inset-0 h-full w-full rounded-[6px]" />
          )}
          <span className="absolute -bottom-4 left-0 w-full text-center text-[9px] opacity-50">
            {game.stock.length}
          </span>
        </Slot>

        <Slot
          live={!!wasteTop}
          onClick={() => wasteTop && tapCard({ from: 'waste', card: wasteTop, count: 1 })}
          className={selected?.from === 'waste' ? 'ring-2 ring-current' : undefined}
        >
          {wasteTop && (
            <img src={art(wasteTop)} alt={wasteTop} draggable={false}
                 className="absolute inset-0 h-full w-full rounded-[6px]" />
          )}
        </Slot>

        <div />

        {SUITS.map((suit) => {
          const top = game.foundations[suit].at(-1);
          return (
            <Slot key={suit} live={!!top}
                  onClick={() => (selected ? move('foundation', undefined, suit)
                                           : top && tapCard({ from: 'foundation', suit, card: top, count: 1 }))}>
              {top
                ? <img src={art(top)} alt={top} draggable={false}
                       className="absolute inset-0 h-full w-full rounded-[6px]" />
                : <span className="absolute inset-0 flex items-center justify-center text-[10px] opacity-40">
                    {suit[0].toUpperCase()}
                  </span>}
            </Slot>
          );
        })}
      </div>

      {/* the seven columns */}
      <div className="grid flex-1 grid-cols-7 gap-1 overflow-y-auto pt-4">
        {game.tableau.map((pile, index) => (
          <div key={index} className="relative" style={{ minHeight: COLUMN_RESERVE }}>
            {pile.length === 0 ? (
              <Slot onClick={() => selected && move('tableau', index)} />
            ) : (
              <div className="relative" style={{ height: Math.max(COLUMN_RESERVE, columnHeight(pile.length)) }}>
                {pile.map((entry, i) => {
                  const runLength = pile.length - i;
                  const isSelected = selected?.from === 'tableau'
                    && selected.index === index && selected.count === runLength;
                  // Everything from the selected card DOWN is what the player picked
                  // up, so the whole run comes forward together and keeps its
                  // own order. Lifting only the top card of the run made the
                  // back card jump in front of the ones it was carrying.
                  const inSelectedRun = selected?.from === 'tableau'
                    && selected.index === index
                    && runLength <= selected.count;
                  return (
                    <button
                      key={entry.card + i}
                      onClick={() => {
                        if (!entry.faceUp) return;
                        if (selected && i === pile.length - 1 && selected.index !== index) {
                          move('tableau', index);
                          return;
                        }
                        tapCard({ from: 'tableau', index, count: runLength, card: entry.card });
                      }}
                      className="absolute left-0 w-full"
                      style={{ top: i * CARD_FAN, zIndex: inSelectedRun ? 20 + i : undefined }}
                    >
                      <img
                        src={art(entry.faceUp ? entry.card : 'back')}
                        alt={entry.faceUp ? entry.card : ''}
                        draggable={false}
                        className={cn('w-full rounded-[5px] shadow-[0_3px_10px_rgba(0,0,0,.35)]',
                                      inSelectedRun && 'ring-2 ring-current brightness-110')}
                      />
                    </button>
                  );
                })}
                {/* the drop target for a column is its bottom edge */}
                <button
                  onClick={() => selected && move('tableau', index)}
                  className="absolute bottom-0 left-0 h-8 w-full"
                  aria-label={`column ${index + 1}`}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-center gap-2 pb-1">
        <button onClick={() => post('/undo')} disabled={!game.history.length}
                className={cn('flex items-center gap-1.5 rounded-[var(--shape-control)] border px-3 py-1.5 text-[11px] disabled:opacity-30',
                              colors.panelBg, colors.panelBorder)}>
          <Undo2 size={12} /> Undo
        </button>
        {canFinish && !won && (
          <motion.button
            initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            onClick={() => post('/finish')}
            className={cn('flex items-center gap-1.5 rounded-[var(--shape-control)] border px-4 py-1.5 text-[11px]',
                          colors.panelBg, colors.panelBorder)}
          >
            <Sparkles size={12} /> Finish it
          </motion.button>
        )}
        <button onClick={() => { setDrawCount(game.drawCount); setDealing(true); }}
                className={cn('flex items-center gap-1.5 rounded-[var(--shape-control)] border px-3 py-1.5 text-[11px]',
                              colors.panelBg, colors.panelBorder)}>
          <RotateCcw size={12} /> New
        </button>
        <span className="text-[10px] opacity-40">{game.moves} moves · draw {game.drawCount}</span>
      </div>

      {cascade.length > 0 && (
        <CardCascade order={cascade} onDone={() => setCascade([])} />
      )}
    </div>
  );
}
