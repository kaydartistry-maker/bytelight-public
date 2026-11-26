// history-recall.ts — reading the old-chat index during a turn.
//
// The index (history-index.ts, data/history-index.db) holds pieces of the
// person's imported chats, fingerprinted with the house's own model. This
// module loads it into memory and finds the one piece closest to what was
// just said, for the whisper's old-window lane (heartbeat/whisper.ts).
//
// Held small: each vector is kept as int8 with one scale, about a quarter of
// float32, and the piece text stays on disk until a hit needs it. A scan over
// every vector is exact and, at tens of thousands of pieces, takes tens of
// milliseconds.
//
// Reloaded when the file changes (a finished build swaps a new one in), and
// fail-quiet throughout: a missing or unreadable index means no old windows,
// never an error inside a turn.

import Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import { HISTORY_INDEX_PATH, INDEX_MODEL } from './history-index.js';
import { getConfig } from './db/config.js';

/** Turn the lane off with config history.old_windows = 'false'. On otherwise. */
export const OLD_WINDOWS_KEY = 'history.old_windows';

export function oldWindowsEnabled(): boolean {
  try {
    return getConfig(OLD_WINDOWS_KEY) !== 'false';
  } catch {
    return true;
  }
}

export interface OldWindowHit {
  /** Row id in the index, stable for the life of the index. */
  id: number;
  passageId: string;
  title: string;
  role: 'user' | 'assistant';
  at: string | null;
  text: string;
  similarity: number;
}

interface Loaded {
  path: string;
  mtimeMs: number;
  voice: string;
  ids: Int32Array;
  dim: number;
  /** int8 vectors, row after row. */
  q: Int8Array;
  /** One scale per row: value ≈ q * scale. Rows are unit length before quantizing. */
  scale: Float32Array;
  db: Database.Database;
}

let loaded: Loaded | null = null;
let lastCheck = 0;
const RECHECK_MS = 30_000;

function close(): void {
  try { loaded?.db.close(); } catch { /* already closed */ }
  loaded = null;
}

function load(path: string): Loaded | null {
  if (!existsSync(path)) { close(); return null; }
  const mtimeMs = statSync(path).mtimeMs;
  if (loaded && loaded.path === path && loaded.mtimeMs === mtimeMs) return loaded;
  close();
  const db = new Database(path, { readonly: true, fileMustExist: true });
  const meta = (key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  if (meta('model') !== INDEX_MODEL) { db.close(); return null; }
  const voice = meta('voice') ?? '';
  const count = (db.prepare('SELECT count(*) AS n FROM pieces').get() as { n: number }).n;
  const ids = new Int32Array(count);
  const scale = new Float32Array(count);
  let dim = 0;
  let q = new Int8Array(0);
  let i = 0;
  for (const row of db.prepare('SELECT id, embedding FROM pieces ORDER BY id').iterate() as Iterable<{ id: number; embedding: Buffer }>) {
    const v = new Float32Array(row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength));
    if (!dim) { dim = v.length; q = new Int8Array(count * dim); }
    if (v.length !== dim) continue;
    let norm = 0;
    for (let k = 0; k < dim; k++) norm += v[k] * v[k];
    norm = Math.sqrt(norm) || 1;
    let max = 0;
    for (let k = 0; k < dim; k++) max = Math.max(max, Math.abs(v[k] / norm));
    const s = max / 127 || 1;
    for (let k = 0; k < dim; k++) q[i * dim + k] = Math.round(v[k] / norm / s);
    scale[i] = s;
    ids[i] = row.id;
    i++;
  }
  loaded = { path, mtimeMs, voice, ids: ids.subarray(0, i), dim, q, scale: scale.subarray(0, i), db };
  return loaded;
}

function current(path: string): Loaded | null {
  const now = Date.now();
  if (loaded && loaded.path === path && now - lastCheck < RECHECK_MS) return loaded;
  lastCheck = now;
  try {
    return load(path);
  } catch (err) {
    close();
    console.warn('[history-recall] index unreadable, no old windows until it is rebuilt:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * The closest piece to `query` at or above `threshold`, skipping ids in
 * `exclude`, or null. Only answers when the index holds `voice`, so a turn
 * can never be handed another companion's history.
 */
export function bestOldWindow(
  query: Float32Array,
  voice: string,
  threshold: number,
  exclude: ReadonlySet<number> = new Set(),
  path: string = HISTORY_INDEX_PATH,
): OldWindowHit | null {
  const idx = current(path);
  if (!idx || idx.voice !== voice || !idx.ids.length || query.length !== idx.dim) return null;
  let qn = 0;
  for (let k = 0; k < idx.dim; k++) qn += query[k] * query[k];
  qn = Math.sqrt(qn) || 1;
  let best = -1;
  let bestSim = -Infinity;
  for (let i = 0; i < idx.ids.length; i++) {
    if (exclude.has(idx.ids[i])) continue;
    let dot = 0;
    const base = i * idx.dim;
    for (let k = 0; k < idx.dim; k++) dot += idx.q[base + k] * query[k];
    const sim = (dot * idx.scale[i]) / qn;
    if (sim > bestSim) { bestSim = sim; best = i; }
  }
  if (best < 0 || bestSim < threshold) return null;
  const row = idx.db.prepare('SELECT id, passage_id, title, role, at, text FROM pieces WHERE id = ?').get(idx.ids[best]) as
    { id: number; passage_id: string; title: string; role: 'user' | 'assistant'; at: string | null; text: string } | undefined;
  if (!row) return null;
  return { id: row.id, passageId: row.passage_id, title: row.title, role: row.role, at: row.at, text: row.text, similarity: bestSim };
}

/** What the index holds, for the settings screen: pieces and when it was built. */
export function historyIndexStats(path: string = HISTORY_INDEX_PATH): { pieces: number; builtAt: string | null } | null {
  try {
    if (!existsSync(path)) return null;
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const pieces = (db.prepare('SELECT count(*) AS n FROM pieces').get() as { n: number }).n;
      const builtAt = (db.prepare("SELECT value FROM meta WHERE key = 'built_at'").get() as { value: string } | undefined)?.value ?? null;
      return { pieces, builtAt };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Test seam: forget the loaded index so the next call reads the file again. */
export function resetHistoryRecall(): void {
  close();
  lastCheck = 0;
}
