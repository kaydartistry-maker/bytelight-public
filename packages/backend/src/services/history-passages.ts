// history-passages.ts — the house's own copy of the person's imported chats.
//
// Every message kept from an imported export, word for word, in the order it
// was said, with its own time and a link to the message before it. This file
// is the record; the search index (history-index.ts) is built from it and can
// be thrown away and rebuilt from it at any time.
//
// Kept on this machine only (data/history-passages.db). Nothing here calls a
// model or leaves the house.

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

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}
