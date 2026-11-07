// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Spades — the first game in this room with partners.
//
// Bid how many tricks you will take, then take them. Spades are always trump,
// so the two of spades beats the ace of anything. Follow suit if you can.
// Spades cannot be LED until one has been thrown.
//
// Make your bid: ten a trick, plus one for each extra — and those extras are
// BAGS, which look free and cost a hundred once you have ten. Miss it and you
// lose ten a trick for every trick you promised. Bid nil, take none, and it is
// worth a hundred; take one and it costs a hundred.
//
// The owner picks a partner before the deal, because the whole point of the game is
// who is sitting across from you.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../bytelight';
import { useHouseRoster } from '../../lib/house';
import { SeatPending } from './SeatPending';
import { defaultPartner, partnerChoices } from '../../lib/partners';
import { cn } from '../../lib/utils';
import type { ThemeConfig } from '../../lib/theme';

type CardId = string;

interface SpadesTeam { players: [string, string]; score: number; bags: number }

interface SpadesGame {
  order: string[];
  teams: [SpadesTeam, SpadesTeam];
  hands: Record<string, CardId[]>;
  bids: Record<string, number | null>;
  trick: Array<{ slug: string; card: CardId }>;
  trickNumber: number;
  led: string | null;
  turn: string;
  spadesBroken: boolean;
  tricks: Record<string, number>;
  handNumber: number;
  phase: 'bidding' | 'playing' | 'handOver' | 'done';
  events: string[];
  moves: number;
}

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king', 'ace'];
const artUrl = (card: CardId) => `/api/games/cards/art/${card}`;
const suitOf = (c: CardId) => c.slice(0, c.indexOf('-'));
const rankValue = (c: CardId) => RANKS.indexOf(c.slice(c.indexOf('-') + 1));

function legalFor(game: SpadesGame, hand: CardId[]): CardId[] {
  if (!hand.length) return [];
  if (game.trick.length === 0) {
    if (game.spadesBroken) return [...hand];
    const notSpades = hand.filter((c) => suitOf(c) !== 'spades');
    return notSpades.length ? notSpades : [...hand];
  }
  const following = hand.filter((c) => suitOf(c) === game.led);
  return following.length ? following : [...hand];
}

interface SpadesBoardProps {
  tableId: string | null;
  colors: ThemeConfig['light'];
  onTableId: (id: string) => void;
}

