// history-passages.ts — the house's own copy of the person's imported chats.
//
// Every message kept from an imported export, word for word, in the order it
// was said, with its own time and a link to the message before it. This file
// is the record; the search index (history-index.ts) is built from it and can
// be thrown away and rebuilt from it at any time.
//
// Kept on this machine only (data/history-passages.db). Nothing here calls a
// model or leaves the house. The person can read their chats back from here
// (chats, chat), a page at a time or by searching their words.

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import type { HistoryPage } from './history-index.js';

export const HISTORY_PASSAGES_PATH = process.env.HISTORY_PASSAGES_PATH || join(PROJECT_ROOT, 'data', 'history-passages.db');

/** One message on the way in. `id` and `prev` are the export's own ids. */
export interface PassageIn {
  id: string;
  prev: string | null;
  pos: number;
  role: 'user' | 'assistant';
  at: string | null;
  text: string;
}

export interface ChatIn {
  source: string;
  chat: string;
  title: string;
  voice: string;
  lines: PassageIn[];
}

export interface ChatSummary { source: string; chat: string; title: string; startedAt: string | null; messages: number; snippet?: string }
export interface ChatList { total: number; chats: ChatSummary[]; sources: { source: string; chats: number }[] }
export interface ChatRead { source: string; chat: string; title: string; lines: { role: 'user' | 'assistant'; at: string | null; text: string }[] }

/** A short stretch of `body` around the first place `q` appears, for a search result. */
export function snippetAround(body: string, q: string, width = 140): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const i = flat.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0 || flat.length <= width) return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
  const start = Math.max(0, Math.min(i - Math.floor((width - q.length) / 2), flat.length - width));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + width).trim()}${start + width < flat.length ? '…' : ''}`;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS passages (
    id TEXT PRIMARY KEY,          -- "<source>:<chat id>:<message id>"
    source TEXT NOT NULL,
    chat TEXT NOT NULL,
    title TEXT NOT NULL,
    voice TEXT NOT NULL,
    pos INTEGER NOT NULL,
    role TEXT NOT NULL,
    at TEXT,
    body TEXT NOT NULL,
    prev TEXT
  );
  CREATE INDEX IF NOT EXISTS passages_chat ON passages(source, chat, pos);
`;

export class PassageStore {
  readonly db: Database.Database;
  private insert: Database.Statement;

  constructor(path: string = HISTORY_PASSAGES_PATH) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.insert = this.db.prepare(
      `INSERT INTO passages (id, source, chat, title, voice, pos, role, at, body, prev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    );
  }

  /** Store one chat's kept messages. A message already stored keeps its first copy. Returns how many were new. */
  addChat(chat: ChatIn): number {
    const prefix = `${chat.source}:${chat.chat}:`;
    let added = 0;
    this.db.transaction(() => {
      for (const l of chat.lines) {
        const r = this.insert.run(prefix + l.id, chat.source, chat.chat, chat.title, chat.voice, l.pos, l.role, l.at, l.text, l.prev ? prefix + l.prev : null);
        added += r.changes;
      }
    })();
    return added;
  }

  /** Stored passages after a cursor (SQLite rowid, only ever grows), for the index builder. */
  page(voice: string, after: number, limit = 200): HistoryPage {
    const rows = this.db.prepare(
      `SELECT rowid AS cursor, id, chat, title, voice, role, at, body FROM passages
        WHERE rowid > ? AND voice = ? ORDER BY rowid LIMIT ?`,
    ).all(after, voice, limit) as HistoryPage['rows'];
    return { rows, next: rows.length ? rows[rows.length - 1].cursor : after, done: rows.length < limit };
  }

  /** How many passages sit after a cursor: the work left for the index. */
  countAfter(voice: string, after: number): number {
    return (this.db.prepare('SELECT count(*) AS n FROM passages WHERE rowid > ? AND voice = ?').get(after, voice) as { n: number }).n;
  }

  // ── Reading the chats back ────────────────────────────────────────────────

  /**
   * The stored chats, newest first, a page at a time: optionally from one app,
   * optionally only those whose title or words hold `q`. Also says how many
   * chats each app has, for the chips.
   */
  chats(voice: string, opts: { source?: string; q?: string; limit?: number; offset?: number } = {}): ChatList {
    const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
    const offset = Math.max(0, opts.offset ?? 0);
    const q = (opts.q ?? '').trim();
    const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const where = ['voice = @voice'];
    if (opts.source) where.push('source = @source');
    if (like) where.push(`(source, chat) IN (SELECT source, chat FROM passages WHERE voice = @voice AND (body LIKE @like ESCAPE '\\' OR title LIKE @like ESCAPE '\\'))`);
    const params = { voice, source: opts.source ?? null, like };
    const total = (this.db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM passages WHERE ${where.join(' AND ')} GROUP BY source, chat)`).get(params) as { n: number }).n;
    const rows = this.db.prepare(
      `SELECT source, chat, max(title) AS title, min(at) AS startedAt, count(*) AS messages
         FROM passages WHERE ${where.join(' AND ')}
        GROUP BY source, chat
        ORDER BY startedAt IS NULL, startedAt DESC, source, chat
        LIMIT @limit OFFSET @offset`,
    ).all({ ...params, limit, offset }) as ChatSummary[];
    if (like) {
      const hit = this.db.prepare(
        `SELECT body FROM passages WHERE voice = @voice AND source = @source AND chat = @chat AND body LIKE @like ESCAPE '\\' ORDER BY pos, rowid LIMIT 1`,
      );
      for (const r of rows) {
        const h = hit.get({ voice, source: r.source, chat: r.chat, like }) as { body: string } | undefined;
        if (h) r.snippet = snippetAround(h.body, q);
      }
    }
    const sources = this.db.prepare(
      'SELECT source, count(DISTINCT chat) AS chats FROM passages WHERE voice = ? GROUP BY source ORDER BY chats DESC',
    ).all(voice) as { source: string; chats: number }[];
    return { total, chats: rows, sources };
  }

  /** One stored chat, every message in the order it was said. Null when it is not here. */
  chat(voice: string, source: string, chat: string): ChatRead | null {
    const lines = this.db.prepare(
      'SELECT title, role, at, body FROM passages WHERE voice = ? AND source = ? AND chat = ? ORDER BY pos, rowid',
    ).all(voice, source, chat) as { title: string; role: 'user' | 'assistant'; at: string | null; body: string }[];
    if (!lines.length) return null;
    return { source, chat, title: lines[0].title, lines: lines.map(({ role, at, body }) => ({ role, at, text: body })) };
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}
