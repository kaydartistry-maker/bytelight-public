// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Card Room — a deck, on the table.
//
// The art is a plain 52-card deck shipped with the project, cut to one size and
// one paper. This screen is deliberately NOT a game: it is the table the games
// will be designed on, so it does everything a table does (shuffle, deal, turn
// one over, gather up) and decides nothing about how any of that is scored.
import { themeInk } from '../../lib/theme-ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Layers, RotateCcw, Hand, Shuffle, MessagesSquare, Maximize2, Minimize2, MessageCircle } from 'lucide-react';
import { KlondikeBoard } from './Klondike';
import { RatScrewBoard } from './RatScrew';
import { GolfBoard } from './Golf';
import { EightsBoard } from './Eights';
import { PresidentBoard } from './President';
import { HeartsBoard } from './Hearts';
import { SpadesBoard } from './Spades';
import { EuchreBoard } from './Euchre';
import { CardRail } from './CardRail';
import { apiFetch } from '../../bytelight';
import { useHouseRoster, OWNER_SIGIL } from '../../lib/house';
import { cn } from '../../lib/utils';
import { useBackHandler } from '../../lib/use-back-handler';
import type { ThemeConfig } from '../../lib/theme';

type CardId = string;

interface SeatView {
  slug: string;
  hand?: CardId[];
  count: number;
}

interface TableView {
  id: string;
  game: string;
  status: 'open' | 'playing' | 'complete';
  seats: SeatView[];
  pile: CardId[];
  deckRemaining: number;
  updatedAt: string;
}

/** What is on the shelf. Order is the order we agreed to build them in, so an
 *  unbuilt one is a promise on the table rather than a thing hidden until it
 *  exists. */
const GAMES: Array<{ id: string; name: string; blurb: string; ready: boolean }> = [
  { id: 'klondike', name: 'Solitaire', blurb: 'Klondike. Draw one or three, undo as much as you like.', ready: true },
  { id: 'ratscrew', name: 'Rat Screw', blurb: 'Doubles and sandwiches. Slap first, argue after.', ready: true },
  { id: 'golf', name: 'Golf', blurb: 'Lowest score wins. Six cards each, kings are nothing.', ready: true },
  { id: 'eights', name: 'Crazy Eights', blurb: 'Match the suit or the number. Eights are wild.', ready: true },
  { id: 'president', name: 'President', blurb: 'Play higher or pass. The Scum pays the President.', ready: true },
  { id: 'hearts', name: 'Hearts', blurb: 'Take no points. Unless you take all of them.', ready: true },
  { id: 'spades', name: 'Spades', blurb: 'Two teams. Bid what you can make.', ready: true },
  { id: 'euchre', name: 'Euchre', blurb: 'Twenty-four cards, trump, and a partner.', ready: true },
];

/** Thumbnails by default; ?full=1 is the 840px original for a closer look. */
function artUrl(card: CardId, full = false): string {
  return `/api/games/cards/art/${card}${full ? '?full=1' : ''}`;
}

function CardFace({ card, className, style }: { card: CardId; className?: string; style?: React.CSSProperties }) {
  return (
    <img
      src={artUrl(card)}
      alt={card.replace('-', ' of ')}
      draggable={false}
      className={cn('select-none rounded-[6px] shadow-[0_6px_18px_rgba(0,0,0,.35)]', className)}
      style={style}
    />
  );
}

interface CardRoomProps {
  colors: ThemeConfig['light'];
  onExit: () => void;
}

