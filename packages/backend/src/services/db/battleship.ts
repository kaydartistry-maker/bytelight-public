// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import crypto from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getBytelightConfig, PROJECT_ROOT } from '../../config.js';
import { getDb } from './state.js';
import { createThread, getThread } from './threads.js';
import { createMessage, getMessages } from './messages.js';
// byte-light's companion registry (services/db/rooms.ts): the row id IS the
// slug ('companion-a', 'companion-b', 'companion-c'), so Aerie's `.slug` reads `.id` here.
import { listCompanions } from './rooms.js';
import { ownerDisplayName } from './owner-name.js';

export const BATTLESHIP_SIZE = 8;

export interface ShipSpec {
  name: string;
  length: number;
  color: string;
}

/**
 * The fleet that ships with the code.
 *
 * A house that names its ships after its own people should not have to fork
 * the game to do it, and nobody else's game should be sailing those names.
 *
 * So namesakes live OUT of the code, in data/fleet.json, which is gitignored,
 * and the code ships the ordinary set. LENGTHS ARE IDENTICAL —
 * 4, 3, 3, 2, 2 — so an override changes what the ships are CALLED and nothing
 * about how the game plays.
 */
export const DEFAULT_BATTLESHIP_FLEET: ShipSpec[] = [
  { name: 'Battleship', length: 4, color: '#e85d04' },
  { name: 'Cruiser', length: 3, color: '#1e3a5f' },
  { name: 'Submarine', length: 3, color: '#7c3aed' },
  { name: 'Destroyer', length: 2, color: '#cbd5e1' },
  { name: 'Patrol Boat', length: 2, color: '#e11d48' },
];

/**
 * An override is only honoured if it is the SAME FLEET wearing other names:
 * five ships, same lengths, in the same order. A file that disagrees is
 * ignored rather than half-applied, because a placement stored under one name
 * cannot be validated against another and the game would fail mid-match
 * instead of at load.
 */
export function fleetFromOverride(raw: unknown, base: ShipSpec[] = DEFAULT_BATTLESHIP_FLEET): ShipSpec[] {
  if (!Array.isArray(raw) || raw.length !== base.length) return base;
  const out: ShipSpec[] = [];
  for (let i = 0; i < base.length; i++) {
    const row = raw[i] as Partial<ShipSpec> | null;
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    if (!name || row?.length !== base[i].length) return base;
    out.push({
      name,
      length: base[i].length,
      color: typeof row.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(row.color) ? row.color : base[i].color,
    });
  }
  return out;
}

