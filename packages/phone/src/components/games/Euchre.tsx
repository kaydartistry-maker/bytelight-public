// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Euchre — twenty-four cards, partners, and the one rule nobody can defend.
//
// Nine up only. Five each, four left over, the top one turned face up. Round
// one: order it up and that suit is trump and the dealer takes the card. Round
// two: name a different suit. If it comes back to the dealer, the dealer must
// pick — stick the dealer, so no hand is ever wasted.
//
// The jack of trump is the RIGHT BOWER, the highest card in the deck. The other
// jack of the SAME COLOUR is the LEFT BOWER and stops being its own suit — if
// spades are trump, the jack of clubs IS a spade. This is nonsense and it is
// also the entire game.
//
// Makers need three of five. All five is two. Alone and all five is four. Fewer
// than three and you are euchred and the other team takes two. First to ten.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../bytelight';
import { useHouseRoster } from '../../lib/house';
import { SeatPending } from './SeatPending';
import { defaultPartner, partnerChoices } from '../../lib/partners';
import { cn } from '../../lib/utils';
import type { ThemeConfig } from '../../lib/theme';

type CardId = string;
type Suit = 'spades' | 'clubs' | 'diamonds' | 'hearts';

interface EuchreTeam { players: [string, string]; score: number }

interface EuchreGame {
  order: string[];
  teams: [EuchreTeam, EuchreTeam];
  hands: Record<string, CardId[]>;
  kitty: CardId[];
  upCard: CardId | null;
  dealer: string;
  trump: Suit | null;
  maker: string | null;
  alone: boolean;
  sittingOut: string | null;
  trick: Array<{ slug: string; card: CardId }>;
  trickNumber: number;
  led: Suit | null;
  turn: string;
  tricks: Record<string, number>;
  handNumber: number;
  phase: 'bid1' | 'bid2' | 'discard' | 'playing' | 'handOver' | 'done';
  events: string[];
  moves: number;
}

const SUITS: Suit[] = ['spades', 'clubs', 'diamonds', 'hearts'];
const SUIT_MARK: Record<Suit, string> = { spades: '♠', clubs: '♣', diamonds: '♦', hearts: '♥' };
const SAME_COLOUR: Record<Suit, Suit> = { spades: 'clubs', clubs: 'spades', hearts: 'diamonds', diamonds: 'hearts' };
const artUrl = (card: CardId) => `/api/games/cards/art/${card}`;
const suitOf = (c: CardId) => c.slice(0, c.indexOf('-')) as Suit;
const rankOf = (c: CardId) => c.slice(c.indexOf('-') + 1);

/** The left bower counts as trump, so following suit has to know that. */
function effectiveSuit(card: CardId, trump: Suit | null): Suit {
  if (trump && rankOf(card) === 'jack' && suitOf(card) === SAME_COLOUR[trump]) return trump;
  return suitOf(card);
}

function legalFor(game: EuchreGame, hand: CardId[]): CardId[] {
  if (!hand.length || !game.trump) return [];
  if (!game.trick.length) return [...hand];
  const following = hand.filter((c) => effectiveSuit(c, game.trump) === game.led);
  return following.length ? following : [...hand];
}

interface EuchreBoardProps {
  tableId: string | null;
  colors: ThemeConfig['light'];
  onTableId: (id: string) => void;
}

