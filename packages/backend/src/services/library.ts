// The Library — books to read together, starting with Project Gutenberg's
// public-domain catalog. A book is fetched once, split into chapters, and
// kept as a JSON file beside the database (data/library/), so the shelf and
// its bookmarks need no schema: shelf.json holds the list and each reader's
// place, books/<id>.json holds the text.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { getBytelightConfig } from '../config.js';

export interface LibraryProgress {
  chapter: number;
  /** How far down the chapter, 0..1. */
  fraction: number;
  updatedAt: string;
}

export interface ShelfEntry {
  id: number;
  title: string;
  authors: string[];
  cover: string | null;
  chapterCount: number;
  addedAt: string;
  progress: LibraryProgress | null;
}

export interface LibraryChapter {
  title: string;
  text: string;
}

export interface LibraryBook {
  id: number;
  title: string;
  authors: string[];
  cover: string | null;
  source: 'gutenberg';
  fetchedAt: string;
  chapters: LibraryChapter[];
}

export interface CatalogResult {
  id: number;
  title: string;
  authors: string[];
  cover: string | null;
  languages: string[];
  downloads: number;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

const CATALOG = 'https://gutendex.com/books';
const USER_AGENT = 'byte-light-library/1.0 (personal reading room)';
const MAX_TEXT_BYTES = 12 * 1024 * 1024;

// ── storage ────────────────────────────────────────────────────────────────

export function libraryDir(): string {
  return join(dirname(getBytelightConfig().server.db_path), 'library');
}

function ensureDirs(root: string): void {
  mkdirSync(join(root, 'books'), { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  // Write-then-rename so a crash mid-write never leaves half a shelf.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

export function readShelf(root = libraryDir()): ShelfEntry[] {
  const path = join(root, 'shelf.json');
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(data) ? (data as ShelfEntry[]) : [];
  } catch {
    return [];
  }
}

function writeShelf(entries: ShelfEntry[], root: string): void {
  ensureDirs(root);
  writeJson(join(root, 'shelf.json'), entries);
}

export function readBook(id: number, root = libraryDir()): LibraryBook | null {
  const path = join(root, 'books', `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as LibraryBook;
  } catch {
    return null;
  }
}

export function saveBook(book: LibraryBook, root = libraryDir()): ShelfEntry {
  ensureDirs(root);
  writeJson(join(root, 'books', `${book.id}.json`), book);
  const shelf = readShelf(root);
  const existing = shelf.find((e) => e.id === book.id);
  const entry: ShelfEntry = {
    id: book.id,
    title: book.title,
    authors: book.authors,
    cover: book.cover,
    chapterCount: book.chapters.length,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    progress: existing?.progress ?? null,
  };
  writeShelf([entry, ...shelf.filter((e) => e.id !== book.id)], root);
  return entry;
}

export function removeBook(id: number, root = libraryDir()): boolean {
  const shelf = readShelf(root);
  const next = shelf.filter((e) => e.id !== id);
  if (next.length === shelf.length) return false;
  writeShelf(next, root);
  rmSync(join(root, 'books', `${id}.json`), { force: true });
  rmSync(join(root, 'notes', `${id}.json`), { force: true });
  // Cached read-aloud for this book goes with it.
  const audio = join(root, 'audio');
  if (existsSync(audio)) {
    for (const f of readdirSync(audio)) if (f.startsWith(`${id}-`)) rmSync(join(audio, f), { force: true });
  }
  return true;
}

export function setProgress(id: number, chapter: number, fraction: number, root = libraryDir()): ShelfEntry | null {
  const shelf = readShelf(root);
  const entry = shelf.find((e) => e.id === id);
  if (!entry) return null;
  const maxChapter = Math.max(0, entry.chapterCount - 1);
  entry.progress = {
    chapter: Math.min(Math.max(0, Math.floor(chapter)), maxChapter),
    fraction: Math.min(Math.max(0, fraction), 1),
    updatedAt: new Date().toISOString(),
  };
  writeShelf(shelf, root);
  return entry;
}

// ── text ───────────────────────────────────────────────────────────────────

/** Drop Project Gutenberg's licence header and footer, keeping the book. */
export function stripGutenbergBoilerplate(raw: string): string {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const start = text.search(/^\*{3}\s*START OF (THE|THIS) PROJECT GUTENBERG EBOOK.*\*{3}\s*$/im);
  const end = text.search(/^\*{3}\s*END OF (THE|THIS) PROJECT GUTENBERG EBOOK.*\*{3}\s*$/im);
  let body = text;
  if (start !== -1) body = body.slice(body.indexOf('\n', start) + 1);
  if (end !== -1) {
    const endInBody = body.search(/^\*{3}\s*END OF (THE|THIS) PROJECT GUTENBERG EBOOK.*\*{3}\s*$/im);
    if (endInBody !== -1) body = body.slice(0, endInBody);
  }
  return body.trim();
}

const HEADING = /^(?:chapter|letter|book|part|stave|canto|volume)\s+(?:[ivxlcdm]+|\d+|[a-z]+(?:-[a-z]+)?)\b[^\n]{0,70}$/i;
// A table of contents lists every heading with nothing between them; those
// lines are not chapters. Anything this short gets folded forward.
const MIN_CHAPTER_CHARS = 400;
const CHUNK_CHARS = 18000;

/**
 * Split a book into chapters by its own headings (CHAPTER I, Letter 4, STAVE
 * ONE…). A heading's following line is taken as its subtitle when short. With
 * fewer than two real headings the text is cut into even parts at paragraph
 * breaks, so every book opens in readable pieces.
 */
export function splitChapters(body: string): LibraryChapter[] {
  const lines = body.split('\n');
  const marks: Array<{ line: number; title: string; bodyFrom: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length > 80 || !HEADING.test(line)) continue;
    if (i > 0 && lines[i - 1].trim() !== '') continue; // headings start a block
    let title = line.replace(/\s+/g, ' ');
    let bodyFrom = i + 1;
    const next = (lines[i + 1] ?? '').trim();
    if (next && next.length <= 70 && !/[.!?]["'”’]?$/.test(next) && (lines[i + 2] ?? '').trim() === '') {
      title = `${title} — ${next}`;
      bodyFrom = i + 2; // the subtitle lives in the heading now, not the text
    }
    marks.push({ line: i, title, bodyFrom });
  }

  const chapters: LibraryChapter[] = [];
  if (marks.length >= 2) {
    const front = lines.slice(0, marks[0].line).join('\n').trim();
    if (front.length >= MIN_CHAPTER_CHARS) chapters.push({ title: 'Opening', text: front });
    for (let m = 0; m < marks.length; m++) {
      const from = marks[m].bodyFrom;
      const to = m + 1 < marks.length ? marks[m + 1].line : lines.length;
      const text = lines.slice(from, to).join('\n').trim();
      chapters.push({ title: marks[m].title, text });
    }
    // Fold table-of-contents stubs (and other near-empty sections) forward.
    const merged: LibraryChapter[] = [];
    for (const ch of chapters) {
      const prev = merged[merged.length - 1];
      if (prev && prev.text.length < MIN_CHAPTER_CHARS) {
        // Keep whatever the stub held — a genuinely short section is never
        // dropped, it just rides at the top of the next one.
        merged[merged.length - 1] = { title: ch.title, text: prev.text ? `${prev.text}\n\n${ch.text}` : ch.text };
        continue;
      }
      merged.push(ch);
    }
    const real = merged.filter((c) => c.text.length >= MIN_CHAPTER_CHARS);
    if (real.length >= 2) return merged.filter((c) => c.text.length > 0);
  }

  // No usable headings — even parts at paragraph boundaries.
  const paras = body.split(/\n{2,}/);
  const parts: LibraryChapter[] = [];
  let buf: string[] = [];
  let size = 0;
  for (const p of paras) {
    buf.push(p);
    size += p.length;
    if (size >= CHUNK_CHARS) {
      parts.push({ title: `Part ${parts.length + 1}`, text: buf.join('\n\n').trim() });
      buf = [];
      size = 0;
    }
  }
  if (buf.join('').trim()) parts.push({ title: `Part ${parts.length + 1}`, text: buf.join('\n\n').trim() });
  return parts.length > 0 ? parts : [{ title: 'Text', text: body }];
}

// ── catalog ────────────────────────────────────────────────────────────────

interface GutendexBook {
  id: number;
  title: string;
  authors?: Array<{ name: string }>;
  languages?: string[];
  download_count?: number;
  formats?: Record<string, string>;
}

/** Gutendex writes authors "Last, First"; show them the way a cover does. */
function authorName(name: string): string {
  const parts = name.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length === 2 ? `${parts[1]} ${parts[0]}` : name;
}

function coverOf(b: GutendexBook): string | null {
  return b.formats?.['image/jpeg'] ?? `https://www.gutenberg.org/cache/epub/${b.id}/pg${b.id}.cover.medium.jpg`;
}

function toResult(b: GutendexBook): CatalogResult {
  return {
    id: b.id,
    title: b.title,
    authors: (b.authors ?? []).map((a) => authorName(a.name)),
    cover: coverOf(b),
    languages: b.languages ?? [],
    downloads: b.download_count ?? 0,
  };
}

function hasPlainText(b: GutendexBook): boolean {
  return Object.keys(b.formats ?? {}).some((k) => k.startsWith('text/plain'));
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Catalog answered ${res.status}`);
  return res.json();
}

export async function searchCatalog(query: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<CatalogResult[]> {
  const url = `${CATALOG}?search=${encodeURIComponent(query)}`;
  const data = (await getJson(fetchImpl, url)) as { results?: GutendexBook[] };
  return (data.results ?? []).filter(hasPlainText).map(toResult);
}

function plainTextUrl(b: GutendexBook): string {
  const formats = b.formats ?? {};
  const prefer = ['text/plain; charset=utf-8', 'text/plain; charset=us-ascii', 'text/plain'];
  for (const key of prefer) {
    const url = formats[key];
    if (url && !url.endsWith('.zip')) return url;
  }
  const any = Object.entries(formats).find(([k, v]) => k.startsWith('text/plain') && !v.endsWith('.zip'));
  return any?.[1] ?? `https://www.gutenberg.org/cache/epub/${b.id}/pg${b.id}.txt`;
}

/** Fetch a Gutenberg book's metadata and text, split it, and shelve it. */
export async function fetchAndShelve(id: number, fetchImpl: FetchLike = fetch as unknown as FetchLike, root = libraryDir()): Promise<ShelfEntry> {
  const meta = (await getJson(fetchImpl, `${CATALOG}/${id}`)) as GutendexBook;
  if (!meta || typeof meta.id !== 'number') throw new Error('Book not found in the catalog');
  const res = await fetchImpl(plainTextUrl(meta), { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Gutenberg answered ${res.status}`);
  const raw = await res.text();
  if (raw.length > MAX_TEXT_BYTES) throw new Error('That book is too large to shelve');
  const result = toResult(meta);
  const book: LibraryBook = {
    id: meta.id,
    title: result.title,
    authors: result.authors,
    cover: result.cover,
    source: 'gutenberg',
    fetchedAt: new Date().toISOString(),
    chapters: splitChapters(stripGutenbergBoilerplate(raw)),
  };
  return saveBook(book, root);
}

// ── paragraphs & read-aloud segments ───────────────────────────────────────

/** Gutenberg hard-wraps lines at ~70 columns; rejoin each paragraph. The
 *  reader, read-aloud and the companions all count paragraphs this way. */
export function paragraphsOf(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
}

// Read-aloud renders a few paragraphs at a time: speech starts in seconds, the
// next piece is fetched while this one plays, and a tap never spends a whole
// chapter's worth of voice credit.
const SEGMENT_CHARS = 1200;

export interface Segment { from: number; to: number }

/** Group paragraphs into read-aloud pieces of about SEGMENT_CHARS (a single
 *  long paragraph stands alone). `to` is inclusive. */
export function segmentsOf(paragraphs: string[], limit = SEGMENT_CHARS): Segment[] {
  const out: Segment[] = [];
  let from = 0;
  let size = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    if (size > 0 && size + paragraphs[i].length > limit) {
      out.push({ from, to: i - 1 });
      from = i;
      size = 0;
    }
    size += paragraphs[i].length;
  }
  if (paragraphs.length > from) out.push({ from, to: paragraphs.length - 1 });
  return out;
}

export function audioDir(root = libraryDir()): string {
  return join(root, 'audio');
}

export function audioFileName(bookId: number, chapter: number, segment: number, voice: string): string {
  return `${bookId}-${chapter}-${segment}-${voice}.mp3`;
}

export const AUDIO_FILE_RE = /^\d+-\d+-\d+-[a-z0-9_-]{1,32}\.mp3$/;

// ── reading along (the companions' side) ───────────────────────────────────

/** The book she touched most recently, with her place in it. */
export function currentlyReading(root = libraryDir()): ShelfEntry | null {
  const withProgress = readShelf(root).filter((e) => e.progress);
  withProgress.sort((a, b) => (b.progress!.updatedAt).localeCompare(a.progress!.updatedAt));
  return withProgress[0] ?? null;
}

export interface ReadAlongResult {
  bookId: number;
  title: string;
  authors: string[];
  chapter: number;
  chapterTitle: string;
  chapterCount: number;
  /** Paragraphs she has reached in this chapter (all of them for a finished chapter). */
  paragraphs: string[];
  /** True when this is her current chapter and it is cut at her place. */
  cutAtHerPlace: boolean;
  totalParagraphs: number;
}

/**
 * What a companion may read: any chapter she has finished, and her current
 * chapter up to where she is. Never past her bookmark — the server, not the
 * prompt, is what keeps it spoiler-free.
 */
export function readAlong(bookId: number, chapter: number | undefined, root = libraryDir()): ReadAlongResult {
  const entry = readShelf(root).find((e) => e.id === bookId);
  const book = readBook(bookId, root);
  if (!entry || !book) throw new LibraryError('That book is not on her shelf.');
  if (!entry.progress) throw new LibraryError('She has not started this book yet.');
  const here = entry.progress.chapter;
  const n = chapter ?? here;
  if (!Number.isInteger(n) || n < 0 || n >= book.chapters.length) throw new LibraryError('No such chapter.');
  if (n > here) throw new LibraryError(`She is on chapter ${here + 1} — no reading ahead of her.`);
  const all = paragraphsOf(book.chapters[n].text);
  let visible = all;
  let cut = false;
  if (n === here) {
    // Her place is a scroll fraction; round up a paragraph so the line she
    // is looking at is included, never further.
    const reach = Math.min(all.length, Math.ceil(entry.progress.fraction * all.length) + 1);
    visible = all.slice(0, reach);
    cut = reach < all.length;
  }
  return {
    bookId,
    title: book.title,
    authors: book.authors,
    chapter: n,
    chapterTitle: book.chapters[n].title,
    chapterCount: book.chapters.length,
    paragraphs: visible,
    cutAtHerPlace: cut,
    totalParagraphs: all.length,
  };
}

export class LibraryError extends Error {}

// ── margin notes ───────────────────────────────────────────────────────────

export interface MarginNote {
  id: string;
  chapter: number;
  /** The exact words the note hangs on, as they appear in the paragraph. */
  quote: string;
  paragraph: number;
  note: string;
  author: string;
  createdAt: string;
}

function notesPath(bookId: number, root: string): string {
  return join(root, 'notes', `${bookId}.json`);
}

export function readNotes(bookId: number, root = libraryDir()): MarginNote[] {
  const path = notesPath(bookId, root);
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(data) ? (data as MarginNote[]) : [];
  } catch {
    return [];
  }
}

function writeNotes(bookId: number, notes: MarginNote[], root: string): void {
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeJson(notesPath(bookId, root), notes);
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Leave a note in the margin. The quote must be words from a paragraph she
 * has already reached (the same reach as readAlong), so a note can never
 * point ahead of her or at text that isn't there.
 */
export function addNote(
  input: { bookId: number; chapter: number; quote: string; note: string; author: string },
  root = libraryDir(),
): MarginNote {
  const quote = squash(input.quote);
  const note = input.note.trim();
  const author = input.author.trim().toLowerCase();
  if (quote.length < 3) throw new LibraryError('Quote at least a few words from the page.');
  if (!note) throw new LibraryError('The note is empty.');
  if (!/^[a-z0-9_-]{1,32}$/.test(author)) throw new LibraryError('Sign the note with your slug (e.g. companion-a, companion-b).');
  const reach = readAlong(input.bookId, input.chapter, root);
  const paragraph = reach.paragraphs.findIndex((p) => squash(p).includes(quote));
  if (paragraph === -1) throw new LibraryError('Those words are not on a page she has reached in that chapter — quote them exactly.');
  const entry: MarginNote = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    chapter: reach.chapter,
    quote,
    paragraph,
    note: note.slice(0, 2000),
    author,
    createdAt: new Date().toISOString(),
  };
  writeNotes(input.bookId, [...readNotes(input.bookId, root), entry], root);
  return entry;
}

export function removeNote(bookId: number, noteId: string, root = libraryDir()): boolean {
  const notes = readNotes(bookId, root);
  const next = notes.filter((n) => n.id !== noteId);
  if (next.length === notes.length) return false;
  writeNotes(bookId, next, root);
  return true;
}
