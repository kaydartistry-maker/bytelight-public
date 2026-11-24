/**
 * Native BOOX / KOReader Book Bridge.
 *
 * The reader only makes short outbound requests. It never accepts a remote
 * command that reaches into ReaderUI/document state: page events are captured
 * by KOReader's own callbacks, posted here, and reduced to a durable cache.
 */
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteConfig, getConfig, setConfig } from './db/config.js';
import {
  LibraryError,
  addNote,
  libraryDir,
  paragraphsOf,
  readBook,
  readHighlights,
  readShelf,
  setProgress,
  titleKey,
  type MarginNote,
  type ReadAlongResult,
} from './library.js';

export type BookBridgeMode = 'live' | 'ahead';

export class BookBridgeError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const BOOK_BRIDGE_KEYS = {
  tokenHash: 'library.book_bridge.token_hash',
  pairedAt: 'library.book_bridge.paired_at',
  pairing: 'library.book_bridge.pairing',
} as const;

export const BOOK_BRIDGE_PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const BOOK_BRIDGE_PAIRING_LENGTH = 8;
export const BOOK_BRIDGE_PAIRING_TTL_MS = 10 * 60_000;
export const BOOK_BRIDGE_PAIRING_MAX_MISSES = 10;
export const BOOK_BRIDGE_ONLINE_MS = 90_000;

const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const normaliseCode = (raw: unknown) => typeof raw === 'string' ? raw.toUpperCase().replace(/[\s-]/g, '') : '';

interface WaitingCode { hash: string; expiresAt: number; misses: number }

function waitingCode(): WaitingCode | null {
  const raw = getConfig(BOOK_BRIDGE_KEYS.pairing);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<WaitingCode>;
    return typeof value.hash === 'string' && typeof value.expiresAt === 'number'
      ? { hash: value.hash, expiresAt: value.expiresAt, misses: Number(value.misses) || 0 }
      : null;
  } catch { return null; }
}

export function createBookBridgePairingCode(now = Date.now()): { code: string; expiresAt: string } {
  const bytes = crypto.randomBytes(BOOK_BRIDGE_PAIRING_LENGTH);
  let code = '';
  for (let i = 0; i < bytes.length; i++) code += BOOK_BRIDGE_PAIRING_ALPHABET[bytes[i] % BOOK_BRIDGE_PAIRING_ALPHABET.length];
  const expiresAt = now + BOOK_BRIDGE_PAIRING_TTL_MS;
  setConfig(BOOK_BRIDGE_KEYS.pairing, JSON.stringify({ hash: sha256(code), expiresAt, misses: 0 } satisfies WaitingCode));
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

export function claimBookBridgePairingCode(raw: unknown, now = Date.now()): { token: string } {
  const code = normaliseCode(raw);
  const waiting = waitingCode();
  const refuse = () => new BookBridgeError(401, 'That pairing code did not work. Make a fresh one in the Library and try again.');
  if (!waiting) throw refuse();
  if (now > waiting.expiresAt) {
    deleteConfig(BOOK_BRIDGE_KEYS.pairing);
    throw refuse();
  }
  const given = Buffer.from(sha256(code), 'hex');
  const kept = Buffer.from(waiting.hash, 'hex');
  const match = code.length === BOOK_BRIDGE_PAIRING_LENGTH && given.length === kept.length && crypto.timingSafeEqual(given, kept);
  if (!match) {
    const misses = waiting.misses + 1;
    if (misses >= BOOK_BRIDGE_PAIRING_MAX_MISSES) deleteConfig(BOOK_BRIDGE_KEYS.pairing);
    else setConfig(BOOK_BRIDGE_KEYS.pairing, JSON.stringify({ ...waiting, misses }));
    throw refuse();
  }
  deleteConfig(BOOK_BRIDGE_KEYS.pairing);
  const token = crypto.randomBytes(32).toString('base64url');
  setConfig(BOOK_BRIDGE_KEYS.tokenHash, sha256(token));
  setConfig(BOOK_BRIDGE_KEYS.pairedAt, new Date(now).toISOString());
  return { token };
}

export function bookBridgeTokenValid(token: unknown): boolean {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return false;
  const kept = getConfig(BOOK_BRIDGE_KEYS.tokenHash);
  if (!kept || !/^[0-9a-f]{64}$/.test(kept)) return false;
  return crypto.timingSafeEqual(Buffer.from(sha256(token), 'hex'), Buffer.from(kept, 'hex'));
}

export function revokeBookBridge(): void {
  deleteConfig(BOOK_BRIDGE_KEYS.tokenHash);
  deleteConfig(BOOK_BRIDGE_KEYS.pairedAt);
  deleteConfig(BOOK_BRIDGE_KEYS.pairing);
}

export interface BookBridgeSnapshot {
  eventId: string;
  bookId: number;
  title: string;
  fingerprint: string | null;
  chapter: number;
  fraction: number;
  viewportText: string;
  anchor: string | null;
  occurredAt: string;
  receivedAt: string;
}

interface OutboxItem extends MarginNote { bookId: number; deliveredAt?: string }
interface BookBridgeState {
  version: 1;
  modes: Record<string, BookBridgeMode>;
  current: BookBridgeSnapshot | null;
  outbox: OutboxItem[];
}

const emptyState = (): BookBridgeState => ({ version: 1, modes: {}, current: null, outbox: [] });
const statePath = (root: string) => join(root, 'book-bridge', 'state.json');

function readState(root = libraryDir()): BookBridgeState {
  const path = statePath(root);
  if (!existsSync(path)) return emptyState();
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<BookBridgeState>;
    return {
      version: 1,
      modes: value.modes && typeof value.modes === 'object' ? value.modes : {},
      current: value.current ?? null,
      outbox: Array.isArray(value.outbox) ? value.outbox : [],
    };
  } catch { return emptyState(); }
}