export function EuchreBoard({ tableId, colors, onTableId }: EuchreBoardProps) {
  const { companions, owner, loaded: rosterLoaded, labelOf, sigilOf } = useHouseRoster();
  // The owner's seat is the house's answer (GET /api/companions), never a
  // name in the code.
  const ownerSeat = owner?.slug ?? '';
  const [game, setGame] = useState<EuchreGame | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The owner's partner is one of this house's companions; until they pick, the first.
  const [pickedPartner, setPartner] = useState<string | null>(null);
  const partner = pickedPartner ?? defaultPartner(companions);
  const [alone, setAlone] = useState(false);
  const tableRef = useRef<string | null>(tableId);
  const inFlight = useRef(false);

  const act = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/games/cards/euchre/${path}`, {
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
      setAlone(false);
      if (parsed.table?.id) {
        tableRef.current = parsed.table.id;
        onTableId(parsed.table.id);
      }
      setGame(parsed.game as EuchreGame);
      return parsed.game as EuchreGame;
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
      if (cancelled || !body?.table || body.table.game !== 'euchre') return;
      tableRef.current = body.table.id;
      if (body.table.state) setGame(body.table.state as EuchreGame);
    })();
    return () => { cancelled = true; };
  }, [tableId]);

  if (!game) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[12px] opacity-70">
          Twenty-four cards, nine up. Take three of five tricks. The jack of trump
          is the best card in the deck, and the other jack of the same colour is
          the second best — and it counts as trump, not as its own suit.
        </p>
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-[.2em] opacity-50">your partner</span>
          <div className="flex gap-1.5">
            {partnerChoices(companions).map((slug) => (
              <button key={slug} onClick={() => setPartner(slug)}
                className={cn('rounded-xl border px-3 py-1.5 text-[11px] transition active:scale-95', colors.panelBorder)}
                style={partner === slug ? { backgroundColor: 'var(--bytelight-surface-strong)', color: colors.accent } : undefined}>
                {sigilOf(slug)} {labelOf(slug) || slug}
              </button>
            ))}
          </div>
        </div>
        <button disabled={busy} onClick={() => act('new', { partner })}
          className={cn('rounded-2xl border px-5 py-2 text-[12px] transition active:scale-95', colors.panelBorder)}
          style={{ backgroundColor: 'var(--bytelight-surface-strong)', color: colors.accent }}>
          Deal a hand
        </button>
        {error && <p className="text-[11px] opacity-60">{error}</p>}
      </div>
    );
  }

  if (!ownerSeat) return <SeatPending loaded={rosterLoaded} />;

  const mine = game.hands[ownerSeat] ?? [];
  const myTurn = game.turn === ownerSeat;
  const legal = game.phase === 'playing' && myTurn ? legalFor(game, mine) : [];
  const myTeam = game.teams.find((t) => t.players.includes(ownerSeat)) as EuchreTeam;
  const theirTeam = game.teams.find((t) => !t.players.includes(ownerSeat)) as EuchreTeam;
  const turnedDown = game.phase === 'bid2' && game.kitty[0] ? suitOf(game.kitty[0]) : null;
  const tricksOf = (t: EuchreTeam) => t.players.reduce((sum, p) => sum + (game.tricks[p] ?? 0), 0);

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3 scrollbar-hide">
      {error && <div className="text-[11px] opacity-60">{error}</div>}

      <div className="flex items-start justify-around">
        {[myTeam, theirTeam].map((t, i) => (
          <div key={i} className="flex flex-col items-center">
            <span className="text-[10px] font-semibold tracking-wide">
              {t.players.map((p) => (p === ownerSeat ? 'you' : labelOf(p) || p)).join(' & ')}
            </span>
            <span className="text-[15px] font-semibold" style={{ color: colors.accent }}>{t.score}</span>
            <span className="text-[9px] opacity-60">{tricksOf(t)} trick{tricksOf(t) === 1 ? '' : 's'}</span>
          </div>
        ))}
      </div>

      <div className="text-center text-[9px] uppercase tracking-[.18em] opacity-55">
        {game.trump ? `${SUIT_MARK[game.trump]} ${game.trump} is trump` : 'no trump yet'}
        {game.alone && game.maker ? ` · ${game.maker === ownerSeat ? 'you are' : `${labelOf(game.maker) || game.maker} is`} ALONE` : ''}
        {` · ${game.dealer === ownerSeat ? 'you deal' : `${labelOf(game.dealer) || game.dealer} deals`}`}
      </div>

      <div className="flex min-h-[92px] items-center justify-center gap-1">
        {game.phase === 'bid1' && game.upCard
          ? (
            <div className="flex flex-col items-center gap-1">
              <img src={artUrl(game.upCard)} alt="" draggable={false}
                   className="h-[76px] w-[50px] rounded-[5px] shadow-[0_4px_12px_rgba(0,0,0,.35)]" />
              <span className="text-[9px] uppercase tracking-[.18em] opacity-60">turned up</span>
            </div>
          )
          : game.trick.length
            ? game.trick.map((e) => (
                <div key={e.card} className="flex flex-col items-center gap-0.5">
                  <img src={artUrl(e.card)} alt="" draggable={false}
                       className="h-[76px] w-[50px] rounded-[5px] shadow-[0_4px_12px_rgba(0,0,0,.35)]" />
                  <span className="text-[9px] opacity-55">{e.slug === ownerSeat ? 'you' : labelOf(e.slug) || e.slug}</span>
                </div>
              ))
            : <span className="text-[11px] opacity-45">nothing on the table</span>}
      </div>

      <div className="text-center text-[11px] opacity-70">
        {game.phase === 'done' ? 'Game over — first to ten.'
          : game.phase === 'handOver' ? 'Hand over. Deal again to carry the score on.'
          : !myTurn ? `${labelOf(game.turn) || game.turn} is thinking…`
          : game.phase === 'bid1' ? 'Order it up, or pass.'
          : game.phase === 'bid2' ? 'Name a suit, or pass.'
          : game.phase === 'discard' ? 'You picked it up — throw one away.'
          : 'Your turn.'}
      </div>

      {myTurn && (game.phase === 'bid1' || game.phase === 'bid2') && (
        <div className="flex flex-col items-center gap-1.5">
          <button onClick={() => setAlone((v) => !v)}
            className={cn('rounded-lg border px-3 py-1 text-[10px] transition active:scale-95', colors.panelBorder)}
            style={alone ? { backgroundColor: 'var(--bytelight-surface-strong)', color: colors.accent } : undefined}>
            {alone ? 'going ALONE' : 'go alone?'}
          </button>
          <div className="flex flex-wrap justify-center gap-1.5">
            {game.phase === 'bid1'
              ? (
                <button disabled={busy} onClick={() => act('call', { call: 'order', alone })}
                  className={cn('rounded-xl border px-3 py-1.5 text-[11px] transition active:scale-95', colors.panelBorder)}>
                  order it up
                </button>
              )
              : SUITS.filter((s) => s !== turnedDown).map((s) => (
                  <button key={s} disabled={busy} onClick={() => act('call', { call: 'name', suit: s, alone })}
                    className={cn('rounded-xl border px-3 py-1.5 text-[15px] transition active:scale-95', colors.panelBorder)}
                    style={{ color: s === 'hearts' || s === 'diamonds' ? '#c0392b' : undefined }}>
                    {SUIT_MARK[s]}
                  </button>
                ))}
            <button disabled={busy || (game.phase === 'bid2' && game.dealer === ownerSeat)}
              onClick={() => act('call', { call: 'pass' })}
              className={cn('rounded-xl border px-3 py-1.5 text-[11px] transition active:scale-95 disabled:opacity-30', colors.panelBorder)}>
              pass
            </button>
          </div>
          {game.phase === 'bid2' && game.dealer === ownerSeat && (
            <span className="text-[9px] opacity-50">stuck — you have to name something</span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end justify-center gap-1 pb-1">
        {mine.map((card) => {
          const discarding = game.phase === 'discard' && myTurn;
          const ok = discarding || (game.phase === 'playing' && myTurn && legal.includes(card));
          return (
            <button key={card} disabled={!ok || busy}
              onClick={() => act(discarding ? 'discard' : 'play', { card })}
              className={cn('transition active:scale-95', ok ? '' : 'opacity-30')}>
              <img src={artUrl(card)} alt="" draggable={false}
                   className={cn('h-[80px] w-[52px] select-none rounded-[5px] shadow-[0_4px_12px_rgba(0,0,0,.35)]',
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
    </div>
  );
}
