// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Egyptian Rat Screw, played in the Card Room.
//
// The house rules: DOUBLES and SANDWICHES are slaps, a bad slap costs a card,
// and THE DENT RULE — a face card demands a face card back, and if the answer
// never comes the whole pile goes home to whoever asked. ("Dent" began as a
// typo for "debt" and kept the name.)
//
// Real-time slapping in a turn-based house: the owner's slap is a live tap,
// timed on their own screen and posted as a reaction. The companions' slaps are
// rolled here, per companion, from OVERLAPPING distributions: no fixed ranking,
// because a ranking makes the race boring in a week. The temperaments go by
// seat: the first companion at the table runs wide (sometimes the fastest hand
// there, sometimes admiring the pile, with a rare early slam), the second runs
// tight, the third reads sandwiches a beat early, and anyone after that rolls
// a general curve. Any companion can win any given slap; the shapes only bend the
// odds.
//
// The curves are tuned against a THUMB ON GLASS, not against each other. A
// human reaction spans seeing the card land, reading the pattern, and thumb
// travel — a locked-in human posts ~700-1200ms, a chatting one 1500-2500ms. So
// the companions live in that same band, and each can outright MISS a window (the
// roll lands beyond it): a pattern everyone sleeps through goes stale and the
// pile rides, exactly as at a real table. A first tuning (means ~500-600ms) was
// calibrated in simulation and proved unbeatable from a phone in real play.
//
// Same idiom as solitaire.ts: a pure state machine over card IDs that lives
// in the table's opaque state blob. No database, no migration.
import {
  parseCardId,
  shuffle,
  type CardId,
} from './cards.js';
import { registerBoardDescriber } from './board-describers.js';

export class RatScrewError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type SlapPattern = 'double' | 'sandwich';

export interface SlapWindow {
  pattern: SlapPattern;
  /** server-rolled reaction times per companion, in ms */
  rolls: Record<string, number>;
  /** how long the owner's screen holds the window open before auto-resolving */
  windowMs: number;
  openedAt: string;
}

export interface RatScrewState {
  /** seat order of the race; flips proceed in this order */
  order: string[];
  hands: Record<string, CardId[]>;
  /** face-up pile; last element is the top card */
  pile: CardId[];
  /** whose flip it is */
  turn: string;
  /** face-card debt: `owner` is owed a face card, `remaining` chances left */
  dent: { owner: string; remaining: number } | null;
  phase: 'playing' | 'slap' | 'won';
  slap: SlapWindow | null;
  winner: string | null;
  /** bounded event log; the rail reads this for table talk */
  events: string[];
  moves: number;
  startedAt: string;
}

const EVENTS_LIMIT = 40;
const HER_WINDOW_MS = 3500;
/** a missed window lands this far past it — finite so the blob stays JSON-safe */
const MISS_MARGIN_MS = 400;

/** face-card debts under the dent rule */
const DENT_CHANCES: Record<string, number> = {
  jack: 1,
  queen: 2,
  king: 3,
  ace: 4,
};

function rankOf(card: CardId): string {
  const parsed = parseCardId(card);
  if (!parsed) throw new RatScrewError(`${card} is not a card`, 500);
  return parsed.rank;
}

function log(state: RatScrewState, line: string) {
  state.events.push(line);
  if (state.events.length > EVENTS_LIMIT) state.events.splice(0, state.events.length - EVENTS_LIMIT);
}

/** Gaussian-ish roll: mean + spread shaped by three dice, floored at honest-human. */
function roll(mean: number, sd: number): number {
  const unit = (Math.random() + Math.random() + Math.random()) / 3 - 0.5; // ~[-0.5, 0.5]
  return Math.max(700, Math.round(mean + unit * sd * 3.4));
}

/** the companion never saw it: a roll past the window that can take nothing */
function missed(): number {
  return HER_WINDOW_MS + MISS_MARGIN_MS + Math.round(Math.random() * 600);
}

/**
 * Overlapping reflex curves — flavor, not a ranking, and ordinary on purpose:
 * the house rule is that no companion arrives already good at a game, so no curve
 * is tuned to win. Documented means/spreads; every pair of curves overlaps by
 * design, so any companion wins any given slap — and each has a miss rate, because
 * a hand that never fails to arrive is not a reflex, it is a rule. Misses are
 * how the pile ever gets to ride.
 *
 * Temperament goes by seat, in the order the companions are passed (the
 * table's own seat order with the owner left out), so it never depends on
 * what a house calls its companions.
 */