export function CardRoom({ colors }: CardRoomProps) {
  const { companions, owner, labelOf, sigilOf } = useHouseRoster();
  // The room holds more than one game. 'table' is the bare deck — shuffle,
  // deal, turn one over — and is what everything else gets designed on top of.
  const [mode, setMode] = useState<'table' | 'klondike' | 'ratscrew' | 'golf' | 'eights' | 'president' | 'hearts' | 'spades' | 'euchre'>('table');
  // The rail is a drawer rather than a column: a phone is too narrow to give a
  // seven-column board and a conversation the same screen at once.
  const [railOpen, setRailOpen] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);
  const [table, setTable] = useState<TableView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<CardId | null>(null);
  // Back closes a zoomed card, then the rail, before it leaves the room.
  useBackHandler(railOpen, () => { setRailExpanded(false); setRailOpen(false); });
  useBackHandler(zoom !== null, () => setZoom(null));
  const loaded = useRef(false);
  // Reopen onto a live game exactly once per visit. The server keeps the game
  // between visits; this screen used to forget which tab it was on, which
  // read from the owner's side as the game itself vanishing when they left the room.
  const resumed = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/games/cards');
      // An unmounted router answers this address with the SPA's index.html and
      // a 200, so res.ok is not evidence of anything. Check the shape.
      const body = await res.json().catch(() => null);
      if (!body || !('table' in body)) {
        setError('The Card Room needs one byte-light restart to open.');
        return;
      }
      setError(null);
      setTable(body.table);
      if (!resumed.current) {
        resumed.current = true;
        // The table stores 'rat-screw'; this room's tab is 'ratscrew'. Map
        // explicitly — an unknown game name stays on the bare table.
        const tab = body.table.game === 'rat-screw' ? 'ratscrew'
          : body.table.game === 'golf' ? 'golf'
          : body.table.game === 'eights' ? 'eights'
          : body.table.game === 'president' ? 'president'
          : body.table.game === 'hearts' ? 'hearts'
          : body.table.game === 'spades' ? 'spades'
          : body.table.game === 'euchre' ? 'euchre'
          : body.table.game === 'klondike' ? 'klondike'
          : null;
        if (tab && body.table.status === 'playing') setMode(tab);
      }
    } catch {
      setError('Could not reach the table.');
    }
  }, []);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void load();
  }, [load]);

  // The companions play from their own lane, so the table moves without this
  // screen having asked for anything.
  useEffect(() => {
    const onUpdate = () => void load();
    window.addEventListener('bytelight:card-table-update', onUpdate);
    return () => window.removeEventListener('bytelight:card-table-update', onUpdate);
  }, [load]);

  const act = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/games/cards${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tableId: table?.id, ...body }),
      });
      const parsed = await res.json().catch(() => null);
      if (!res.ok || !parsed?.table) {
        setError(parsed?.error ?? 'The table would not move.');
        return;
      }
      setError(null);
      setTable(parsed.table);
    } finally {
      setBusy(false);
    }
  }, [table?.id]);

  // The owner's seat is the house's answer (GET /api/companions), never a name
  // in the code. Until it arrives no chair is drawn as the owner's or as anyone else's.
  const ownerSeat = owner?.slug ?? '';
  const mySeat = ownerSeat ? table?.seats.find((s) => s.slug === ownerSeat) : undefined;
  const myHand = mySeat?.hand ?? [];
  const others = ownerSeat ? (table?.seats ?? []).filter((s) => s.slug !== ownerSeat) : [];
  const topOfPile = table?.pile.at(-1) ?? null;

  // The server can restore the owner to a game that sits off the right-hand end
  // of the strip, so the selected tab is brought into view whenever the mode
  // changes. block:'nearest' on purpose — this must never scroll the page
  // vertically.
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [mode]);

  // The tab row matches every other tab strip in the app: same container
  // (rounded-2xl panel, centred, blurred), same scroller (overflow-x-auto
  // scrollbar-hide), and the same chips, the selected one filled with the
  // accent. Nine tabs is far wider than a phone, and a centred row with no
  // overflow does not clip at one end, it clips at BOTH, so the first games and
  // the last games were equally unreachable. justify-center on the parent with
  // the scroller as a shrinkable child centres when it fits.
  //
  // The gap under the rail is pb-4 on the WRAPPER rather than mb-4 on the panel
  // — the panel's bottom margin would collapse straight through a wrapper with
  // no bottom padding, and the rail was sitting flush against the table.
  const modeSwitch = (
    <div className="px-4 pt-2 pb-4">
      <div className={cn('flex justify-center rounded-2xl border p-3 backdrop-blur-md',
                         colors.panelBg, colors.panelBorder)}>
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
          {([['table', 'The table'], ['klondike', 'Solitaire'], ['ratscrew', 'Rat Screw'], ['golf', 'Golf'], ['eights', 'Eights'], ['president', 'President'], ['hearts', 'Hearts'], ['spades', 'Spades'], ['euchre', 'Euchre']] as const).map(([id, label]) => (
            <button
              key={id}
              ref={mode === id ? activeTabRef : undefined}
              onClick={() => setMode(id)}
              className={cn('shrink-0 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                            colors.panelBorder, mode !== id && colors.panelBg)}
              style={mode === id
                ? { background: 'var(--bytelight-selected-fill, var(--bytelight-accent))', color: 'var(--bytelight-on-accent)', borderColor: colors.accent }
                : undefined}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  // THE FRONT DOOR. The bare table was built as the surface the games would be
  // designed on, and then the games were built on top of it and it stayed with
  // nothing to do. The owner's call: make it the shelf you pick a game off. Everything
  // the table already did — shuffle, deal, turn one over, gather up — stays
  // underneath it, because that is still where the next game gets designed.
  const shelf = (
    <section className="flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-[.2em] opacity-50">Pick a game</div>
      <div className="grid grid-cols-2 gap-2">
        {GAMES.map((g) => (
          <button
            key={g.id}
            type="button"
            disabled={!g.ready}
            onClick={() => g.ready && setMode(g.id as 'klondike' | 'ratscrew' | 'golf' | 'eights' | 'president' | 'hearts' | 'spades' | 'euchre')}
            className={cn('flex flex-col items-start gap-0.5 rounded-2xl border px-3 py-2.5 text-left transition active:scale-[.98]',
                          colors.panelBorder, g.ready ? '' : 'opacity-40')}
            style={g.ready ? { backgroundColor: 'var(--bytelight-surface-strong)' } : undefined}
          >
            <span className="text-[12px] font-semibold">{g.name}</span>
            <span className="text-[10px] leading-snug opacity-60">{g.ready ? g.blurb : 'not built yet'}</span>
          </button>
        ))}
      </div>
    </section>
  );

  // One card behind the whole room, so nothing is ever painted straight onto
  // the wallpaper. The owner's call, and the reason the foundations were invisible.
  const roomSurface = cn('mx-2 mb-2 min-h-0 flex-1 rounded-3xl border shadow-[0_10px_30px_rgba(0,0,0,.3)]',
                         colors.panelBg, colors.panelBorder);

  // The rail belongs to the ROOM, not to one game in it. It only ever hung off
  // the Solitaire branch, so the bare table — the one surface where there is
  // nothing to do but talk — was the one place they could not be spoken to.
  const rail = (
    <>
      {!railOpen && (
        <button
          onClick={() => setRailOpen(true)}
          className={cn('flex items-center justify-center gap-2 border-t py-1.5 text-[10px] uppercase tracking-[.2em] opacity-60',
                        colors.panelBorder)}
        >
          <MessagesSquare size={12} /> talk to them
        </button>
      )}
      {/* The rail owns a fixed area, the way the Fleet Room's does. Sizing it
          off the flex column meant it grew the page instead of scrolling
          inside itself. Expanded, it pops out over the whole screen. */}
      {railOpen && (
        <section
          className={cn(
            'flex flex-col border shadow-[0_24px_70px_rgba(0,0,0,.48)]',
            railExpanded
              ? 'fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] top-[calc(env(safe-area-inset-top)+68px)] z-[100] rounded-[calc(28px*var(--shape-scale,1))]'
              : 'h-[340px] shrink-0 rounded-t-[calc(24px*var(--shape-scale,1))] border-x-0 border-b-0',
            colors.panelBg, colors.panelBorder,
          )}
        >
          <div className={cn('flex items-center justify-between border-b px-3 py-2', colors.panelBorder)}>
            <div className="flex items-center gap-2">
              <MessageCircle size={15} style={{ color: colors.accent }} />
              <span className="text-[13px] font-semibold uppercase tracking-[.14em]">The table talk</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setRailExpanded((v) => !v)}
                className={cn('flex h-9 w-9 items-center justify-center rounded-xl border transition active:scale-95',
                              colors.panelBorder)}
                aria-label={railExpanded ? 'Collapse the table talk' : 'Expand the table talk'}
              >
                {railExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
              <button
                type="button"
                onClick={() => { setRailExpanded(false); setRailOpen(false); }}
                className={cn('flex h-9 w-9 items-center justify-center rounded-xl border transition active:scale-95',
                              colors.panelBorder)}
                aria-label="Hide the table talk"
              >
                <MessagesSquare size={16} />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <CardRail tableId={table?.id ?? null} colors={colors} />
          </div>
        </section>
      )}
    </>
  );

  if (mode === 'klondike') {
    return (
      <div className="flex h-full flex-col">
        {modeSwitch}
        <div className={cn(roomSurface, 'flex flex-col overflow-hidden')}>
          <div className="min-h-0 flex-1 overflow-y-auto p-1 scrollbar-hide">
            <KlondikeBoard tableId={table?.id ?? null} colors={colors}
                           onTableId={(id) => setTable((t) => (t ? { ...t, id } : t))} />
          </div>
          {rail}
        </div>
      </div>
    );
  }

  if (mode === 'euchre') {
    return (
      <div className="flex h-full flex-col">
        {modeSwitch}
        <div className={cn(roomSurface, 'flex flex-col overflow-hidden')}>
          <div className="min-h-0 flex-1 overflow-hidden">
            <EuchreBoard tableId={table?.id ?? null} colors={colors}
                         onTableId={(id) => setTable((t) => (t ? { ...t, id } : t))} />
          </div>
          {rail}
        </div>
      </div>
    );
  }

  if (mode === 'spades') {
    return (
      <div className="flex h-full flex-col">
        {modeSwitch}
        <div className={cn(roomSurface, 'flex flex-col overflow-hidden')}>
          <div className="min-h-0 flex-1 overflow-hidden">
            <SpadesBoard tableId={table?.id ?? null} colors={colors}
                         onTableId={(id) => setTable((t) => (t ? { ...t, id } : t))} />
          </div>
          {rail}
        </div>
      </div>
    );
  }

  if (mode === 'hearts') {
    return (
      <div className="flex h-full flex-col">
        {modeSwitch}
        <div className={cn(roomSurface, 'flex flex-col overflow-hidden')}>
          <div className="min-h-0 flex-1 overflow-hidden">
            <HeartsBoard tableId={table?.id ?? null} colors={colors}
                         onTableId={(id) => setTable((t) => (t ? { ...t, id } : t))} />
          </div>
          {rail}
        </div>
      </div>
    );
  }

  if (mode === 'president') {
    return (
      <div className="flex h-full flex-col">
        {modeSwitch}
        <div className={cn(roomSurface, 'flex flex-col overflow-hidden')}>
          <div className="min-h-0 flex-1 overflow-hidden">
            <PresidentBoard tableId={table?.id ?? null} colors={colors}
                            onTableId={(id) => setTable((t) => (t ? { ...t, id } : t))} />
          </div>
          {rail}
        </div>
      </div>
    );
  }

  if (mode === 'eights') {
    return (
      <div className="flex h-full flex-col">
        {modeSwitch}
        <div className={cn(roomSurface, 'flex flex-col overflow-hidden')}>
          <div className="min-h-0 flex-1 overflow-hidden">
            <EightsBoard tableId={table?.id ?? null} colors={colors}
                         onTableId={(id) => setTable((t) => (t ? { ...t, id } : t))} />
          </div>
          {rail}
        </div>
      </div>
    );
  }

  if (mode === 'golf') {
    return (
      <div className="flex h-full flex-col">
        {modeSwitch}
        <div className={cn(roomSurface, 'flex flex-col overflow-hidden')}>
          <div className="min-h-0 flex-1 overflow-hidden">
            <GolfBoard tableId={table?.id ?? null} colors={colors}
                       onTableId={(id) => setTable((t) => (t ? { ...t, id } : t))} />
          </div>
          {rail}
        </div>
      </div>
    );
  }

  if (mode === 'ratscrew') {
    return (
      <div className="flex h-full flex-col">
        {modeSwitch}
        <div className={cn(roomSurface, 'flex flex-col overflow-hidden')}>
          <div className="min-h-0 flex-1 overflow-hidden">
            <RatScrewBoard tableId={table?.id ?? null} colors={colors}
                           onTableId={(id) => setTable((t) => (t ? { ...t, id } : t))} />
          </div>
          {rail}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col pb-24">
      {modeSwitch}
      {/* The surface holds still and the table scrolls inside it, so the rail
          can sit pinned at the bottom rather than scrolling away with the fan. */}
      <div className={cn(roomSurface, 'flex flex-col overflow-hidden')}>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 scrollbar-hide">
      {error && (
        <div className={cn('rounded-2xl border px-4 py-3 text-xs', colors.panelBg, colors.panelBorder)}>
          {error}
        </div>
      )}

      {shelf}

      {/* the other three seats, backs out */}
      <div className="flex items-start justify-around gap-2">
        {others.map((seat) => {
          const companion = companions.find((c) => c.slug === seat.slug);
          const accent = companion?.color ?? 'var(--bytelight-accent)';
          return (
            <div key={seat.slug} className="flex flex-col items-center gap-1.5">
              <div className="relative h-[76px] w-[74px]">
                {Array.from({ length: Math.min(seat.count, 5) }).map((_, i) => (
                  <img
                    key={i}
                    src={artUrl('back')}
                    alt=""
                    draggable={false}
                    className="absolute left-0 top-0 h-[76px] w-[50px] select-none rounded-[5px] shadow-[0_4px_12px_rgba(0,0,0,.35)]"
                    style={{ transform: `translateX(${i * 6}px) rotate(${(i - 2) * 2.5}deg)` }}
                  />
                ))}
                {seat.count === 0 && (
                  <div className="flex h-[76px] w-[50px] items-center justify-center rounded-[5px] border border-dashed opacity-30"
                       style={{ borderColor: accent }} />
                )}
              </div>
              <div className="text-[10px] font-semibold tracking-wide" style={{ color: companion ? themeInk(companion.slug, companion.color, colors) : accent }}>
                {sigilOf(seat.slug)} {labelOf(seat.slug)}
              </div>
              <div className="text-[10px] opacity-50">{seat.count}</div>
            </div>
          );
        })}
      </div>

      {/* the middle: deck on the left, whatever is face up on the right */}
      <div className={cn('flex items-center justify-center gap-8 rounded-3xl border py-5', colors.panelBg, colors.panelBorder)}>
        <div className="flex flex-col items-center gap-1.5">
          <div className="relative h-[104px] w-[70px]">
            {table && table.deckRemaining > 0 ? (
              Array.from({ length: Math.min(3, table.deckRemaining) }).map((_, i) => (
                <img key={i} src={artUrl('back')} alt="" draggable={false}
                     className="absolute h-[104px] w-[70px] select-none rounded-[6px] shadow-[0_6px_18px_rgba(0,0,0,.35)]"
                     style={{ left: i * 2, top: -i * 2 }} />
              ))
            ) : (
              <div className="h-[104px] w-[70px] rounded-[6px] border border-dashed opacity-30" />
            )}
          </div>
          <div className="text-[10px] uppercase tracking-[.2em] opacity-50">
            {table?.deckRemaining ?? 0} left
          </div>
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <div className="relative h-[104px] w-[70px]">
            <AnimatePresence mode="popLayout">
              {topOfPile ? (
                <motion.div key={topOfPile}
                            initial={{ opacity: 0, y: -14, rotate: -6 }}
                            animate={{ opacity: 1, y: 0, rotate: 0 }}
                            className="absolute">
                  <button onClick={() => setZoom(topOfPile)}>
                    <CardFace card={topOfPile} className="h-[104px] w-[70px]" />
                  </button>
                </motion.div>
              ) : (
                <div className="h-[104px] w-[70px] rounded-[6px] border border-dashed opacity-30" />
              )}
            </AnimatePresence>
          </div>
          <div className="text-[10px] uppercase tracking-[.2em] opacity-50">
            pile {table?.pile.length ?? 0}
          </div>
        </div>
      </div>

      {/* The owner's hand, faces up, fanned. Sized so five cards fit a phone row
          without clipping — the old 88px card overflowed and put a scrollbar
          across the bottom of the fan. Bigger hands still scroll, quietly. */}
      <div className="flex flex-1 items-end justify-center overflow-x-auto pb-2 scrollbar-hide">
        {myHand.length === 0 ? (
          <div className="pb-8 text-xs opacity-40">
            {OWNER_SIGIL} nothing dealt yet
          </div>
        ) : (
          <div className="flex items-end" style={{ paddingLeft: 26 }}>
            {myHand.map((card, i) => (
              <motion.button
                key={card}
                layout
                onClick={() => setZoom(card)}
                className="-ml-[26px] origin-bottom transition-transform hover:-translate-y-3"
                style={{ transform: `rotate(${(i - (myHand.length - 1) / 2) * 3}deg)`, zIndex: i }}
              >
                <CardFace card={card} className="h-[112px] w-[75px]" />
              </motion.button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <button disabled={busy} onClick={() => act('/new')}
                className={cn('flex items-center gap-2 rounded-[var(--shape-control)] border px-4 py-2 text-xs disabled:opacity-40', colors.panelBg, colors.panelBorder)}>
          <Shuffle size={14} /> Fresh deck
        </button>
        <button disabled={busy || !table} onClick={() => act('/deal', { each: 5 })}
                className={cn('flex items-center gap-2 rounded-[var(--shape-control)] border px-4 py-2 text-xs disabled:opacity-40', colors.panelBg, colors.panelBorder)}>
          <Layers size={14} /> Deal 5
        </button>
        <button disabled={busy || !myHand.length} onClick={() => act('/play')}
                className={cn('flex items-center gap-2 rounded-[var(--shape-control)] border px-4 py-2 text-xs disabled:opacity-40', colors.panelBg, colors.panelBorder)}>
          {/* It plays from the owner's HAND, not off the deck — the Rat Screw motion.
              The old label said "turn one over", which reads as a deck flip. */}
          <Hand size={14} /> Play from hand
        </button>
        <button disabled={busy || !table?.pile.length} onClick={() => act('/gather')}
                className={cn('flex items-center gap-2 rounded-[var(--shape-control)] border px-4 py-2 text-xs disabled:opacity-40', colors.panelBg, colors.panelBorder)}>
          <RotateCcw size={14} /> Gather
        </button>
      </div>
      </div>
      {rail}
      </div>

      <AnimatePresence>
        {zoom && (
          <motion.button
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setZoom(null)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
          >
            <motion.img
              layoutId={zoom}
              src={artUrl(zoom, true)}
              alt={zoom.replace('-', ' of ')}
              className="max-h-full max-w-full rounded-xl shadow-[0_24px_80px_rgba(0,0,0,.6)]"
            />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
