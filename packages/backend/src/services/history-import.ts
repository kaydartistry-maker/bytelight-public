// history-import.ts — bringing an old chat export into the house.
//
// Two steps, and the first one never writes:
//
//   preview  reads the export and says what is in it: which app made it, how
//            many chats and messages, how many abandoned drafts would be left
//            out, and which months it covers.
//   import   stores the kept messages word for word in the house's history
//            store (history-store.ts: the local file, or the brain when the
//            house has one), then brings the search index up to date from
//            them (history-index.ts), in the background, one import at a time.
//
// Running the same export twice adds nothing. An import can be limited to
// one month, to try a small piece first.

import { existsSync, statSync, unlinkSync } from 'node:fs';
import { buildHistoryIndex, HISTORY_INDEX_PATH } from './history-index.js';
import { localStore, openHistoryStore, type HistoryStore } from './history-store.js';
import { OLD_WINDOW_VOICE } from './heartbeat/whisper.js';
import { chatReader, detectSource, readExportElements, READABLE, SOURCE_LABEL, type ChatReader, type ExportSource, type ReadChat } from './history-readers.js';
import Database from 'better-sqlite3';

/** Whose history the house index holds: the voice old windows answer for. */
export const HOUSE_VOICE = OLD_WINDOW_VOICE;

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

const PICK_ONE = 'Pick the export zip, the conversations file inside it, a Copilot activity CSV, or a Letta agent file (.af).';

const monthOf = (iso: string | null) => (iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : 'undated');

function assertFile(path: string): void {
  if (!path || !existsSync(path) || !statSync(path).isFile()) throw new Error('That file is not there.');
  if (!/\.(zip|json|af|csv)$/i.test(path)) throw new Error(PICK_ONE);
}

/** Read an export and describe it. Writes nothing. */
export async function previewExport(path: string, opts: { month?: string } = {}): Promise<ImportPreview> {
  assertFile(path);
  let source: ExportSource | null = null;
  const p: ImportPreview = { source: 'unknown', sourceLabel: SOURCE_LABEL.unknown, readable: false, chats: 0, messages: 0, dropped: 0, months: {}, sample: [] };
  const sample: PreviewChat[] = [];
  let reader: ChatReader | null = null;
  const count = (chat: ReadChat) => {
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
  };
  await readExportElements(path, (raw) => {
    if (!source) {
      source = detectSource(raw);
      p.source = source;
      p.sourceLabel = SOURCE_LABEL[source];
      p.readable = READABLE.has(source);
      reader = chatReader(source);
    }
    if (!p.readable) return;
    reader!.take(raw).forEach(count);
  });
  if (p.readable && reader) (reader as ChatReader).finish().forEach(count);
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
  /** Where the words go. Default: the house's own (history-store.ts openHistoryStore). */
  store?: HistoryStore;
  /** A local file to use instead of the house's store (tests). */
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
  const indexPath = deps.indexPath ?? HISTORY_INDEX_PATH;
  let store: HistoryStore | null = null;
  try {
    store = deps.store ?? (deps.passagesPath ? localStore(deps.passagesPath) : await openHistoryStore());
    const home = store;
    let source: ExportSource | null = null;
    let reader: ChatReader | null = null;
    // Chats are read as a stream, but storing one can wait on the brain, so
    // they queue here and are stored in order between reads.
    const waiting: ReadChat[] = [];
    const keep = (chat: ReadChat) => {
      if (opts.month && monthOf(chat.startedAt) !== opts.month) return;
      waiting.push(chat);
    };
    const storeWaiting = async () => {
      while (waiting.length) {
        const chat = waiting.shift()!;
        status.chats++;
        status.dropped += chat.dropped;
        status.stored += await home.addChat({ source: source!, chat: chat.chat, title: chat.title, voice: HOUSE_VOICE, lines: chat.lines });
      }
    };
    await readExportElements(path, (raw) => {
      if (!source) {
        source = detectSource(raw);
        status.sourceLabel = SOURCE_LABEL[source];
        if (!READABLE.has(source)) throw new Error(source === 'unknown' ? 'This house cannot read this kind of export yet.' : `This looks like an export from ${SOURCE_LABEL[source]}, which this house cannot read yet.`);
        reader = chatReader(source);
      }
      reader!.take(raw).forEach(keep);
    }, { between: storeWaiting });
    if (reader) (reader as ChatReader).finish().forEach(keep);
    await storeWaiting();

    status.state = 'indexing';
    status.toIndex = await home.countAfter(HOUSE_VOICE, indexCursor(indexPath));
    const built = await buildHistoryIndex(HOUSE_VOICE, {
      fetchPage: (voice, after) => home.page(voice, after),
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
    store?.close();
  }
  return importStatus();
}

/** Test seam. */
export function resetImportStatus(): void {
  status = idle();
}