export function SpadesBoard({ tableId, colors, onTableId }: SpadesBoardProps) {
  const { companions, owner, loaded: rosterLoaded, labelOf, sigilOf } = useHouseRoster();
  // The owner's seat is the house's answer (GET /api/companions), never a
  // name in the code.
  const ownerSeat = owner?.slug ?? '';
  const [game, setGame] = useState<SpadesGame | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The owner's partner is one of this house's companions; until they pick, the first.
  const [pickedPartner, setPartner] = useState<string | null>(null);
  const partner = pickedPartner ?? defaultPartner(companions);
  const tableRef = useRef<string | null>(tableId);
  const inFlight = useRef(false);

  const act = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/games/cards/spades/${path}`, {
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
      setGame(parsed.game as SpadesGame);
      return parsed.game as SpadesGame;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [onTableId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!tableId) return;
      const res = await apiFetch(`/api/games/cards?id=${encodeURIComponent(tableId)}`);
      const body = await res.json().catch(() => null);
      if (cancelled || !body?.table || body.table.game !== 'spades') return;
      tableRef.current = body.table.id;
      if (body.table.state) setGame(body.table.state as SpadesGame);
    })();
    return () => { cancelled = true; };
  }, [tableId]);

  if (!game) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[12px] opacity-70">
          Bid how many tricks you will take, then take them. Spades are always
          trump. Extras are bags, and ten bags costs a hundred. First to five
          hundred wins.
        </p>
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-[.2em] opacity-50">your partner</span>
          <div className="flex gap-1.5">
            {partnerChoices(companions).map((slug) => (
              <button
                key={slug}
                onClick={() => setPartner(slug)}
                className={cn('rounded-xl border px-3 py-1.5 text-[11px] transition active:scale-95', colors.panelBorder)}
                style={partner === slug ? { backgroundColor: 'var(--bytelight-surface-strong)', color: colors.accent } : undefined}
              >
                {sigilOf(slug)} {labelOf(slug) || slug}
              </button>
            ))}
          </div>
        </div>
        <button
          disabled={busy}
          onClick={() => act('new', { partner })}
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
  const myBid = game.bids[ownerSeat];
  const biddingNow = game.phase === 'bidding' && game.turn === ownerSeat;
  const myTurn = game.phase === 'playing' && game.turn === ownerSeat;
  const legal = myTurn ? legalFor(game, mine) : [];
  const myTeam = game.teams.find((t) => t.players.includes(ownerSeat)) as SpadesTeam;
  const theirTeam = game.teams.find((t) => !t.players.includes(ownerSeat)) as SpadesTeam;
  const contractOf = (t: SpadesTeam) => t.players.reduce((sum, p) => sum + ((game.bids[p] ?? 0) || 0), 0);
  const takenBy = (t: SpadesTeam) => t.players.reduce((sum, p) => sum + (game.tricks[p] ?? 0), 0);

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3 scrollbar-hide">
      {error && <div className="text-[11px] opacity-60">{error}</div>}

      {/* the two teams, their contracts and their bags */}
      <div className="flex items-start justify-around">
        {[myTeam, theirTeam].map((t, i) => (
          <div key={i} className="flex flex-col items-center">
            <span className="text-[10px] font-semibold tracking-wide">
              {t.players.map((p) => (p === ownerSeat ? 'you' : labelOf(p) || p)).join(' & ')}
            </span>
            <span className="text-[15px] font-semibold" style={{ color: colors.accent }}>{t.score}</span>
            <span className="text-[9px] opacity-60">
              {takenBy(t)}/{contractOf(t)} · {t.bags} bag{t.bags === 1 ? '' : 's'}
            </span>
          </div>
        ))}
      </div>

      {/* everyone's bid, so the table is readable at a glance */}
      <div className="flex items-center justify-around text-[9px] opacity-65">
        {game.order.map((slug) => (
          <span key={slug} className={game.turn === slug ? 'font-semibold opacity-100' : undefined}>
            {slug === ownerSeat ? 'you' : labelOf(slug) || slug}{' '}
            {game.bids[slug] === null ? '—' : game.bids[slug] === 0 ? 'NIL' : game.bids[slug]}
            {game.phase === 'playing' ? ` (${game.tricks[slug]})` : ''}
          </span>
        ))}
      </div>

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
              {game.phase === 'bidding' ? 'bidding' : 'nothing on the table'}
            </span>}
      </div>

      <div className="text-center text-[11px] opacity-70">
        {game.phase === 'done'
          ? 'Game over — first to five hundred.'
          : game.phase === 'handOver'
            ? 'Hand over. Deal again to carry the score on.'
            : biddingNow
              ? 'How many will you take?'
              : game.phase === 'bidding'
                ? `${labelOf(game.turn) || game.turn} is bidding…`
                : !myTurn
                  ? `${labelOf(game.turn) || game.turn} is thinking…`
                  : game.spadesBroken ? 'Your turn — spades are broken.' : 'Your turn — spades not broken yet.'}
      </div>

      {biddingNow && (
        <div className="flex flex-wrap justify-center gap-1">
          {Array.from({ length: 14 }, (_, n) => (
            <button
              key={n}
              disabled={busy}
              onClick={() => act('bid', { bid: n })}
              className={cn('rounded-lg border px-2.5 py-1 text-[11px] transition active:scale-95', colors.panelBorder)}
              style={n === 0 ? { color: colors.accent } : undefined}
            >
              {n === 0 ? 'NIL' : n}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end justify-center gap-1 pb-1">
        {mine.map((card) => {
          const ok = myTurn && legal.includes(card);
          return (
            <button
              key={card}
              disabled={!ok || busy}
              onClick={() => act('play', { card })}
              className={cn('transition active:scale-95', ok ? '' : 'opacity-30')}
            >
              <img src={artUrl(card)} alt="" draggable={false}
                   className={cn('h-[78px] w-[51px] select-none rounded-[5px] shadow-[0_4px_12px_rgba(0,0,0,.35)]',
                                 ok ? 'ring-1 ring-current' : '')} />
            </button>
          );
        })}
      </div>

      {game.events.length > 0 && (
        <div className="text-center text-[10px] opacity-45">{game.events.at(-1)}</div>
      )}

      <div className="flex justify-center pb-1">
        <button disabled={busy} onClick={() => act('new', { partner })}
                className={cn('rounded-xl border px-4 py-1.5 text-[11px] transition active:scale-95', colors.panelBorder)}>
          {game.phase === 'handOver' || game.phase === 'done' ? 'Next hand' : 'New hand'}
        </button>
      </div>
      {myBid === 0 && game.phase === 'playing' && (
        <div className="text-center text-[10px]" style={{ color: colors.accent }}>
          you bid nil — take nothing at all
        </div>
      )}
    </div>
  );
}
