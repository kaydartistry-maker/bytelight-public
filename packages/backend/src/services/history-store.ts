// history-store.ts — where a house keeps the words of the chats it imports.
//
// One shape, two homes, and a house uses exactly one of them:
//
//   local  data/history-passages.db on this machine (history-passages.ts).
//          Every house can use it; nothing leaves the machine.
//   brain  the Neuralis brain the house is connected to (its /api/history
//          door). The words then live only in the brain and travel with it,
//          never also on this machine.
//
// Which one is decided by configuration, not by luck: a house with a brain
// URL and key whose history door can read chats back uses the brain; any
// other house uses the local file. A brain that is configured but does not
// answer is an error, never a quiet switch to the local file, because the
// search index (history-index.ts) follows one home's cursor and must never be
// fed from the other.
//
// The importer (history-import.ts) and the reading screens
// (routes/history-import-routes.ts) only ever see this shape.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { HistoryPage } from './history-index.js';
import { HISTORY_PASSAGES_PATH, PassageStore, type ChatIn, type ChatList, type ChatRead } from './history-passages.js';
import { getSecret } from './secrets.js';

export interface HistoryStore {
  readonly kind: 'local' | 'brain';
  /** Store one chat's kept messages. Returns how many were new (a repeat adds nothing). */
  addChat(chat: ChatIn): Promise<number>;
  /** Stored passages after a cursor, for the index builder. */
  page(voice: string, after: number): Promise<HistoryPage>;
  /** How many passages sit after a cursor: the work left for the index. */
  countAfter(voice: string, after: number): Promise<number>;
  /** The stored chats, newest first, a page at a time, by app or by their words. */
  chats(voice: string, opts?: { source?: string; q?: string; limit?: number; offset?: number }): Promise<ChatList>;
  /** One stored chat in the order it was said, or null. */
  chat(voice: string, source: string, chat: string): Promise<ChatRead | null>;
  close(): void;
}

// ── Local ────────────────────────────────────────────────────────────────────

/** The local file. With `onlyIfThere`, a house that never imported reads as empty instead of making the file. */
export function localStore(path: string = HISTORY_PASSAGES_PATH, opts: { onlyIfThere?: boolean } = {}): HistoryStore {
  let store: PassageStore | null = null;
  const open = () => (store ??= new PassageStore(path));
  const there = () => store !== null || !opts.onlyIfThere || existsSync(path);
  return {
    kind: 'local',
    addChat: async (chat) => open().addChat(chat),
    page: async (voice, after) => (there() ? open().page(voice, after) : { rows: [], next: after, done: true }),
    countAfter: async (voice, after) => (there() ? open().countAfter(voice, after) : 0),
    chats: async (voice, o) => (there() ? open().chats(voice, o) : { total: 0, chats: [], sources: [] }),
    chat: async (voice, source, chat) => (there() ? open().chat(voice, source, chat) : null),
    close: () => { store?.close(); store = null; },
  };
}

// ── Brain ────────────────────────────────────────────────────────────────────

/** The oldest brain history door that can read chats back (GET chats, chat, count). */
export const BRAIN_HISTORY_VERSION = 3;
/** The brain's own limits (neuralis worker history/archive.ts). */
const BRAIN_BATCH_LINES = 8;
const BRAIN_BATCH_BYTES = 90_000;
const BRAIN_MESSAGE_CHARS = 60_000;
const BRAIN_TITLE_CHARS = 300;
const BRAIN_ID = /^[\w-]{1,128}$/;

/**
 * An export's own id as the brain will take it. Most already fit; any other
 * becomes a stable fingerprint of itself, so a repeat import still lands on
 * the same id and adds nothing.
 */
