// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { Router } from 'express';
import { existsSync } from 'fs';
import { basename, join } from 'path';
import type { AgentService } from '../services/agent.js';
import {
  addCardLog,
  applyMove,
  beginCardRoomResponse,
  finishCardRoomResponse,
  autoFinish,
  canAutoFinish,
  CARDS_DIR,
  PLACEHOLDER_CARDS_DIR,
  CardRoomError,
  dealCards,
  gatherPile,
  getCardLog,
  getMessages,
  getCardTable,
  newCardTable,
  ownerSeat,
  redactGameState,
  defaultGameSeats,
  partnerGameSeats,
  draw as drawStock,
  isWon,
  loadDeck,
  newKlondike,
  playCard,
  setCardGame,
  setCardState,
  SolitaireError,
  undo as undoMove,
  viewCardTable,
  type KlondikeState,
  newRatScrew,
  flip as ratFlip,
  slap as ratSlap,
  resolveSlap as ratResolve,
  maybeTwitch,
  type RatScrewState,
} from '../services/db.js';
import {
  newGolf, draw as golfDraw, place as golfPlace, discardAndFlip as golfDiscardFlip,
  decideGolfMove, decideGolfPlacement, type GolfState,
} from '../services/db/golf.js';
import {
  newEights, play as eightsPlay, drawUntilPlayable as eightsDraw,
  playableFrom, decideEightsMove, type EightsState,
} from '../services/db/eights.js';
import {
  newPresident, play as presidentPlay, pass as presidentPass,
  decidePresidentMove, type PresidentState, type PresidentTitle,
} from '../services/db/president.js';
import {
  newHearts, choosePass as heartsPass, play as heartsPlay,
  decideHeartsPass, decideHeartsPlay, type HeartsState,
} from '../services/db/hearts.js';
import {
  newSpades, bid as spadesBid, play as spadesPlay,
  decideSpadesBid, decideSpadesPlay, type SpadesState,
} from '../services/db/spades.js';
import {
  newEuchre, orderUp as euchreOrderUp, discard as euchreDiscard, nameTrump as euchreName,
  pass as euchrePass, play as euchrePlay, decideEuchreCall, decideEuchrePlay,
  decideEuchreDiscard, type EuchreState,
} from '../services/db/euchre.js';
// byte-light's registry (services/db/rooms.ts): the row id IS the slug.
import { listCompanions } from '../services/db/rooms.js';
import { registry } from '../services/ws.js';

const router = Router();

// Every move answers with the running game beside the table, and that blob
// holds every seat's hand. The table view is redacted at its source; the game
// rides out through here so no route can forget it.
router.use((_req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body?: unknown) => {
    if (body && typeof body === 'object' && 'game' in body) {
      const b = body as Record<string, unknown>;
      return json({ ...b, game: redactGameState(b.game, ownerSeat()) });
    }
    return json(body);
  };
  next();
});