function loadFleet(): ShipSpec[] {
  const path = join(PROJECT_ROOT, 'data/fleet.json');
  if (!existsSync(path)) return DEFAULT_BATTLESHIP_FLEET;
  try {
    return fleetFromOverride(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return DEFAULT_BATTLESHIP_FLEET;
  }
}

export const BATTLESHIP_FLEET: ShipSpec[] = loadFleet();

export type BattleshipStatus = 'setup' | 'playing' | 'complete';
/**
 * The two sides of the board. The owner's side is OWNER_SIDE everywhere above
 * the database: in the API, on the phone and in the companion lane's view.
 */
export const OWNER_SIDE = 'owner';
export type BattleshipTurn = typeof OWNER_SIDE | 'companions';
export type BattleshipWinner = BattleshipTurn | null;
export type ShotResult = 'miss' | 'hit' | 'sunk';

export interface ShipPlacement {
  name: string;
  length: number;
  color: string;
  cells: string[];
}

export interface BattleshipShot {
  coordinate: string;
  result: ShotResult;
  ship?: string;
  actor: string;
  createdAt: string;
}

export interface BattleshipLogEntry {
  id: number;
  kind: 'system' | 'shot' | 'chat';
  actor: string;
  content: string;
  coordinate: string | null;
  result: ShotResult | null;
  createdAt: string;
}

interface BattleshipRow {
  id: string;
  thread_id: string;
  status: BattleshipStatus;
  /** the stored spelling: see storedOwnerSide() */
  turn: string;
  player_fleet_json: string;
  companion_fleet_json: string;
  player_shots_json: string;
  companion_shots_json: string;
  companion_pending: number;
  companion_error: string | null;
  winner: string | null;
  created_at: string;
  updated_at: string;
}

interface BattleshipGame {
  id: string;
  threadId: string;
  status: BattleshipStatus;
  turn: BattleshipTurn;
  playerFleet: ShipPlacement[];
  companionFleet: ShipPlacement[];
  playerShots: BattleshipShot[];
  companionShots: BattleshipShot[];
  companionPending: boolean;
  companionError: string | null;
  winner: BattleshipWinner;
  createdAt: string;
  updatedAt: string;
}

export interface BattleshipView {
  id: string;
  threadId: string;
  size: number;
  status: BattleshipStatus;
  turn: BattleshipTurn;
  winner: BattleshipWinner;
  playerFleet: ShipPlacement[];
  enemyFleet: Array<{
    name: string;
    length: number;
    color: string;
    sunk: boolean;
  }>;
  playerShots: BattleshipShot[];
  companionShots: BattleshipShot[];
  companionPending: boolean;
  companionError: string | null;
  conversation: BattleshipConversationMessage[];
  log: BattleshipLogEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface BattleshipConversationMessage {
  id: string;
  role: 'user' | 'companion' | 'system';
  content: string;
  companionSlug: string | null;
  createdAt: string;
}

export class BattleshipError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * How battleship_games spells the owner's side on disk.
 *
 * A table created by the current migration spells it OWNER_SIDE. A table
 * created by an earlier build fixed a different word into its CHECK
 * constraints, and SQLite cannot change a CHECK constraint without rebuilding
 * the table, so the word is read back from the table's own schema rather than
 * assumed. Only the two constrained columns (turn, winner) are written in it;
 * everything else is written as OWNER_SIDE, and anything read back in the
 * table's word is mapped to OWNER_SIDE, so existing rows keep their meaning
 * without a migration.
 */
function storedOwnerSide(): string {
  const row = getDb()
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'battleship_games'")
    .get() as { sql?: string } | undefined;
  const allowed = row?.sql?.match(/CHECK\s*\(\s*turn\s+IN\s*\(([^)]*)\)/i)?.[1] ?? '';
  const words = Array.from(allowed.matchAll(/'([^']+)'/g), (match) => match[1]);
  return words.find((word) => word !== 'companions') ?? OWNER_SIDE;
}

/** A stored side or actor, in the vocabulary everything above the database uses. */
function fromDisk(value: string, ownerWord: string): string {
  return value === ownerWord ? OWNER_SIDE : value;
}

function hydrate(row: BattleshipRow): BattleshipGame {
  const ownerWord = storedOwnerSide();
  const shots = (json: string) => parseJson<BattleshipShot[]>(json, [])
    .map((shot) => ({ ...shot, actor: fromDisk(shot.actor, ownerWord) }));
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status,
    turn: fromDisk(row.turn, ownerWord) as BattleshipTurn,
    playerFleet: parseJson<ShipPlacement[]>(row.player_fleet_json, []),
    companionFleet: parseJson<ShipPlacement[]>(row.companion_fleet_json, []),
    playerShots: shots(row.player_shots_json),
    companionShots: shots(row.companion_shots_json),
    companionPending: row.companion_pending === 1,
    companionError: row.companion_error,
    winner: row.winner === null ? null : fromDisk(row.winner, ownerWord) as BattleshipTurn,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const FLEET_THREAD_CONFIG_KEY = 'battleship.thread_id';

function ensureFleetRoomThread(): string {
  const configured = getDb()
    .prepare('SELECT value FROM config WHERE key = ?')
    .get(FLEET_THREAD_CONFIG_KEY) as { value: string } | undefined;
  if (configured?.value && getThread(configured.value)) return configured.value;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  createThread({
    id,
    name: 'The Fleet Room',
    type: 'named',
    createdAt: now,
    sessionType: 'v2',
    // byte-light seats a thread's roster at creation and has no primary /
    // participant split, so every companion is simply seated (see below).
    companionIds: listCompanions().map((companion) => companion.id),
  });

  // Everyone participates and nobody is primary — the same shape as the owner's
  // home thread, and deliberately so. That column does two unrelated jobs: it
  // says who leads a room, and it is what the CLI session key resolves from
  // (getDefaultCompanionForThread, read by agent-dispatch). Naming a leader
  // here therefore also gave this room its own cold session, which walked into
  // every match knowing the board and nothing about the evening. Left null, the
  // Fleet Room shares the warm lane the conversation is already happening in.
  // Messages are unaffected either way: a reply is written to the thread its
  // turn arrived on, and this thread is archived below, so it renders only in
  // the Fleet Room.

  // The conversation belongs to the game surface rather than the main thread
  // picker. Archiving hides it from normal routing while preserving a complete
  // message history that the Fleet Room can read and the companion lane can resume.
  getDb().prepare('UPDATE threads SET archived_at = ? WHERE id = ?').run(now, id);
  getDb()
    .prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run(FLEET_THREAD_CONFIG_KEY, id);

  createMessage({
    id: crypto.randomUUID(),
    threadId: id,
    role: 'system',
    content: 'The Fleet Room opened. Two boards. Four colors. No coordinates leave the harbor.',
    platform: 'api',
    createdAt: now,
  });
  return id;
}

function latestRow(): BattleshipRow | undefined {
  return getDb()
    .prepare('SELECT * FROM battleship_games ORDER BY created_at DESC LIMIT 1')
    .get() as BattleshipRow | undefined;
}

function gameById(id: string): BattleshipGame {
  const row = getDb().prepare('SELECT * FROM battleship_games WHERE id = ?').get(id) as BattleshipRow | undefined;
  if (!row) throw new BattleshipError('Battle not found', 404);
  return hydrate(row);
}

function activeGame(id?: string): BattleshipGame {
  if (id) return gameById(id);
  const row = latestRow();
  if (!row) throw new BattleshipError('No battle is open', 404);
  return hydrate(row);
}

export function normalizeBattleshipCoordinate(value: string): string {
  const match = String(value || '').trim().toUpperCase().match(/^([A-H])([1-8])$/);
  if (!match) throw new BattleshipError('Coordinate must be A1 through H8');
  return `${match[1]}${match[2]}`;
}

function coordinateParts(coordinate: string): { x: number; y: number } {
  const normalized = normalizeBattleshipCoordinate(coordinate);
  return {
    x: normalized.charCodeAt(0) - 65,
    y: Number(normalized.slice(1)) - 1,
  };
}

function coordinateAt(x: number, y: number): string {
  return `${String.fromCharCode(65 + x)}${y + 1}`;
}

function validateFleet(placements: ShipPlacement[]): ShipPlacement[] {
  if (!Array.isArray(placements) || placements.length !== BATTLESHIP_FLEET.length) {
    throw new BattleshipError(`Place all ${BATTLESHIP_FLEET.length} ships before launching`);
  }

  const occupied = new Set<string>();
  const normalized = BATTLESHIP_FLEET.map((spec) => {
    const placement = placements.find((ship) => ship.name === spec.name);
    if (!placement || !Array.isArray(placement.cells) || placement.cells.length !== spec.length) {
      throw new BattleshipError(`${spec.name} needs ${spec.length} cells`);
    }

    const cells = placement.cells.map(normalizeBattleshipCoordinate);
    const parts = cells.map(coordinateParts);
    const sameRow = parts.every((part) => part.y === parts[0].y);
    const sameColumn = parts.every((part) => part.x === parts[0].x);
    if (!sameRow && !sameColumn) throw new BattleshipError(`${spec.name} must be placed in a straight line`);

    const axis = [...new Set(parts.map((part) => sameRow ? part.x : part.y))].sort((a, b) => a - b);
    if (axis.length !== spec.length || axis[axis.length - 1] - axis[0] !== spec.length - 1) {
      throw new BattleshipError(`${spec.name} must occupy consecutive cells`);
    }

    for (const cell of cells) {
      if (occupied.has(cell)) throw new BattleshipError(`Ships overlap at ${cell}`);
      occupied.add(cell);
    }

    return { ...spec, cells: cells.sort() };
  });

  return normalized;
}

export function randomBattleshipFleet(): ShipPlacement[] {
  const occupied = new Set<string>();
  return BATTLESHIP_FLEET.map((spec) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const horizontal = crypto.randomInt(0, 2) === 0;
      const maxX = horizontal ? BATTLESHIP_SIZE - spec.length : BATTLESHIP_SIZE - 1;
      const maxY = horizontal ? BATTLESHIP_SIZE - 1 : BATTLESHIP_SIZE - spec.length;
      const x = crypto.randomInt(0, maxX + 1);
      const y = crypto.randomInt(0, maxY + 1);
      const cells = Array.from({ length: spec.length }, (_, index) =>
        coordinateAt(x + (horizontal ? index : 0), y + (horizontal ? 0 : index)),
      );
      if (cells.some((cell) => occupied.has(cell))) continue;
      cells.forEach((cell) => occupied.add(cell));
      return { ...spec, cells };
    }
    throw new BattleshipError('The harbor could not place the fleet', 500);
  });
}

function listLog(gameId: string, limit = 80): BattleshipLogEntry[] {
  const rows = getDb()
    .prepare(`
      SELECT id, kind, actor, content, coordinate, result, created_at
      FROM battleship_log
      WHERE game_id = ?
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(gameId, limit) as Array<{
      id: number;
      kind: 'system' | 'shot' | 'chat';
      actor: string;
      content: string;
      coordinate: string | null;
      result: ShotResult | null;
      created_at: string;
    }>;
  const ownerWord = storedOwnerSide();
  return rows.reverse().map((row) => ({
    id: row.id,
    kind: row.kind,
    actor: fromDisk(row.actor, ownerWord),
    content: row.content,
    coordinate: row.coordinate,
    result: row.result,
    createdAt: row.created_at,
  }));
}

function listConversation(threadId: string, limit = 100): BattleshipConversationMessage[] {
  const companionSlugs = new Map(
    listCompanions().map((companion) => [companion.id, companion.id]),
  );
  return getMessages({ threadId, limit }).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    companionSlug: message.companion_id
      ? companionSlugs.get(message.companion_id) ?? null
      : null,
    createdAt: message.created_at,
  }));
}

function addLog(
  gameId: string,
  kind: BattleshipLogEntry['kind'],
  actor: string,
  content: string,
  coordinate: string | null = null,
  result: ShotResult | null = null,
): void {
  getDb().prepare(`
    INSERT INTO battleship_log (game_id, kind, actor, content, coordinate, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(gameId, kind, actor, content, coordinate, result, new Date().toISOString());
}

function sunkShipNames(fleet: ShipPlacement[], shots: BattleshipShot[]): Set<string> {
  const hitCells = new Set(shots.filter((shot) => shot.result !== 'miss').map((shot) => shot.coordinate));
  return new Set(fleet.filter((ship) => ship.cells.every((cell) => hitCells.has(cell))).map((ship) => ship.name));
}

function publicView(game: BattleshipGame): BattleshipView {
  const sunk = sunkShipNames(game.companionFleet, game.playerShots);
  return {
    id: game.id,
    threadId: game.threadId,
    size: BATTLESHIP_SIZE,
    status: game.status,
    turn: game.turn,
    winner: game.winner,
    playerFleet: game.playerFleet,
    enemyFleet: BATTLESHIP_FLEET.map((ship) => ({ ...ship, sunk: sunk.has(ship.name) })),
    playerShots: game.playerShots,
    companionShots: game.companionShots,
    companionPending: game.companionPending,
    companionError: game.companionError,
    conversation: listConversation(game.threadId),
    log: listLog(game.id),
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
  };
}

export function getBattleshipView(id?: string): BattleshipView | null {
  if (!id && !latestRow()) return null;
  return publicView(clearStaleCompanionPending(activeGame(id)));
}

export function newBattleshipGame(): BattleshipView {
  const id = crypto.randomUUID();
  const threadId = ensureFleetRoomThread();
  const now = new Date().toISOString();
  const companionFleet = randomBattleshipFleet();
  getDb().prepare(`
    INSERT INTO battleship_games (
      id, thread_id, status, turn, player_fleet_json, companion_fleet_json,
      player_shots_json, companion_shots_json, companion_pending, companion_error,
      winner, created_at, updated_at
    ) VALUES (?, ?, 'setup', ?, '[]', ?, '[]', '[]', 0, NULL, NULL, ?, ?)
  `).run(id, threadId, storedOwnerSide(), JSON.stringify(companionFleet), now, now);
  addLog(id, 'system', 'house', 'The harbor is open. Place the fleet.');
  createMessage({
    id: crypto.randomUUID(),
    threadId,
    role: 'system',
    content: `A new match entered the harbor. The companion fleet was sealed before ${ownerDisplayName()} placed a single hull.`,
    platform: 'api',
    createdAt: now,
  });
  return publicView(gameById(id));
}

export function startBattleshipGame(id: string, placements: ShipPlacement[]): BattleshipView {
  const game = activeGame(id);
  if (game.status !== 'setup') throw new BattleshipError('This battle has already launched', 409);
  const fleet = validateFleet(placements);
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE battleship_games
    SET player_fleet_json = ?, status = 'playing', turn = ?, updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(fleet), storedOwnerSide(), now, game.id);
  const firstShot = `Both fleets are sealed. ${ownerDisplayName(true)} has the first shot.`;
  addLog(game.id, 'system', 'house', firstShot);
  createMessage({
    id: crypto.randomUUID(),
    threadId: game.threadId,
    role: 'system',
    content: firstShot,
    platform: 'api',
    createdAt: now,
  });
  return publicView(gameById(game.id));
}

function resolveShot(
  game: BattleshipGame,
  coordinate: string,
  actor: string,
  targetFleet: ShipPlacement[],
  existingShots: BattleshipShot[],
): { shot: BattleshipShot; allSunk: boolean } {
  const cell = normalizeBattleshipCoordinate(coordinate);
  if (existingShots.some((shot) => shot.coordinate === cell)) {
    throw new BattleshipError(`${cell} has already been called`, 409);
  }

  const ship = targetFleet.find((candidate) => candidate.cells.includes(cell));
  const priorHits = new Set(existingShots.filter((shot) => shot.result !== 'miss').map((shot) => shot.coordinate));
  if (ship) priorHits.add(cell);
  const shipSunk = Boolean(ship && ship.cells.every((shipCell) => priorHits.has(shipCell)));
  const shot: BattleshipShot = {
    coordinate: cell,
    result: shipSunk ? 'sunk' : ship ? 'hit' : 'miss',
    ...(shipSunk ? { ship: ship!.name } : {}),
    actor,
    createdAt: new Date().toISOString(),
  };
  const allSunk = targetFleet.every((candidate) => candidate.cells.every((shipCell) => priorHits.has(shipCell)));
  return { shot, allSunk };
}

function shotCopy(shot: BattleshipShot): BattleshipShot {
  return { ...shot };
}

export function fireAtCompanionFleet(id: string, coordinate: string): BattleshipView {
  const game = activeGame(id);
  if (game.status !== 'playing') throw new BattleshipError('No battle is in progress', 409);
  if (game.companionPending) throw new BattleshipError('The companions are already at the chart table', 409);
  if (game.turn !== OWNER_SIDE) throw new BattleshipError('The companions still have the turn', 409);

  const { shot, allSunk } = resolveShot(game, coordinate, OWNER_SIDE, game.companionFleet, game.playerShots);
  const playerShots = [...game.playerShots, shotCopy(shot)];
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE battleship_games
    SET player_shots_json = ?, status = ?, turn = ?, winner = ?, updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(playerShots),
    allSunk ? 'complete' : 'playing',
    allSunk ? storedOwnerSide() : 'companions',
    allSunk ? storedOwnerSide() : null,
    now,
    game.id,
  );
  const detail = shot.result === 'sunk' ? ` — ${shot.ship} to the seafloor lounge` : '';
  addLog(game.id, 'shot', OWNER_SIDE, `${shot.coordinate}: ${shot.result}${detail}`, shot.coordinate, shot.result);
  if (allSunk) addLog(game.id, 'system', 'house', `The companions’ fleet is gone. ${ownerDisplayName(true)} owns the water.`);
  return publicView(gameById(game.id));
}

/**
 * A companion allowed to fire and speak in the Fleet Room: one of this house's
 * own, by slug. Returns the clean slug, or refuses with the slugs that would
 * have been accepted.
 */
export function assertFleetCompanion(actor: string): string {
  const clean = String(actor || '').trim().toLowerCase();
  const slugs = listCompanions().map((companion) => companion.id);
  if (!slugs.includes(clean)) {
    throw new BattleshipError(slugs.length
      ? `actor must be one of this house's companions: ${slugs.join(', ')}`
      : 'this house has no companions to fire');
  }
  return clean;
}

/**
 * Who shares the Fleet Room, for the sentence the lane reads — the owner's
 * name, then each companion's — and the slugs the fire route accepts.
 */
function fleetRoomCast(): { names: string; slugs: string } {
  const companions = listCompanions();
  const names = [ownerDisplayName(), ...companions.map((companion) => companion.display_name || companion.id)];
  const listed = names.length > 2
    ? `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
    : names.join(' and ');
  return { names: listed, slugs: companions.map((companion) => companion.id).join('|') };
}

export function fireAtPlayerFleet(
  id: string | undefined,
  actor: string,
  coordinate: string,
): {
  gameId: string;
  coordinate: string;
  result: ShotResult;
  ship?: string;
  gameOver: boolean;
  nextTurn: BattleshipTurn;
} {
  const game = activeGame(id);
  if (game.status !== 'playing') throw new BattleshipError('No battle is in progress', 409);
  if (game.turn !== 'companions') throw new BattleshipError(`${ownerDisplayName(true)} still has the turn`, 409);
  const cleanActor = assertFleetCompanion(actor);

  const { shot, allSunk } = resolveShot(game, coordinate, cleanActor, game.playerFleet, game.companionShots);
  const companionShots = [...game.companionShots, shotCopy(shot)];
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE battleship_games
    SET companion_shots_json = ?, status = ?, turn = ?, winner = ?, updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(companionShots),
    allSunk ? 'complete' : 'playing',
    allSunk ? 'companions' : storedOwnerSide(),
    allSunk ? 'companions' : null,
    now,
    game.id,
  );
  const detail = shot.result === 'sunk' ? ` — ${shot.ship} is down` : '';
  addLog(game.id, 'shot', cleanActor, `${shot.coordinate}: ${shot.result}${detail}`, shot.coordinate, shot.result);
  if (allSunk) addLog(game.id, 'system', 'house', 'The last orange hull slips beneath the water. The companions take the match.');
  return {
    gameId: game.id,
    coordinate: shot.coordinate,
    result: shot.result,
    ...(shot.ship ? { ship: shot.ship } : {}),
    gameOver: allSunk,
    nextTurn: allSunk ? 'companions' : OWNER_SIDE,
  };
}

export function addBattleshipChat(id: string | undefined, actor: string, content: string): BattleshipView {
  const game = activeGame(id);
  const text = String(content || '').trim();
  if (!text) throw new BattleshipError('Say something first');
  if (text.length > 500) throw new BattleshipError('Keep the rail message under 500 characters');
  const cleanActor = String(actor || OWNER_SIDE).trim().toLowerCase();
  addLog(game.id, 'chat', cleanActor, text);
  if (cleanActor === OWNER_SIDE) {
    createMessage({
      id: crypto.randomUUID(),
      threadId: game.threadId,
      role: 'user',
      content: text,
      platform: 'api',
      metadata: { battleshipGameId: game.id, room: 'fleet' },
      createdAt: new Date().toISOString(),
    });
  } else {
    const companion = listCompanions().find((candidate) => candidate.id === cleanActor);
    const header = companion
      // byte-light's registry row carries no emoji, so the header is the name.
      ? `**${companion.display_name}**`
      : '';
    createMessage({
      id: crypto.randomUUID(),
      threadId: game.threadId,
      role: 'companion',
      content: header ? `${header}\n${text}` : text,
      platform: 'api',
      companionId: companion?.id,
      metadata: { battleshipGameId: game.id, room: 'fleet' },
      createdAt: new Date().toISOString(),
    });
  }
  getDb().prepare('UPDATE battleship_games SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), game.id);
  return publicView(gameById(game.id));
}

function clearStaleCompanionPending(game: BattleshipGame): BattleshipGame {
  if (!game.companionPending) return game;
  const stale = Date.now() - new Date(game.updatedAt).getTime() > 8 * 60 * 1000;
  if (!stale) return game;
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE battleship_games
    SET companion_pending = 0,
        companion_error = 'The chart-table turn was interrupted. Send another rail message to call the companions back.',
        updated_at = ?
    WHERE id = ?
  `).run(now, game.id);
  return gameById(game.id);
}