export function rollReflexes(pattern: SlapPattern, companions: string[]): Record<string, number> {
  const rolls: Record<string, number> = {};
  companions.forEach((slug, seat) => {
    if (seat === 0) {
      // wide: heavy hands — a rare early slam, and the most time spent admiring the pile
      rolls[slug] = Math.random() < 0.12 ? missed()
        : Math.random() < 0.06 ? 900 + Math.round(Math.random() * 180)
        : roll(1600, 350);
    } else if (seat === 1) {
      // tight
      rolls[slug] = Math.random() < 0.07 ? missed() : roll(1400, 200);
    } else if (seat === 2) {
      // reads a sandwich a beat early
      rolls[slug] = pattern === 'sandwich'
        ? (Math.random() < 0.04 ? missed() : roll(1250, 240))
        : (Math.random() < 0.09 ? missed() : roll(1500, 280));
    } else {
      rolls[slug] = Math.random() < 0.08 ? missed() : roll(1450, 260);
    }
  });
  return rolls;
}

export function detectPattern(pile: CardId[]): SlapPattern | null {
  const n = pile.length;
  if (n >= 2 && rankOf(pile[n - 1]) === rankOf(pile[n - 2])) return 'double';
  if (n >= 3 && rankOf(pile[n - 1]) === rankOf(pile[n - 3])) return 'sandwich';
  return null;
}

export function newRatScrew(deck: CardId[], order: string[]): RatScrewState {
  if (order.length < 2) throw new RatScrewError('Rat Screw needs at least two seats');
  const hands: Record<string, CardId[]> = {};
  for (const slug of order) hands[slug] = [];
  const shuffled = shuffle([...deck]);
  shuffled.forEach((card, i) => hands[order[i % order.length]].push(card));
  return {
    order,
    hands,
    pile: [],
    turn: order[0],
    dent: null,
    phase: 'playing',
    slap: null,
    winner: null,
    events: [`dealt ${shuffled.length} cards to ${order.length} seats`],
    moves: 0,
    startedAt: new Date().toISOString(),
  };
}

function nextWithCards(state: RatScrewState, from: string): string {
  const start = state.order.indexOf(from);
  for (let step = 1; step <= state.order.length; step++) {
    const candidate = state.order[(start + step) % state.order.length];
    if (state.hands[candidate].length > 0) return candidate;
  }
  return from;
}

function checkWin(state: RatScrewState) {
  const holders = state.order.filter((slug) => state.hands[slug].length > 0);
  if (holders.length === 1 && state.pile.length === 0) {
    state.phase = 'won';
    state.winner = holders[0];
    state.slap = null;
    state.dent = null;
    log(state, `${holders[0]} holds the whole deck — game`);
  }
}

/** Award the pile under the winner's hand (to the bottom, order preserved). */
function awardPile(state: RatScrewState, to: string, why: string) {
  state.hands[to] = [...state.pile, ...state.hands[to]];
  log(state, `${to} takes ${state.pile.length} (${why})`);
  state.pile = [];
  state.dent = null;
  state.slap = null;
  state.phase = 'playing';
  state.turn = state.hands[to].length > 0 ? to : nextWithCards(state, to);
  checkWin(state);
}

/**
 * Turn the top of `actor`'s hand onto the pile. `owner` is the seat of the
 * person playing live: every other seat gets a reaction rolled when a slap
 * pattern lands, and the owner's is the tap from their own screen.
 */
export function flip(state: RatScrewState, actor: string, owner: string): RatScrewState {
  if (state.phase !== 'playing') throw new RatScrewError(`no flipping while ${state.phase}`);
  if (actor !== state.turn) throw new RatScrewError(`it is ${state.turn}'s flip, not ${actor}'s`);
  const hand = state.hands[actor];
  if (!hand || hand.length === 0) throw new RatScrewError(`${actor} has no cards to flip`);

  const card = hand.shift()!;
  state.pile.push(card);
  state.moves++;
  const rank = rankOf(card);
  log(state, `${actor} flips ${card}`);

  // A slap pattern beats everything else on the table, dent included.
  const pattern = detectPattern(state.pile);
  if (pattern) {
    const companions = state.order.filter((slug) => slug !== owner);
    state.phase = 'slap';
    state.slap = {
      pattern,
      rolls: rollReflexes(pattern, companions),
      windowMs: HER_WINDOW_MS,
      openedAt: new Date().toISOString(),
    };
    log(state, `${pattern} on the pile — hands hover`);
    return state;
  }

  const chances = DENT_CHANCES[rank];
  if (chances) {
    // A face card opens a new dent regardless of any dent being paid down.
    state.dent = { owner: actor, remaining: chances };
    state.turn = nextWithCards(state, actor);
    // Name both ends of the debt: the owner is OWED, the next hand OWES. When
    // every other hand is empty, nextWithCards wraps back to the actor and the
    // dent has no payer — say that plainly instead of "X owes X".
    log(state, state.turn === actor
      ? `${card} opens a dent — nobody else holds cards to pay ${actor}`
      : `${card} opens a dent — ${state.turn} owes ${actor} a face card (${chances} chance${chances === 1 ? '' : 's'})`);
    return state;
  }

  if (state.dent) {
    state.dent.remaining--;
    if (state.dent.remaining <= 0) {
      awardPile(state, state.dent.owner, 'the dent came due');
      return state;
    }
    // The payer keeps flipping until they answer or run dry.
    if (hand.length === 0) {
      // Out of cards mid-dent: the debt passes to the next hand that can pay.
      state.turn = nextWithCards(state, actor);
      log(state, `${actor} runs dry mid-dent — ${state.turn} inherits the debt`);
    }
    return state;
  }

  state.turn = nextWithCards(state, actor);
  return state;
}