function writeState(state: BookBridgeState, root = libraryDir()): void {
  const dir = join(root, 'book-bridge');
  mkdirSync(dir, { recursive: true });
  const path = statePath(root);
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}

const compactText = (raw: unknown, max: number) => typeof raw === 'string'
  ? raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max)
  : '';

function matchedBook(raw: unknown, root: string): { id: number; title: string } {
  const b = (raw ?? {}) as { id?: unknown; title?: unknown };
  const id = Number(b.id);
  const shelf = readShelf(root);
  if (Number.isInteger(id) && id > 0) {
    const hit = shelf.find((x) => x.id === id && x.source !== 'kindle');
    if (hit) return hit;
  }
  const key = titleKey(compactText(b.title, 500));
  const hits = key ? shelf.filter((x) => x.source !== 'kindle' && titleKey(x.title) === key) : [];
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new BookBridgeError(409, 'More than one shelved book has that title. Pick its ByteLight book id once in the plugin.');
  throw new BookBridgeError(404, 'That book is not in the ByteLight Library. Upload the same EPUB there first.');
}

export function bookBridgeMode(bookId: number, root = libraryDir()): BookBridgeMode {
  return readState(root).modes[String(bookId)] === 'ahead' ? 'ahead' : 'live';
}

export function setBookBridgeMode(bookId: number, mode: BookBridgeMode, root = libraryDir()): BookBridgeMode {
  if (mode !== 'live' && mode !== 'ahead') throw new BookBridgeError(400, 'Reading mode must be live or ahead.');
  if (!readBook(bookId, root)) throw new BookBridgeError(404, 'That book is not in the ByteLight Library.');
  const state = readState(root);
  state.modes[String(bookId)] = mode;
  writeState(state, root);
  return mode;
}

export function ingestBookBridgeEvent(input: unknown, root = libraryDir(), now = Date.now()): { bookId: number; mode: BookBridgeMode; pending: OutboxItem[] } {
  const body = (input ?? {}) as any;
  const eventId = compactText(body.eventId, 128);
  if (!eventId) throw new BookBridgeError(400, 'eventId is required.');
  const hit = matchedBook(body.book, root);
  const book = readBook(hit.id, root)!;
  let chapter = Number(body.position?.chapter);
  let fraction = Number(body.position?.fraction);
  const overall = Number(body.position?.overallFraction);
  // KOReader's stable cross-layout coordinate is whole-book progress. Map it
  // onto the exact parsed EPUB ByteLight keeps, weighted by chapter text size.
  if (Number.isFinite(overall) && overall >= 0 && overall <= 1) {
    const sizes = book.chapters.map((c) => Math.max(1, c.text.length));
    const total = sizes.reduce((a, b) => a + b, 0);
    let at = overall * total;
    chapter = 0;
    while (chapter < sizes.length - 1 && at > sizes[chapter]) { at -= sizes[chapter]; chapter++; }
    fraction = Math.min(1, Math.max(0, at / sizes[chapter]));
  }
  if (!Number.isInteger(chapter) || chapter < 0 || chapter >= book.chapters.length) throw new BookBridgeError(400, 'chapter is a zero-based chapter on the shelved EPUB.');
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new BookBridgeError(400, 'fraction is 0 through 1.');
  setProgress(hit.id, chapter, fraction, root);
  const state = readState(root);
  const receivedAt = new Date(now).toISOString();
  state.current = {
    eventId,
    bookId: hit.id,
    title: hit.title,
    fingerprint: compactText(body.book?.fingerprint, 256) || null,
    chapter,
    fraction,
    viewportText: compactText(body.viewport?.text, 32 * 1024),
    anchor: compactText(body.viewport?.anchor, 1000) || null,
    occurredAt: typeof body.occurredAt === 'string' && Number.isFinite(Date.parse(body.occurredAt)) ? body.occurredAt : receivedAt,
    receivedAt,
  };
  writeState(state, root);
  return { bookId: hit.id, mode: bookBridgeMode(hit.id, root), pending: state.outbox.filter((n) => n.bookId === hit.id && !n.deliveredAt) };
}

