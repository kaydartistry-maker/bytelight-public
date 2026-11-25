/**
 * The four house shapes every change must keep working (Phase 1.5).
 *
 *   empty  — a fresh install: no companions, no threads.
 *   solo   — one resident on his own brain (a single-companion node).
 *   pair   — two residents sharing one brain (the original house shape).
 *   room   — the pair plus a visitor from another node, all three seated in a
 *            shared thread.
 *
 * Every shape is built through the real migrations (initDb), never through
 * hand-written tables. Fixture names only.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';

import { createThread, getDb, initDb, setRoutingThreadId } from '../services/db.js';

export interface HouseShape {
  name: 'empty' | 'solo' | 'pair' | 'room';
  /** The brain this house runs turns for (BYTELIGHT_LOCAL_BRAIN_ID). */
  localBrain: string;
  companions: ReadonlyArray<{ id: string; name: string; brain: string }>;
  /** Who sits in the house's main thread ('main'), if it has one. */
  seated: readonly string[];
  /** Residents: companions on the local brain, picker order. */
  residents: readonly string[];
  /** Brains the dispatcher should plan for the main thread. */
  dispatch: readonly string[];
}

export const HOUSE_SHAPES: readonly HouseShape[] = [
  { name: 'empty', localBrain: 'companion-a-b', companions: [], seated: [], residents: [], dispatch: [] },
  {
    name: 'solo', localBrain: 'solo-brain',
    companions: [{ id: 'orion', name: 'Orion', brain: 'solo-brain' }],
    seated: ['orion'], residents: ['orion'], dispatch: ['solo-brain'],
  },
  {
    name: 'pair', localBrain: 'companion-a-b',
    companions: [{ id: 'companion-a', name: 'Companion A', brain: 'companion-a-b' }, { id: 'companion-b', name: 'Companion B', brain: 'companion-a-b' }],
    seated: ['companion-a', 'companion-b'], residents: ['companion-a', 'companion-b'], dispatch: ['companion-a-b'],
  },
  {
    name: 'room', localBrain: 'companion-a-b',
    companions: [
      { id: 'companion-a', name: 'Companion A', brain: 'companion-a-b' },
      { id: 'companion-b', name: 'Companion B', brain: 'companion-a-b' },
      { id: 'visitor', name: 'Visitor', brain: 'visitor-brain' },
    ],
    seated: ['companion-a', 'companion-b', 'visitor'], residents: ['companion-a', 'companion-b'], dispatch: ['companion-a-b', 'visitor-brain'],
  },
];

let sequence = 0;
const root = mkdtempSync(join(tmpdir(), 'house-shapes-'));

/** Build a shape on disk through the migrations and make it the open DB. */
export function buildHouse(shape: HouseShape): { db: Database.Database; path: string } {
  try { getDb().close(); } catch { /* none open */ }
  process.env.BYTELIGHT_LOCAL_BRAIN_ID = shape.localBrain;
  const path = join(root, `${shape.name}-${sequence++}.db`);
  const db = initDb(path);
  const insert = db.prepare('INSERT INTO companions (id, display_name, brain, slug, sort_order) VALUES (?, ?, ?, ?, ?)');
  shape.companions.forEach((c, i) => insert.run(c.id, c.name, c.brain, c.id, i));
  if (shape.seated.length > 0) {
    const [first, ...rest] = shape.seated;
    createThread({ id: 'main', name: 'Main', type: 'named', createdAt: new Date().toISOString(), companionIds: [first, ...rest] });
    setRoutingThreadId('main');
  }
  return { db, path };
}

/** Re-open the same file, as a reboot would. */
export function rebootHouse(path: string): Database.Database {
  try { getDb().close(); } catch { /* none open */ }
  return initDb(path);
}