export function brainId(id: string): string {
  return BRAIN_ID.test(id) ? id : `h${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
}

/**
 * One chat's lines as the brain will take them. The brain refuses a message
 * longer than its limit rather than cut it, so a very long one is sent as
 * consecutive parts, linked in order, with every word kept.
 */
export function brainLines(lines: ChatIn['lines']): Array<{ id: string; prev: string | null; pos: number; role: string; at: string | null; text: string }> {
  const out: Array<{ id: string; prev: string | null; pos: number; role: string; at: string | null; text: string }> = [];
  for (const l of lines) {
    const id = brainId(l.id);
    const parts: string[] = [];
    for (let i = 0; i < l.text.length; i += BRAIN_MESSAGE_CHARS) parts.push(l.text.slice(i, i + BRAIN_MESSAGE_CHARS));
    parts.forEach((text, n) => {
      if (!text.trim()) return;
      out.push({ id: n === 0 ? id : brainId(`${id}-part${n + 1}`), prev: out.length ? out[out.length - 1].id : null, pos: out.length, role: l.role, at: l.at, text });
    });
  }
  return out;
}

/** Cut lines into batches the brain accepts: at most 8 lines and about 90 KB each. */
export function brainBatches<T extends { text: string }>(lines: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const l of lines) {
    const size = Buffer.byteLength(l.text) + 400;
    if (cur.length && (cur.length >= BRAIN_BATCH_LINES || bytes + size > BRAIN_BATCH_BYTES)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(l);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

type Fetch = typeof fetch;

export function brainStore(url: string, key: string, opts: { fetch?: Fetch } = {}): HistoryStore {
  const base = `${url.replace(/\/+$/, '')}/api/history`;
  const doFetch = opts.fetch ?? fetch;
  const headers = { Authorization: `Bearer ${key}`, 'User-Agent': 'bytelight-history/1' };

  async function call<T>(path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      let detail = '';
      try {
        const res = await doFetch(`${base}/${path}`, body === undefined
          ? { headers }
          : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (res.ok) return (await res.json()) as T;
        status = res.status;
        detail = (await res.text()).slice(0, 200);
        if (status === 404 && path.startsWith('chat?')) return null as T;
        if (status < 500 && status !== 429) throw new Error(`The brain refused that (${status}): ${detail}`);
      } catch (err) {
        if (status && status < 500 && status !== 429) throw err;
        if (attempt >= 3) throw new Error(`The brain is not answering right now${err instanceof Error ? ` (${err.message})` : ''}.`);
      }
      if (attempt >= 3) throw new Error(`The brain is not answering right now (${status}).`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }

  const q = (o: Record<string, string | number | undefined | null>) =>
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

  return {
    kind: 'brain',
    async addChat(chat) {
      const lines = brainLines(chat.lines);
      const head = { source: chat.source, chat: brainId(chat.chat), title: (chat.title.trim() || 'Untitled').slice(0, BRAIN_TITLE_CHARS), voice: chat.voice };
      let added = 0;
      for (const batch of brainBatches(lines)) {
        const r = await call<{ added?: number }>('batch', { ...head, lines: batch });
        added += Number(r.added ?? 0);
      }
      return added;
    },
    page: (voice, after) => call<HistoryPage>(`passages?${q({ voice, after, limit: 200 })}`),
    countAfter: async (voice, after) => Number((await call<{ n: number }>(`count?${q({ voice, after })}`)).n ?? 0),
    chats: (voice, o = {}) => call<ChatList>(`chats?${q({ voice, source: o.source, q: o.q, limit: o.limit, offset: o.offset })}`),
    chat: (voice, source, chat) => call<ChatRead | null>(`chat?${q({ voice, source, chat })}`),
    close: () => { /* nothing held open */ },
  };
}

// ── Choosing ─────────────────────────────────────────────────────────────────

let decided: 'local' | 'brain' | null = null;

/**
 * The house's store. A brain is used when its URL and key are set and its
 * history door can read chats back; a brain without that door (an older
 * Neuralis) leaves the house on its local file. A configured brain that does
 * not answer throws, so nothing is written to the wrong home.
 */
export async function openHistoryStore(opts: { fetch?: Fetch; localPath?: string } = {}): Promise<HistoryStore> {
  const url = getSecret('mind_api_url');
  const key = getSecret('mind_api_key');
  if (!url || !key) return localStore(opts.localPath, { onlyIfThere: true });
  if (decided === null) {
    const doFetch = opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${url.replace(/\/+$/, '')}/api/history/ready`, { headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'bytelight-history/1' } });
    } catch (err) {
      throw new Error(`The brain is not answering right now${err instanceof Error ? ` (${err.message})` : ''}.`);
    }
    if (res.status >= 500 || res.status === 429 || res.status === 401 || res.status === 403) {
      throw new Error(`The brain is not answering right now (${res.status}).`);
    }
    const ready = res.ok ? ((await res.json().catch(() => ({}))) as { version?: number; voices?: boolean }) : {};
    decided = Number(ready.version) >= BRAIN_HISTORY_VERSION && ready.voices === true ? 'brain' : 'local';
  }
  return decided === 'brain' ? brainStore(url, key, { fetch: opts.fetch }) : localStore(opts.localPath, { onlyIfThere: true });
}

/** Test seam: forget which home was chosen. */
export function resetHistoryStoreChoice(): void {
  decided = null;
}