export function bookBridgeView(root = libraryDir(), now = Date.now()) {
  const state = readState(root);
  const waiting = waitingCode();
  return {
    paired: Boolean(getConfig(BOOK_BRIDGE_KEYS.tokenHash)),
    pairedAt: getConfig(BOOK_BRIDGE_KEYS.pairedAt),
    codeWaitingUntil: waiting && waiting.expiresAt > now ? new Date(waiting.expiresAt).toISOString() : null,
    online: Boolean(state.current && now - Date.parse(state.current.receivedAt) < BOOK_BRIDGE_ONLINE_MS),
    current: state.current,
    mode: state.current ? bookBridgeMode(state.current.bookId, root) : null,
    pendingNotes: state.outbox.filter((n) => !n.deliveredAt).length,
  };
}

export function readForBookBridge(input: { bookId?: number; chapter?: number }, root = libraryDir()): ReadAlongResult {
  const state = readState(root);
  const bookId = input.bookId ?? state.current?.bookId;
  if (!bookId) throw new LibraryError('The BOOX has not opened a paired book yet.');
  const entry = readShelf(root).find((e) => e.id === bookId);
  const book = readBook(bookId, root);
  if (!entry?.progress || !book) throw new LibraryError('That book has no BOOX reading position yet.');
  const mode = bookBridgeMode(bookId, root);
  const requested = input.chapter ?? (mode === 'ahead' ? Math.min(entry.progress.chapter + 1, book.chapters.length - 1) : entry.progress.chapter);
  if (!Number.isInteger(requested) || requested < 0 || requested >= book.chapters.length) throw new LibraryError('No such chapter.');
  if (mode === 'live' && requested > entry.progress.chapter) throw new LibraryError('This book is in live mode; one chapter ahead is sealed.');
  if (requested > entry.progress.chapter + 1) throw new LibraryError('One Chapter Ahead mode opens exactly one chapter beyond her, never further.');
  if (mode === 'live') {
    // Imported lazily through the already-loaded module would be circular; reproduce
    // its public result for the current viewport with the server bookmark gate.
    const all = paragraphsOf(book.chapters[requested].text);
    const reach = requested < entry.progress.chapter ? all.length : Math.min(all.length, Math.ceil(entry.progress.fraction * all.length) + 1);
    return {
      bookId, title: book.title, authors: book.authors, chapter: requested,
      chapterTitle: book.chapters[requested].title, chapterCount: book.chapters.length,
      paragraphs: all.slice(0, reach), cutAtHerPlace: reach < all.length, totalParagraphs: all.length,
      highlights: readHighlights(bookId, root).filter((h) => h.chapter === requested && all.slice(0, reach).join('\n').includes(h.quote)),
    };
  }
  const all = paragraphsOf(book.chapters[requested].text);
  return {
    bookId, title: book.title, authors: book.authors, chapter: requested,
    chapterTitle: book.chapters[requested].title, chapterCount: book.chapters.length,
    paragraphs: all, cutAtHerPlace: requested > entry.progress.chapter, totalParagraphs: all.length,
    highlights: requested <= entry.progress.chapter
      ? readHighlights(bookId, root).filter((h) => h.chapter === requested && all.join('\n').includes(h.quote))
      : [],
  };
}

export function queueBookBridgeNote(input: { bookId: number; chapter: number; quote: string; note: string; author: string }, root = libraryDir()): OutboxItem {
  const readable = readForBookBridge({ bookId: input.bookId, chapter: input.chapter }, root);
  if (!readable.paragraphs.some((p) => p.replace(/\s+/g, ' ').includes(input.quote.replace(/\s+/g, ' ').trim()))) {
    throw new LibraryError('Those exact words are not inside the permitted reading window.');
  }
  const note = addNote({ ...input, allowThroughChapter: readable.chapter }, root);
  const item: OutboxItem = { ...note, bookId: input.bookId };
  const state = readState(root);
  state.outbox.push(item);
  writeState(state, root);
  return item;
}

export function pendingBookBridgeNotes(bookId: number, root = libraryDir()): OutboxItem[] {
  return readState(root).outbox.filter((n) => n.bookId === bookId && !n.deliveredAt);
}

export function ackBookBridgeNotes(ids: unknown, root = libraryDir(), now = Date.now()): number {
  if (!Array.isArray(ids) || ids.length > 100) throw new BookBridgeError(400, 'ids is a list of at most 100 note ids.');
  const wanted = new Set(ids.filter((id): id is string => typeof id === 'string' && id.length <= 128));
  const state = readState(root);
  let changed = 0;
  for (const note of state.outbox) if (!note.deliveredAt && wanted.has(note.id)) { note.deliveredAt = new Date(now).toISOString(); changed++; }
  if (changed) writeState(state, root);
  return changed;
}