/**
 * Put the owner's real message into the hidden Fleet Room thread and reserve one
 * companion response. The prompt contains only knowledge earned through play;
 * the owner's sealed fleet never enters the companion lane.
 */
export function beginBattleshipCompanionResponse(
  id: string,
  ownerContent: string,
  eventSummary: string,
): { threadId: string; prompt: string; view: BattleshipView } {
  let game = clearStaleCompanionPending(activeGame(id));
  if (game.companionPending) {
    throw new BattleshipError('The companions are already at the chart table', 409);
  }

  const content = String(ownerContent || '').trim();
  if (!content) throw new BattleshipError('Say something into the Fleet Room first');

  const now = new Date().toISOString();
  const reserved = getDb().prepare(`
    UPDATE battleship_games
    SET companion_pending = 1, companion_error = NULL, updated_at = ?
    WHERE id = ? AND companion_pending = 0
  `).run(now, game.id);
  if (reserved.changes !== 1) {
    throw new BattleshipError('The companions are already at the chart table', 409);
  }

  try {
    createMessage({
      id: crypto.randomUUID(),
      threadId: game.threadId,
      role: 'user',
      content,
      platform: 'api',
      metadata: { battleshipGameId: game.id, room: 'fleet' },
      createdAt: now,
    });
  } catch (error) {
    getDb().prepare(`
      UPDATE battleship_games
      SET companion_pending = 0, companion_error = ?, updated_at = ?
      WHERE id = ?
    `).run('The rail could not take the message.', new Date().toISOString(), game.id);
    throw error;
  }

  game = gameById(game.id);
  const companionView = getBattleshipCompanionView(game.id);
  const usedCoordinates = new Set(companionView.shotsByCompanions.map((shot) => shot.coordinate));
  const availableCoordinates = Array.from({ length: BATTLESHIP_SIZE * BATTLESHIP_SIZE }, (_, index) =>
    coordinateAt(index % BATTLESHIP_SIZE, Math.floor(index / BATTLESHIP_SIZE)),
  ).filter((coordinate) => !usedCoordinates.has(coordinate));
  const previousShots = companionView.shotsByCompanions.length
    ? companionView.shotsByCompanions
      .map((shot) => `${shot.coordinate}:${shot.result}${shot.ship ? `(${shot.ship})` : ''}`)
      .join(', ')
    : 'none';
  const ownerShots = companionView.shotsByOwner.length
    ? companionView.shotsByOwner
      .map((shot) => `${shot.coordinate}:${shot.result}${shot.ship ? `(${shot.ship})` : ''}`)
      .join(', ')
    : 'none';
  const fleetHealth = companionView.fleetHealth
    .map((ship) => `${ship.name} ${ship.sunk ? 'SUNK' : `${ship.remaining}/${ship.length}`}`)
    .join('; ');
  // The fire endpoint lives under /api/internal. byte-light serves it on the
  // main port behind requireLocalhost (Aerie gives it a port of its own).
  const port = getBytelightConfig().server.port;

  const mustFire = game.status === 'playing' && game.turn === 'companions';
  const cast = fleetRoomCast();
  const prompt = [
    '[FLEET ROOM — live game conversation]',
    `This is a real side room shared by ${cast.names}. Stay in character and respond to the owner naturally.`,
    'This is a game turn, not a software task. Do not inspect or edit code.',
    `What just happened: ${eventSummary}`,
    `Match: ${game.id}`,
    `State: ${game.status}; turn: ${game.turn}; winner: ${game.winner ?? 'none'}.`,
    `${ownerDisplayName(true)}'s shots against your sealed fleet: ${ownerShots}.`,
    `Your own fleet health: ${fleetHealth}.`,
    `Companion shots already called: ${previousShots}.`,
    mustFire
      ? `It is your turn: ONE shot for the whole table, from this unused set: ${availableCoordinates.join(', ')}. Whoever of you speaks first fires it; if you are told a shot already landed this turn, do not fire again — just react to it.`
      : 'It is not your firing turn. Do not call a coordinate.',
    mustFire
      ? `Before writing the spoken reply, fire exactly one shot: call the battleship_fire tool with {"gameId":"${game.id}","companion":"<${cast.slugs}>","coordinate":"<A1-H8>"}, or with a shell, your sc tool's \`battleship fire ${game.id} <A1-H8> --as <your slug>\` (it POSTs to http://127.0.0.1:${port}/api/internal/games/battleship/fire).`
      : '',
    mustFire
      ? 'Use only that sealed endpoint. Never inspect the owner board route, database, files, or source for coordinates. Read the returned hit/miss/sunk result and react to it in the room.'
      : '',
    'Your final spoken reply is automatically written into the Fleet Room rail. Do not call the battleship chat endpoint.',
    'Use the normal bold sigil headers for whoever speaks. Keep it lively and readable: real table talk, not a technical report. Any of you may speak, but a quick game beat need not become a monologue.',
  ].filter(Boolean).join('\n');

  return { threadId: game.threadId, prompt, view: publicView(game) };
}