function sendError(res: import('express').Response, error: unknown): void {
  if (error instanceof CardRoomError || error instanceof SolitaireError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error('[CardRoom]', error);
  res.status(500).json({ error: 'The table went over' });
}

/**
 * The card art. Nothing else in the house serves data/cards, and it cannot go
 * through /api/files/:id — that route resolves a UUID against a DB row and
 * these are fifty-three files on disk with names instead. It cannot go in the
 * phone's public/ either: 65 MB would land in the git tree and inside the APK.
 *
 * So: a name-gated sendFile, sitting under /api so it inherits the session gate
 * and needs no change to the Vite dev proxy. Thumbnails by default because a
 * card on screen is about 200px wide and the originals are 840 — ?full=1 asks
 * for the real one, which is what a lightbox wants.
 */
router.get('/art/:card', (req, res) => {
  const name = basename(req.params.card).replace(/[^a-z0-9-]/gi, '');
  if (!name) {
    res.status(404).json({ error: 'No such card' });
    return;
  }
  const full = req.query.full === '1';
  const path = full
    ? join(CARDS_DIR, `${name}.png`)
    : join(CARDS_DIR, 'thumbs', `${name}.webp`);
  // A missing thumbnail falls back to the original rather than 404ing, so the
  // table still draws if the thumbnail pass has not been run for a new card —
  // and a tree with no data/cards at all falls back to the plain deck that
  // ships with the code, which is the only reason the room works in a fresh
  // clone. The house's own deck is always tried first.
  const candidates = [path, join(CARDS_DIR, `${name}.png`), join(PLACEHOLDER_CARDS_DIR, `${name}.png`)];
  const served = candidates.find(existsSync);
  if (!served) {
    res.status(404).json({ error: 'No such card' });
    return;
  }
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(served);
});

router.get('/', (req, res) => {
  try {
    const table = getCardTable(typeof req.query.id === 'string' ? req.query.id : undefined);
    if (!table) {
      res.json({ table: null });
      return;
    }
    // Whether the board is decided travels WITH the board. This answered with
    // the table alone, so a screen walking in cold could not tell a finishable
    // game from an unfinishable one.
    const game = table.game === 'klondike' ? (table.state as unknown as KlondikeState) : null;
    res.json({
      table: viewCardTable(table, ownerSeat()),
      ...(game ? { canAutoFinish: canAutoFinish(game), won: isWon(game) } : {}),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/new', (req, res) => {
  try {
    const game = typeof req.body?.game === 'string' ? req.body.game : 'freeplay';
    const table = newCardTable(game);
    registry.broadcast({ type: 'card_table_update', tableId: table.id });
    res.status(201).json({ table: viewCardTable(table, ownerSeat()) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/deal', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const each = Number(req.body?.each ?? 5);
    if (!Number.isInteger(each) || each < 1 || each > 13) {
      throw new CardRoomError('Deal between 1 and 13 cards a seat');
    }
    const table = dealCards(tableId, each);
    registry.broadcast({ type: 'card_table_update', tableId: table.id });
    res.json({ table: viewCardTable(table, ownerSeat()) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/play', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const table = playCard(tableId, ownerSeat());
    registry.broadcast({ type: 'card_table_update', tableId: table.id });
    res.json({ table: viewCardTable(table, ownerSeat()) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/gather', (req, res) => {
  try {
    const table = gatherPile(String(req.body?.tableId ?? ''));
    registry.broadcast({ type: 'card_table_update', tableId: table.id });
    res.json({ table: viewCardTable(table, ownerSeat()) });
  } catch (error) {
    sendError(res, error);
  }
});

// ------------------------------------------------------------- solitaire
//
// Klondike lives in the table's state blob, so none of this needed a schema.
// Every endpoint reads the board, applies one pure transition and writes it
// back — the rules are in services/db/solitaire.ts and are tested there, away
// from anything that could hide a wrong answer behind a nice animation.

function board(tableId: string): { table: ReturnType<typeof getCardTable>; game: KlondikeState } {
  const table = getCardTable(tableId);
  if (!table) throw new CardRoomError('No such table', 404);
  if (table.game !== 'klondike') throw new CardRoomError('No game of Klondike on this table', 409);
  return { table, game: table.state as unknown as KlondikeState };
}

function afterMove(res: import('express').Response, tableId: string, game: KlondikeState,
                   extra: Record<string, unknown> = {}): void {
  const table = setCardState(tableId, game as unknown as Record<string, unknown>);
  registry.broadcast({ type: 'card_table_update', tableId });
  res.json({
    table: viewCardTable(table, ownerSeat()),
    game,
    canAutoFinish: canAutoFinish(game),
    won: isWon(game),
    ...extra,
  });
}

router.post('/solitaire/new', (req, res) => {
  try {
    const drawCount = req.body?.drawCount === 3 ? 3 : 1;
    const tableId = String(req.body?.tableId ?? (newCardTable('klondike')).id);
    const game = newKlondike(loadDeck(), drawCount, new Date().toISOString());
    const table = setCardGame(tableId, 'klondike', game as unknown as Record<string, unknown>);
    addCardLog(tableId, 'system', 'house', `New Klondike, draw ${drawCount}.`);
    registry.broadcast({ type: 'card_table_update', tableId });
    res.status(201).json({
      table: viewCardTable(table, ownerSeat()), game, canAutoFinish: false, won: false,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/solitaire/draw', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const { game } = board(tableId);
    afterMove(res, tableId, drawStock(game));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/solitaire/move', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const { game } = board(tableId);
    afterMove(res, tableId, applyMove(game, req.body?.move ?? {}));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/solitaire/undo', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const { game } = board(tableId);
    afterMove(res, tableId, undoMove(game));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/solitaire/finish', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const { game } = board(tableId);
    // The order comes back so the phone can fly them home one at a time rather
    // than snapping the board to solved — the walk is the reward.
    const { state, order } = autoFinish(game);
    afterMove(res, tableId, state, { order });
  } catch (error) {
    sendError(res, error);
  }
});

// ------------------------------------------------------- egyptian rat screw
//
// The house spec: doubles and sandwiches slap, bad slaps burn a card, and
// the dent rule. The rules live in services/db/rat-screw.ts and are tested
// there; these routes only move state. The owner's slap arrives with a client-timed
// reactionMs; the companions' reflexes were rolled the moment the pattern hit.

function ratBoard(tableId: string): { game: RatScrewState } {
  const table = getCardTable(tableId);
  if (!table) throw new CardRoomError('No such table', 404);
  if (table.game !== 'rat-screw') throw new CardRoomError('No Rat Screw on this table', 409);
  return { game: table.state as unknown as RatScrewState };
}

function afterRatMove(res: import('express').Response, tableId: string, game: RatScrewState,
                      extra: Record<string, unknown> = {}): void {
  const table = setCardState(tableId, game as unknown as Record<string, unknown>);
  registry.broadcast({ type: 'card_table_update', tableId });
  res.json({ table: viewCardTable(table, ownerSeat()), game, ...extra });
}

router.post('/rat-screw/new', (req, res) => {
  try {
    const order: string[] = Array.isArray(req.body?.order) && req.body.order.length >= 2
      ? req.body.order.map(String)
      : defaultGameSeats();
    const tableId = String(req.body?.tableId ?? (newCardTable('rat-screw')).id);
    const game = newRatScrew(loadDeck(), order);
    const table = setCardGame(tableId, 'rat-screw', game as unknown as Record<string, unknown>);
    addCardLog(tableId, 'system', 'house', `New Egyptian Rat Screw — ${order.join(', ')}. The dent rule is in effect.`);
    registry.broadcast({ type: 'card_table_update', tableId });
    res.status(201).json({ table: viewCardTable(table, ownerSeat()), game });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/rat-screw/flip', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const actor = String(req.body?.actor ?? '');
    const { game } = ratBoard(tableId);
    let next = ratFlip(game, actor, ownerSeat());
    // Flavor: on a quiet pile a companion very occasionally twitches and burns one.
    let twitch: string | null = null;
    if (next.phase === 'playing') {
      twitch = maybeTwitch(next.order.filter((s) => s !== ownerSeat() && s !== actor));
      if (twitch) next = ratSlap(next, twitch);
    }
    afterRatMove(res, tableId, next, { twitch });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/rat-screw/slap', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const reactionMs = Number.isFinite(req.body?.reactionMs) ? Number(req.body.reactionMs) : undefined;
    const { game } = ratBoard(tableId);
    afterRatMove(res, tableId, ratSlap(game, ownerSeat(), reactionMs));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/rat-screw/resolve', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const { game } = ratBoard(tableId);
    if (game.phase !== 'slap') {
      // The window can race the owner's tap; a stale resolve is a no-op, not an error.
      afterRatMove(res, tableId, game);
      return;
    }
    afterRatMove(res, tableId, ratResolve(game));
  } catch (error) {
    sendError(res, error);
  }
});







// -------------------------------------------------------------------- euchre
//
// Twenty-four cards, trump, and the jack of the same colour becoming the second
// highest card in the deck. Stick the dealer, so no hand is ever wasted. Rules
// live in services/db/euchre.ts and are tested there.

function euchreBoard(tableId: string): { game: EuchreState } {
  const table = getCardTable(tableId);
  if (!table) throw new CardRoomError('No such table', 404);
  if (table.game !== 'euchre') throw new CardRoomError('No Euchre on this table', 409);
  return { game: table.state as unknown as EuchreState };
}

function runEuchreKings(game: EuchreState): EuchreState {
  let next = game;
  let guard = 0;
  while (guard < 120) {
    guard += 1;
    if (next.phase === 'discard' && next.dealer !== ownerSeat()) {
      next = euchreDiscard(next, next.dealer, decideEuchreDiscard(next));
      continue;
    }
    if ((next.phase === 'bid1' || next.phase === 'bid2') && next.turn && next.turn !== ownerSeat()) {
      const call = decideEuchreCall(next, next.turn);
      if (call.call === 'order') next = euchreOrderUp(next, next.turn, false);
      else if (call.call === 'name') next = euchreName(next, next.turn, call.suit, false);
      else next = euchrePass(next, next.turn);
      continue;
    }
    if (next.phase === 'playing' && next.turn && next.turn !== ownerSeat()) {
      next = euchrePlay(next, next.turn, decideEuchrePlay(next, next.turn));
      continue;
    }
    break;
  }
  return next;
}

function afterEuchreMove(res: import('express').Response, tableId: string, game: EuchreState): void {
  const finished = runEuchreKings(game);
  const table = setCardState(tableId, finished as unknown as Record<string, unknown>);
  registry.broadcast({ type: 'card_table_update', tableId });
  res.json({ table: viewCardTable(table, ownerSeat()), game: finished });
}

router.post('/euchre/new', (req, res) => {
  try {
    const order: string[] = Array.isArray(req.body?.order) && req.body.order.length === 4
      ? req.body.order.map(String)
      : partnerGameSeats(req.body?.partner);
    const tableId = String(req.body?.tableId ?? (newCardTable('euchre')).id);
    const existing = getCardTable(tableId);
    const prior = existing?.game === 'euchre' ? (existing.state as unknown as EuchreState) : null;
    const carry = prior && prior.order.join() === order.join() ? prior.teams : null;
    const game = newEuchre(loadDeck(), order, carry, (carry ? prior!.handNumber : -1) + 1);
    const table = setCardGame(tableId, 'euchre', game as unknown as Record<string, unknown>);
    addCardLog(tableId, 'system', 'house', `New hand of Euchre — ${game.teams[0].players.join(' & ')} against ${game.teams[1].players.join(' & ')}. ${game.upCard?.replace('-', ' of ')} is turned up.`);
    registry.broadcast({ type: 'card_table_update', tableId });
    const opened = runEuchreKings(game);
    const settled = setCardState(tableId, opened as unknown as Record<string, unknown>);
    res.status(201).json({ table: viewCardTable(settled, ownerSeat()), game: opened });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/euchre/call', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const alone = req.body?.alone === true;
    const { game } = euchreBoard(tableId);
    const what = String(req.body?.call ?? 'pass');
    let next: EuchreState;
    if (what === 'order') next = euchreOrderUp(game, ownerSeat(), alone);
    else if (what === 'name') next = euchreName(game, ownerSeat(), String(req.body?.suit) as never, alone);
    else next = euchrePass(game, ownerSeat());
    afterEuchreMove(res, tableId, next);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/euchre/discard', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const card = String(req.body?.card ?? '');
    const { game } = euchreBoard(tableId);
    afterEuchreMove(res, tableId, euchreDiscard(game, ownerSeat(), card));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/euchre/play', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const card = String(req.body?.card ?? '');
    const { game } = euchreBoard(tableId);
    afterEuchreMove(res, tableId, euchrePlay(game, ownerSeat(), card));
  } catch (error) {
    sendError(res, error);
  }
});

// -------------------------------------------------------------------- spades
//
// The first game in this room with partners. Bid what you will take, then take
// it; spades are always trump; bags look free and cost a hundred at ten. Rules
// live in services/db/spades.ts and are tested there. Scores carry across hands
// on the same table, so dealing again continues the game.

function spadesBoard(tableId: string): { game: SpadesState } {
  const table = getCardTable(tableId);
  if (!table) throw new CardRoomError('No such table', 404);
  if (table.game !== 'spades') throw new CardRoomError('No Spades on this table', 409);
  return { game: table.state as unknown as SpadesState };
}

function runSpadesKings(game: SpadesState): SpadesState {
  let next = game;
  let guard = 0;
  while (next.phase === 'bidding' && next.turn && next.turn !== ownerSeat() && guard < 20) {
    guard += 1;
    next = spadesBid(next, next.turn, decideSpadesBid(next, next.turn));
  }
  while (next.phase === 'playing' && next.turn && next.turn !== ownerSeat() && guard < 120) {
    guard += 1;
    next = spadesPlay(next, next.turn, decideSpadesPlay(next, next.turn));
  }
  return next;
}

function afterSpadesMove(res: import('express').Response, tableId: string, game: SpadesState): void {
  const finished = runSpadesKings(game);
  const table = setCardState(tableId, finished as unknown as Record<string, unknown>);
  registry.broadcast({ type: 'card_table_update', tableId });
  res.json({ table: viewCardTable(table, ownerSeat()), game: finished });
}

router.post('/spades/new', (req, res) => {
  try {
    // The owner's partner sits across from them, so naming one arranges the seats.
    const order: string[] = Array.isArray(req.body?.order) && req.body.order.length === 4
      ? req.body.order.map(String)
      : partnerGameSeats(req.body?.partner);
    const tableId = String(req.body?.tableId ?? (newCardTable('spades')).id);
    const existing = getCardTable(tableId);
    const prior = existing?.game === 'spades' ? (existing.state as unknown as SpadesState) : null;
    // Changing partners starts the score over; it is a different game.
    const carry = prior && prior.order.join() === order.join() ? prior.teams : null;
    const game = newSpades(loadDeck(), order, carry, (carry ? prior!.handNumber : -1) + 1);
    const table = setCardGame(tableId, 'spades', game as unknown as Record<string, unknown>);
    addCardLog(tableId, 'system', 'house', `New hand of Spades — ${game.teams[0].players.join(' & ')} against ${game.teams[1].players.join(' & ')}. Bid what you will take.`);
    registry.broadcast({ type: 'card_table_update', tableId });
    const opened = runSpadesKings(game);
    const settled = setCardState(tableId, opened as unknown as Record<string, unknown>);
    res.status(201).json({ table: viewCardTable(settled, ownerSeat()), game: opened });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/spades/bid', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const n = Number(req.body?.bid);
    const { game } = spadesBoard(tableId);
    afterSpadesMove(res, tableId, spadesBid(game, ownerSeat(), n));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/spades/play', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const card = String(req.body?.card ?? '');
    const { game } = spadesBoard(tableId);
    afterSpadesMove(res, tableId, spadesPlay(game, ownerSeat(), card));
  } catch (error) {
    sendError(res, error);
  }
});

// -------------------------------------------------------------------- hearts
//
// Follow suit, take no points, and the queen of spades costs thirteen — unless
// somebody takes all twenty-six, which turns the whole thing around. Rules live
// in services/db/hearts.ts and are tested there. Totals run across every hand
// played on this table, so a new hand is a new deal and not a new game.

function heartsBoard(tableId: string): { game: HeartsState } {
  const table = getCardTable(tableId);
  if (!table) throw new CardRoomError('No such table', 404);
  if (table.game !== 'hearts') throw new CardRoomError('No Hearts on this table', 409);
  return { game: table.state as unknown as HeartsState };
}

/** The companions choose their three, and then play until it is the owner's turn again. */
function runHeartsKings(game: HeartsState): HeartsState {
  let next = game;
  let guard = 0;
  if (next.phase === 'passing') {
    for (const slug of next.order) {
      if (slug === ownerSeat() || next.passing[slug]) continue;
      next = heartsPass(next, slug, decideHeartsPass(next, slug));
    }
  }
  while (next.phase === 'playing' && next.turn && next.turn !== ownerSeat() && guard < 60) {
    guard += 1;
    const actor = next.turn;
    next = heartsPlay(next, actor, decideHeartsPlay(next, actor));
  }
  return next;
}

function afterHeartsMove(res: import('express').Response, tableId: string, game: HeartsState): void {
  const finished = runHeartsKings(game);
  const table = setCardState(tableId, finished as unknown as Record<string, unknown>);
  registry.broadcast({ type: 'card_table_update', tableId });
  res.json({ table: viewCardTable(table, ownerSeat()), game: finished });
}

router.post('/hearts/new', (req, res) => {
  try {
    const order: string[] = Array.isArray(req.body?.order) && req.body.order.length === 4
      ? req.body.order.map(String)
      : defaultGameSeats(4);
    const tableId = String(req.body?.tableId ?? (newCardTable('hearts')).id);
    // A table mid-game keeps its running totals and moves the pass along.
    const existing = getCardTable(tableId);
    const prior = existing?.game === 'hearts' ? (existing.state as unknown as HeartsState) : null;
    const game = newHearts(loadDeck(), order, prior?.totals ?? null, (prior?.handNumber ?? -1) + 1);
    const table = setCardGame(tableId, 'hearts', game as unknown as Record<string, unknown>);
    addCardLog(tableId, 'system', 'house', `New hand of Hearts — ${order.join(', ')}. ${game.direction === 'hold' ? 'Nobody passes this hand.' : `Passing ${game.direction}.`} Queen of spades is thirteen.`);
    registry.broadcast({ type: 'card_table_update', tableId });
    const opened = runHeartsKings(game);
    const settled = setCardState(tableId, opened as unknown as Record<string, unknown>);
    res.status(201).json({ table: viewCardTable(settled, ownerSeat()), game: opened });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/hearts/pass', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const cards: string[] = Array.isArray(req.body?.cards) ? req.body.cards.map(String) : [];
    const { game } = heartsBoard(tableId);
    afterHeartsMove(res, tableId, heartsPass(game, ownerSeat(), cards));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/hearts/play', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const card = String(req.body?.card ?? '');
    const { game } = heartsBoard(tableId);
    afterHeartsMove(res, tableId, heartsPlay(game, ownerSeat(), card));
  } catch (error) {
    sendError(res, error);
  }
});

// ----------------------------------------------------------------- president
//
// Sets that must be beaten by bigger sets; threes low, twos high; first hand
// empty is President and the last one holding cards is Scum. The round has a
// memory — a new deal taxes the Scum a card and pays it to the President.
// Rules live in services/db/president.ts and are tested there.

function presidentBoard(tableId: string): { game: PresidentState } {
  const table = getCardTable(tableId);
  if (!table) throw new CardRoomError('No such table', 404);
  if (table.game !== 'president') throw new CardRoomError('No President on this table', 409);
  return { game: table.state as unknown as PresidentState };
}

function runPresidentKings(game: PresidentState): PresidentState {
  let next = game;
  let guard = 0;
  while (next.phase === 'playing' && next.turn && next.turn !== ownerSeat() && guard < 200) {
    guard += 1;
    const actor = next.turn;
    const move = decidePresidentMove(next, actor);
    next = 'pass' in move ? presidentPass(next, actor) : presidentPlay(next, actor, move.play);
  }
  return next;
}

function afterPresidentMove(res: import('express').Response, tableId: string, game: PresidentState): void {
  const finished = runPresidentKings(game);
  const table = setCardState(tableId, finished as unknown as Record<string, unknown>);
  registry.broadcast({ type: 'card_table_update', tableId });
  res.json({ table: viewCardTable(table, ownerSeat()), game: finished });
}

router.post('/president/new', (req, res) => {
  try {
    const order: string[] = Array.isArray(req.body?.order) && req.body.order.length >= 2
      ? req.body.order.map(String)
      : defaultGameSeats();
    const tableId = String(req.body?.tableId ?? (newCardTable('president')).id);
    // A table that has already played a round remembers who owes whom.
    const existing = getCardTable(tableId);
    const previous = existing?.game === 'president'
      ? ((existing.state as unknown as PresidentState).titles ?? null)
      : null;
    const game = newPresident(loadDeck(), order, previous as Record<string, PresidentTitle> | null);
    const table = setCardGame(tableId, 'president', game as unknown as Record<string, unknown>);
    const taxLine = game.events.length ? ` ${game.events[0]}.` : '';
    addCardLog(tableId, 'system', 'house', `New round of President — ${order.join(', ')}. Threes low, twos high, three of clubs leads.${taxLine}`);
    registry.broadcast({ type: 'card_table_update', tableId });
    // The companions may sit before the owner in the order, so the table comes back live.
    const opened = runPresidentKings(game);
    const settled = setCardState(tableId, opened as unknown as Record<string, unknown>);
    res.status(201).json({ table: viewCardTable(settled, ownerSeat()), game: opened });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/president/play', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const cards: string[] = Array.isArray(req.body?.cards) ? req.body.cards.map(String) : [];
    const { game } = presidentBoard(tableId);
    afterPresidentMove(res, tableId, presidentPlay(game, ownerSeat(), cards));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/president/pass', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const { game } = presidentBoard(tableId);
    afterPresidentMove(res, tableId, presidentPass(game, ownerSeat()));
  } catch (error) {
    sendError(res, error);
  }
});

// -------------------------------------------------------------- crazy eights
//
// Match the suit or the number; eights are wild and the player names the suit.
// Rules live in services/db/eights.ts and are tested there.

function eightsBoard(tableId: string): { game: EightsState } {
  const table = getCardTable(tableId);
  if (!table) throw new CardRoomError('No such table', 404);
  if (table.game !== 'eights') throw new CardRoomError('No Crazy Eights on this table', 409);
  return { game: table.state as unknown as EightsState };
}

/** Play out every companion sitting between the owner and their next turn. */
function runEightsKings(game: EightsState): EightsState {
  let next = game;
  let guard = 0;
  while (next.phase === 'playing' && next.turn && next.turn !== ownerSeat() && guard < 60) {
    guard += 1;
    const actor = next.turn;
    const move = decideEightsMove(next, actor);
    if ('draw' in move) {
      const drawn = eightsDraw(next, actor);
      // Drawing does not pass the turn unless it found nothing at all.
      if (drawn.turn !== actor) { next = drawn; continue; }
      const after = decideEightsMove(drawn, actor);
      next = 'play' in after ? eightsPlay(drawn, actor, after.play, after.suit) : drawn;
      continue;
    }
    next = eightsPlay(next, actor, move.play, move.suit);
  }
  return next;
}

function afterEightsMove(res: import('express').Response, tableId: string, game: EightsState): void {
  const finished = runEightsKings(game);
  const table = setCardState(tableId, finished as unknown as Record<string, unknown>);
  registry.broadcast({ type: 'card_table_update', tableId });
  res.json({ table: viewCardTable(table, ownerSeat()), game: finished });
}

router.post('/eights/new', (req, res) => {
  try {
    const order: string[] = Array.isArray(req.body?.order) && req.body.order.length >= 2
      ? req.body.order.map(String)
      : defaultGameSeats();
    const tableId = String(req.body?.tableId ?? (newCardTable('eights')).id);
    const game = newEights(loadDeck(), order);
    const table = setCardGame(tableId, 'eights', game as unknown as Record<string, unknown>);
    addCardLog(tableId, 'system', 'house', `New round of Crazy Eights — ${order.join(', ')}. Match the suit or the number; eights are wild.`);
    registry.broadcast({ type: 'card_table_update', tableId });
    res.status(201).json({ table: viewCardTable(table, ownerSeat()), game });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/eights/play', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const card = String(req.body?.card ?? '');
    const suit = typeof req.body?.suit === 'string' ? req.body.suit : undefined;
    const { game } = eightsBoard(tableId);
    afterEightsMove(res, tableId, eightsPlay(game, ownerSeat(), card, suit as never));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/eights/draw', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const { game } = eightsBoard(tableId);
    const drawn = eightsDraw(game, ownerSeat());
    // If the draw found the owner something, the turn is still theirs to finish, so the
    // companions must not move yet.
    if (drawn.turn === ownerSeat() && playableFrom(drawn.hands[ownerSeat()], drawn.pile.at(-1) as string, drawn.suit).length) {
      const table = setCardState(tableId, drawn as unknown as Record<string, unknown>);
      registry.broadcast({ type: 'card_table_update', tableId });
      res.json({ table: viewCardTable(table, ownerSeat()), game: drawn });
      return;
    }
    afterEightsMove(res, tableId, drawn);
  } catch (error) {
    sendError(res, error);
  }
});

// ---------------------------------------------------------------------- golf
//
// Six-card Golf: the first game in this room nobody at the table already knew.
// Rules and scoring live in services/db/golf.ts and are tested there; these
// routes only move state. A companion's turn is taken here rather than in a lane,
// because it is a decision about cards and not a thing anybody needs to say.

function golfBoard(tableId: string): { game: GolfState } {
  const table = getCardTable(tableId);
  if (!table) throw new CardRoomError('No such table', 404);
  if (table.game !== 'golf') throw new CardRoomError('No Golf on this table', 409);
  return { game: table.state as unknown as GolfState };
}

/** Play out every companion sitting between the owner and their next turn. */
function runKings(game: GolfState): GolfState {
  let next = game;
  let guard = 0;
  while (next.phase === 'playing' && next.turn && next.turn !== ownerSeat() && guard < 40) {
    guard += 1;
    const actor = next.turn;
    const move = decideGolfMove(next, actor);
    if (move.take === 'discard') {
      next = golfPlace(golfDraw(next, actor, 'discard'), actor, move.place);
      continue;
    }
    next = golfDraw(next, actor, 'stock');
    const call = decideGolfPlacement(next, actor);
    next = 'place' in call
      ? golfPlace(next, actor, call.place)
      : golfDiscardFlip(next, actor, call.flip);
  }
  return next;
}

function afterGolfMove(res: import('express').Response, tableId: string, game: GolfState): void {
  const finished = runKings(game);
  const table = setCardState(tableId, finished as unknown as Record<string, unknown>);
  registry.broadcast({ type: 'card_table_update', tableId });
  res.json({ table: viewCardTable(table, ownerSeat()), game: finished });
}

router.post('/golf/new', (req, res) => {
  try {
    const order: string[] = Array.isArray(req.body?.order) && req.body.order.length >= 2
      ? req.body.order.map(String)
      : defaultGameSeats();
    const tableId = String(req.body?.tableId ?? (newCardTable('golf')).id);
    const game = newGolf(loadDeck(), order);
    const table = setCardGame(tableId, 'golf', game as unknown as Record<string, unknown>);
    addCardLog(tableId, 'system', 'house', `New round of Golf — ${order.join(', ')}. Lowest score takes it; kings are nothing and a two is minus two.`);
    registry.broadcast({ type: 'card_table_update', tableId });
    res.status(201).json({ table: viewCardTable(table, ownerSeat()), game });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/golf/draw', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const from = req.body?.from === 'discard' ? 'discard' : 'stock';
    const { game } = golfBoard(tableId);
    // Drawing does not end the owner's turn, so the companions do not move yet.
    const next = golfDraw(game, ownerSeat(), from);
    const table = setCardState(tableId, next as unknown as Record<string, unknown>);
    registry.broadcast({ type: 'card_table_update', tableId });
    res.json({ table: viewCardTable(table, ownerSeat()), game: next });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/golf/place', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const index = Number(req.body?.index);
    const { game } = golfBoard(tableId);
    afterGolfMove(res, tableId, golfPlace(game, ownerSeat(), index));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/golf/flip', (req, res) => {
  try {
    const tableId = String(req.body?.tableId ?? '');
    const index = Number(req.body?.index);
    const { game } = golfBoard(tableId);
    afterGolfMove(res, tableId, golfDiscardFlip(game, ownerSeat(), index));
  } catch (error) {
    sendError(res, error);
  }
});

// ----------------------------------------------------------------- the rail
//
// The companions sit at the table while the owner plays. They answer in the
// Card Room's own archived thread, which means the reply renders here and does
// not duplicate into the main chat — a reply is written to the thread its turn
// arrived on.

router.get('/rail', (req, res) => {
  try {
    const table = getCardTable(typeof req.query.id === 'string' ? req.query.id : undefined);
    if (!table) {
      res.json({ messages: [], companionPending: false });
      return;
    }
    // The slug rides along so the rail can hand the shared voice splitter a
    // whole message. Without it a companion reply with no in-text header comes
    // back faceless, which is the one case the splitter cannot recover from
    // text alone. Same mapping the Fleet Room does.
    const companionSlugs = new Map(listCompanions().map((c) => [c.id, c.id]));
    const messages = getMessages({ threadId: table.threadId, limit: 60 }).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
      companionSlug: m.companion_id ? companionSlugs.get(m.companion_id) ?? null : null,
    }));
    res.json({
      messages,
      // The rail is a real thread, so reading it here has to count as reading
      // it — the phone needs the id to say so.
      threadId: table.threadId,
      companionPending: table.companionPending,
      companionError: table.companionError,
      log: getCardLog(table.id, 20),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/chat', (req, res) => {
  const agentService = req.app.locals.agentService as AgentService | undefined;
  if (!agentService) {
    res.status(503).json({ error: 'The companion lane is not available' });
    return;
  }
  const tableId = String(req.body?.tableId ?? '');
  try {
    const turn = beginCardRoomResponse(tableId, String(req.body?.content ?? ''));
    registry.broadcast({ type: 'card_table_update', tableId });
    // 202 and return: the room answers on its own time and the rail picks the
    // reply up over the socket rather than holding this request open.
    res.status(202).json({ ok: true });

    setImmediate(() => {
      void (async () => {
        let failure: string | null = null;
        try {
          await agentService.processMessage(
            turn.threadId, turn.prompt, { name: 'The Card Room', type: 'named' }, { platform: 'api' },
          );
        } catch (caught) {
          console.error('[CardRoom] Companion turn failed:', caught);
          failure = 'The line to the table dropped. Say something else to call them back.';
        } finally {
          finishCardRoomResponse(tableId, failure);
          registry.broadcast({ type: 'card_table_update', tableId });
        }
      })();
    });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
