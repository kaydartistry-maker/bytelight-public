// history-index.ts — a local search index over the person's imported chats.
//
// Every message of an imported chat export (ChatGPT, Claude and the others the
// import screen reads), cut into pieces and fingerprinted with the same small
// model the house already uses for chat search (embeddings-worker.ts), so a
// moment from an old chat can be found by meaning, for free, on this machine.
// No outside service, no key, no model call.
//
// The builder takes its passages from a page source (BuildDeps.fetchPage), so
// what feeds it can change without touching the index.
//
// One owner per index (meta 'voice'): an index stamped for someone else is
// refused rather than mixed, so one house's history never speaks in another's.
//
// The index is only ever replaced whole: the build works in a copy and renames
// it into place, so a reader never opens half an index.

import Database from 'better-sqlite3';
import { copyFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../config.js';

/** Where the house keeps the index. */
export const HISTORY_INDEX_PATH = process.env.HISTORY_INDEX_PATH || join(PROJECT_ROOT, 'data', 'history-index.db');

/** About this long, cut where a reader would pause. */
export const PIECE_TARGET = 950;
/** Shorter than this alone carries no moment worth finding. */
export const PIECE_MIN = 20;

const FENCE = /```[\s\S]*?```/g;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;

/**
 * One message, cut into pieces of about PIECE_TARGET characters: at blank
 * lines first, then at sentence ends, and only mid-sentence when one sentence
 * runs on far past the target. Code blocks are not anything anybody said and
 * become "[code]"; image links are dropped.
 */
export function cutPieces(text: string): string[] {
  const body = text.replace(FENCE, ' [code] ').replace(IMAGE, ' ').replace(/[ \t]+/g, ' ').trim();
  if (body.length < PIECE_MIN) return [];
  if (body.length <= PIECE_TARGET) return [body];
  const out: string[] = [];
  let cur = '';
  const flush = () => {
    const t = cur.trim();
    if (t.length >= PIECE_MIN) out.push(t);
    cur = '';
  };
  const add = (piece: string, sep: string) => {
    if (cur && cur.length + sep.length + piece.length > PIECE_TARGET) flush();
    cur = cur ? `${cur}${sep}${piece}` : piece;
  };
  for (const para of body.split(/\n\s*\n/)) {
    const sentences = para.length > PIECE_TARGET ? para.split(/(?<=[.!?])\s+/) : [para];
    let first = true;
    for (let s of sentences) {
      while (s.length > PIECE_TARGET * 1.5) {
        flush();
        cur = s.slice(0, PIECE_TARGET);
        flush();
        s = s.slice(PIECE_TARGET);
      }
      add(s, first ? '\n\n' : ' ');
      first = false;
    }
  }
  flush();
  return out;
}

/** One message of an imported chat, as a page source hands it over. */
export interface HistoryPassage {
  cursor: number;
  id: string;
  chat: string;
  title: string;
  voice: string;
  role: 'user' | 'assistant';
  at: string | null;
  body: string;
}

export interface HistoryPage {
  rows: HistoryPassage[];
  next: number;
  done: boolean;
}

export interface BuildDeps {
  /** One page of passages for this owner, after a cursor. */
  fetchPage: (voice: string, after: number) => Promise<HistoryPage>;
  embed: (text: string) => Promise<Float32Array>;
  indexPath?: string;
  onProgress?: (p: BuildProgress) => void;
}

export interface BuildProgress {
  passages: number;
  pieces: number;
  cursor: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pieces (
    id INTEGER PRIMARY KEY,
    passage_id TEXT NOT NULL,
    chat TEXT NOT NULL,
    title TEXT NOT NULL,
    role TEXT NOT NULL,
    at TEXT,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pieces_passage ON pieces(passage_id);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export const INDEX_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';

/**
 * Bring the index up to date with a page source for one owner.
 *
 * Starts from the cursor the index last reached, so a later import only costs
 * its own passages. `rebuild` starts from nothing. Work happens in a copy that
 * is swapped in whole at the end; an interrupted build leaves the old index
 * exactly as it was. A passage already in the index is never added twice.
 */
export async function buildHistoryIndex(voice: string, deps: BuildDeps, opts: { rebuild?: boolean } = {}): Promise<BuildProgress & { total: number }> {
  if (!/^[a-z0-9-]{1,40}$/.test(voice)) throw new Error(`not a voice: ${voice}`);
  const finalPath = deps.indexPath ?? HISTORY_INDEX_PATH;
  const tmp = `${finalPath}.building`;
  if (existsSync(tmp)) unlinkSync(tmp);
  if (!opts.rebuild && existsSync(finalPath)) copyFileSync(finalPath, tmp);
  const db = new Database(tmp);
  const progress: BuildProgress = { passages: 0, pieces: 0, cursor: 0 };
  try {
    db.exec(SCHEMA);
    const meta = (key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const builtFor = meta('voice');
    if (builtFor && builtFor !== voice) throw new Error(`this index holds the voice '${builtFor}', not '${voice}'`);
    const builtWith = meta('model');
    if (builtWith && builtWith !== INDEX_MODEL) throw new Error(`this index was built with ${builtWith}; rebuild it`);
    setMeta.run('voice', voice);
    setMeta.run('model', INDEX_MODEL);

    let cursor = Number(meta('cursor') ?? 0) || 0;
    const seen = db.prepare('SELECT 1 FROM pieces WHERE passage_id = ? LIMIT 1');
    const insert = db.prepare('INSERT INTO pieces (passage_id, chat, title, role, at, text, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (;;) {
      const page = await deps.fetchPage(voice, cursor);
      const rows: unknown[][] = [];
      for (const p of page.rows) {
        if (p.voice !== voice) throw new Error(`the source handed back a '${p.voice}' passage for '${voice}'`);
        progress.passages++;
        if (seen.get(p.id)) continue;
        for (const text of cutPieces(p.body)) {
          const v = await deps.embed(text);
          rows.push([p.id, p.chat, p.title, p.role, p.at, text, Buffer.from(v.buffer, v.byteOffset, v.byteLength)]);
        }
      }
      const nextCursor = page.next;
      db.transaction(() => {
        for (const r of rows) insert.run(...r);
        setMeta.run('cursor', String(nextCursor));
      })();
      progress.pieces += rows.length;
      progress.cursor = cursor = nextCursor;
      deps.onProgress?.({ ...progress });
      if (page.done || page.rows.length === 0) break;
    }
    setMeta.run('built_at', new Date().toISOString());
    const total = (db.prepare('SELECT count(*) AS n FROM pieces').get() as { n: number }).n;
    db.close();
    renameSync(tmp, finalPath);
    return { ...progress, total };
  } catch (err) {
    try { db.close(); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw err;
  }
}