export function finishBattleshipCompanionResponse(id: string, error?: string | null): BattleshipView {
  const game = activeGame(id);
  const now = new Date().toISOString();
  const missingShot = !error && game.status === 'playing' && game.turn === 'companions';
  const settledError = error?.trim()
    || (missingShot ? 'The chart table answered without a shot landing. Send another rail message to call the companions back.' : null);
  getDb().prepare(`
    UPDATE battleship_games
    SET companion_pending = 0, companion_error = ?, updated_at = ?
    WHERE id = ?
  `).run(settledError, now, game.id);
  return publicView(gameById(game.id));
}

export function getBattleshipCompanionView(id?: string): {
  gameId: string;
  status: BattleshipStatus;
  turn: BattleshipTurn;
  winner: BattleshipWinner;
  shotsByOwner: BattleshipShot[];
  shotsByCompanions: BattleshipShot[];
  fleetHealth: Array<{ name: string; length: number; remaining: number; sunk: boolean }>;
  log: BattleshipLogEntry[];
} {
  const game = activeGame(id);
  const hits = new Set(game.playerShots.filter((shot) => shot.result !== 'miss').map((shot) => shot.coordinate));
  return {
    gameId: game.id,
    status: game.status,
    turn: game.turn,
    winner: game.winner,
    shotsByOwner: game.playerShots,
    shotsByCompanions: game.companionShots,
    fleetHealth: game.companionFleet.map((ship) => {
      const remaining = ship.cells.filter((cell) => !hits.has(cell)).length;
      return { name: ship.name, length: ship.length, remaining, sunk: remaining === 0 };
    }),
    log: listLog(game.id),
  };
}
