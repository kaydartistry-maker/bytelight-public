// history-import.ts — bringing an old chat export into the house.
//
// Two steps, and the first one never writes:
//
//   preview  reads the export and says what is in it: which app made it, how
//            many chats and messages, how many abandoned drafts would be left
//            out, and which months it covers.
//   import   stores the kept messages word for word (history-passages.ts),
//            then brings the search index up to date from them
//            (history-index.ts), in the background, one import at a time.
//
// Running the same export twice adds nothing. An import can be limited to
// one month, to try a small piece first.

import { existsSync, statSync, unlinkSync } from 'node:fs';
import { buildHistoryIndex, HISTORY_INDEX_PATH } from './history-index.js';
import { PassageStore, HISTORY_PASSAGES_PATH } from './history-passages.js';
import { detectSource, readChat, readExportElements, READABLE, SOURCE_LABEL, type ExportSource } from './history-readers.js';
import Database from 'better-sqlite3';

/** Whose history the house index holds (heartbeat/whisper.ts OLD_WINDOW_VOICE). */
export const HOUSE_VOICE = 'house';

export interface MonthCount { chats: number; messages: number; dropped: number }

export interface PreviewChat { title: string; startedAt: string | null; messages: number }

export interface ImportPreview {
  source: ExportSource;
  sourceLabel: string;
  readable: boolean;
  chats: number;
  messages: number;
  dropped: number;
  /** Per month the chat started in ('YYYY-MM', or 'undated'): its chats, messages and dropped drafts. */
  months: Record<string, MonthCount>;
  /** A few chats, newest first, so the person can recognise the export. */
  sample: PreviewChat[];
}

const monthOf = (iso: string | null) => (iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : 'undated');

function assertFile(path: string): void {
  if (!path || !existsSync(path) || !statSync(path).isFile()) throw new Error('That file is not there.');
  if (!/\.(zip|json)$/i.test(path)) throw new Error('Pick the export zip, or the conversations.json inside it.');
}

/** Read an export and describe it. Writes nothing. */
export async function previewExport(path: string, opts: { month?: string } = {}): Promise<ImportPreview> {
  assertFile(path);
  let source: ExportSource | null = null;
  const p: ImportPreview = { source: 'unknown', sourceLabel: SOURCE_LABEL.unknown, readable: false, chats: 0, messages: 0, dropped: 0, months: {}, sample: [] };
  const sample: PreviewChat[] = [];
  await readExportElements(path, (raw) => {
    if (!source) {
      source = detectSource(raw);
      p.source = source;
      p.sourceLabel = SOURCE_LABEL[source];
      p.readable = READABLE.has(source);
    }
    if (!p.readable) return;
    const chat = readChat(source, raw);
    if (!chat) return;
    const month = monthOf(chat.startedAt);
    const m = (p.months[month] ??= { chats: 0, messages: 0, dropped: 0 });
    m.chats++;
    m.messages += chat.lines.length;
    m.dropped += chat.dropped;
    if (opts.month && month !== opts.month) return;
    p.chats++;
    p.messages += chat.lines.length;
    p.dropped += chat.dropped;
    sample.push({ title: chat.title, startedAt: chat.startedAt, messages: chat.lines.length });
    if (sample.length > 40) {
      sample.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
      sample.length = 5;
    }
  });
  sample.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  p.sample = sample.slice(0, 5);
  return p;
}

// ── The import job ───────────────────────────────────────────────────────────

export type ImportState = 'idle' | 'reading' | 'indexing' | 'done' | 'failed';

export interface ImportStatus {
  state: ImportState;
  sourceLabel: string | null;
  month: string | null;
  /** Reading: chats read, and messages newly stored (a repeat stores nothing). */
  chats: number;
  stored: number;
  dropped: number;
  /** Indexing: messages fingerprinted out of those waiting. */
  indexed: number;
  toIndex: number;
  pieces: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

const idle = (): ImportStatus => ({
  state: 'idle', sourceLabel: null, month: null, chats: 0, stored: 0, dropped: 0,
  indexed: 0, toIndex: 0, pieces: 0, startedAt: null, finishedAt: null, error: null,
});

let status: ImportStatus = idle();

export function importStatus(): ImportStatus {
  return { ...status };
}

export interface ImportDeps {
  embed: (text: string) => Promise<Float32Array>;
  passagesPath?: string;
  indexPath?: string;
  /** Remove this file when the import has finished well (an upload the house made). */
  removeAfter?: boolean;
}

function indexCursor(indexPath: string): number {
  if (!existsSync(indexPath)) return 0;
  try {
    const db = new Database(indexPath, { readonly: true, fileMustExist: true });
    try {
      return Number((db.prepare("SELECT value FROM meta WHERE key = 'cursor'").get() as { value: string } | undefined)?.value ?? 0) || 0;
    } finally { db.close(); }
  } catch { return 0; }
}

/**
 * Start an import in the background. Throws at once if one is already running
 * or the file is not there; everything after that is reported through
 * importStatus().
 */
export function startImport(path: string, opts: { month?: string }, deps: ImportDeps): Promise<ImportStatus> {
  if (status.state === 'reading' || status.state === 'indexing') throw new Error('An import is already running.');
  assertFile(path);
  status = { ...idle(), state: 'reading', month: opts.month ?? null, startedAt: new Date().toISOString() };
  return runImport(path, opts, deps);
}

async function runImport(path: string, opts: { month?: string }, deps: ImportDeps): Promise<ImportStatus> {
  const passagesPath = deps.passagesPath ?? HISTORY_PASSAGES_PATH;
  const indexPath = deps.indexPath ?? HISTORY_INDEX_PATH;
  const store = new PassageStore(passagesPath);
  try {
    let source: ExportSource | null = null;
    await readExportElements(path, (raw) => {
      if (!source) {
        source = detectSource(raw);
        status.sourceLabel = SOURCE_LABEL[source];
        if (!READABLE.has(source)) throw new Error(`This looks like an export from ${SOURCE_LABEL[source]}, which this house cannot read yet.`);
      }
      const chat = readChat(source, raw);
      if (!chat) return;
      if (opts.month && monthOf(chat.startedAt) !== opts.month) return;
      status.chats++;
      status.dropped += chat.dropped;
      status.stored += store.addChat({ source, chat: chat.chat, title: chat.title, voice: HOUSE_VOICE, lines: chat.lines });
    });

    status.state = 'indexing';
    status.toIndex = store.countAfter(HOUSE_VOICE, indexCursor(indexPath));
    const built = await buildHistoryIndex(HOUSE_VOICE, {
      fetchPage: async (voice, after) => store.page(voice, after),
      embed: deps.embed,
      indexPath,
      onProgress: (p) => { status.indexed = p.passages; status.pieces = p.pieces; },
    });
    status.indexed = status.toIndex;
    status.pieces = built.pieces;
    status.state = 'done';
    status.finishedAt = new Date().toISOString();
    if (deps.removeAfter) { try { unlinkSync(path); } catch { /* already gone */ } }
  } catch (err) {
    status.state = 'failed';
    status.error = err instanceof Error ? err.message : String(err);
    status.finishedAt = new Date().toISOString();
    console.warn('[history-import] import stopped:', status.error);
  } finally {
    store.close();
  }
  return importStatus();
}

/** Test seam. */
export function resetImportStatus(): void {
  status = idle();
}