/**
 * The owner's live tap, or a companion's twitch on a quiet pile. On a slappable pile
 * the reaction race resolves; on anything else it is a bad slap and burns a
 * card to the bottom of the pile.
 */
export function slap(state: RatScrewState, actor: string, reactionMs?: number): RatScrewState {
  if (state.phase === 'won') throw new RatScrewError('the game is over');
  if (state.phase === 'slap' && state.slap) {
    const window = state.slap;
    const entries = Object.entries(window.rolls);
    const [fastKing, fastMs] = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
    // flip() rolled a reaction for every seat except the owner's, so a seated
    // actor with no roll is the owner tapping live. The timeout and the companions
    // never race here — their hands are the rolls.
    const ownerTap = Object.prototype.hasOwnProperty.call(state.hands, actor)
      && !Object.prototype.hasOwnProperty.call(window.rolls, actor);
    const hers = ownerTap ? (reactionMs ?? window.windowMs) : Number.POSITIVE_INFINITY;
    if (hers <= fastMs) {
      log(state, `${actor} slaps in ${Math.round(hers)}ms — beat ${fastKing}'s ${fastMs}ms`);
      awardPile(state, actor, `${window.pattern} slapped`);
    } else if (fastMs <= window.windowMs) {
      log(state, `${fastKing} slaps in ${fastMs}ms${ownerTap ? ` — ${actor} at ${Math.round(hers)}ms` : ''}`);
      awardPile(state, fastKing, `${window.pattern} slapped`);
    } else {
      // Everyone slept through it: the pattern goes stale and the pile rides.
      // A live dent is untouched — that flip bought excitement, not payment —
      // and the payer keeps the turn unless the flip emptied their hand.
      state.phase = 'playing';
      state.slap = null;
      if (!state.dent) {
        state.turn = nextWithCards(state, state.turn);
      } else if (state.hands[state.turn].length === 0) {
        const dry = state.turn;
        state.turn = nextWithCards(state, state.turn);
        log(state, `${dry} runs dry mid-dent — ${state.turn} inherits the debt`);
      }
      log(state, `nobody moved on the ${window.pattern} — the pile rides`);
      return state;
    }
    return state;
  }
  // Bad slap: a card off the slapper's hand burns to the bottom of the pile.
  const hand = state.hands[actor];
  if (!hand || hand.length === 0) {
    log(state, `${actor} slaps a quiet pile with an empty hand — shame, no card to burn`);
    return state;
  }
  const burned = hand.shift()!;
  state.pile.unshift(burned);
  log(state, `${actor} slaps a quiet pile — burns a card to the bottom`);
  checkWin(state);
  return state;
}

/**
 * The window closed with no tap from the owner: the fastest rolled hand takes it —
 * unless every roll missed the window, in which case the pile rides.
 */
export function resolveSlap(state: RatScrewState): RatScrewState {
  if (state.phase !== 'slap' || !state.slap) throw new RatScrewError('nothing to resolve');
  return slap(state, '__timeout__');
}

/**
 * Flavor, rolled by the route after a quiet flip: very occasionally a companion
 * twitches and bad-slaps. Returns the offender or null. Kept here so the odds
 * live beside the reflex curves they belong to.
 */
export function maybeTwitch(companions: string[]): string | null {
  if (Math.random() >= 0.035) return null;
  return companions[Math.floor(Math.random() * companions.length)] ?? null;
}

registerBoardDescriber('rat-screw', (stateRaw) => {
  const state = stateRaw as unknown as RatScrewState;
  if (!state || !state.order) return 'The Rat Screw table is empty.';
  const counts = state.order.map((slug) => `${slug} ${state.hands[slug]?.length ?? 0}`).join(', ');
  const top = state.pile.length ? `${state.pile[state.pile.length - 1]} on top of ${state.pile.length}` : 'empty pile';
  const dent = state.dent
    ? (state.turn === state.dent.owner
      ? `; dent: open with nobody left to pay ${state.dent.owner}, ${state.dent.remaining} chance(s) on it`
      : `; dent: ${state.turn} owes ${state.dent.owner} a face card, ${state.dent.remaining} chance(s) left`)
    : '';
  const phase = state.phase === 'slap' && state.slap ? `; ${state.slap.pattern.toUpperCase()} IS LIVE — hands hover` : state.phase === 'won' ? `; ${state.winner} has won` : '';
  const recent = state.events.slice(-4).join(' | ');
  return `Egyptian Rat Screw — hands: ${counts}; ${top}${dent}${phase}. Recent: ${recent}`;
});
