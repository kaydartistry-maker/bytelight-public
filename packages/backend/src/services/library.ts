// The Library — books to read together, starting with Project Gutenberg's
// public-domain catalog. A book is fetched once, split into chapters, and
// kept as a JSON file beside the database (data/library/), so the shelf and
// its bookmarks need no schema: shelf.json holds the list and each reader's
// place, books/<id>.json holds the text.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { getBytelightConfig } from '../config.js';
import { parseEpub } from './library-epub.js';
import { HIGHLIGHT_COLORS, type HighlightColor, type KindleNotebook } from './library-kindle.js';
import sharp from 'sharp';

export interface LibraryProgress {
  chapter: number;
  /** How far down the chapter, 0..1. */
  fraction: number;
  updatedAt: string;
}

/** Which shelf a book sits on. Favorites is a star on top of this, not a shelf
 *  of its own, so a finished book can also be a favorite. */
export type ShelfName = 'reading' | 'tbr' | 'finished' | 'dnf';
export const SHELF_NAMES: readonly ShelfName[] = ['reading', 'tbr', 'finished', 'dnf'];

export interface ShelfEntry {
  id: number;
  title: string;
  authors: string[];
  cover: string | null;
  chapterCount: number;
  addedAt: string;
  progress: LibraryProgress | null;
  /** Always present on what readShelf returns. Books shelved before shelves
   *  existed have none stored: started ones read as 'reading', the rest 'tbr'. */
  shelf: ShelfName;
  favorite: boolean;
  /** The cover's own color for the book's spine (#rrggbb), worked out by the
   *  house because Gutenberg's covers can't be read from the phone. Absent
   *  until worked out; null when there's no cover to read. */
  spineColor?: string | null;
  /** 'kindle' = a notes-only book: she reads it in the Kindle app, so there is
   *  no text here, only the highlights from its exported notebook (they live in
   *  kindle-pending.json under the title, waiting for the real text). Absent on
   *  every book that has text. */
  source?: 'kindle';
  /** Her own rating of the book and what she thought, kept with its shelf
   *  entry so it goes wherever the book goes (and off the shelf with it).
   *  Absent until she rates it. Any book can carry one, Kindle cards too. */
  review?: BookReview;
}

/** Her 1–5 stars and, if she wants, a few words. */
export interface BookReview {
  stars: number;
  text: string;
  updatedAt: string;
}

export const MAX_REVIEW_CHARS = 4000;

function isShelfName(v: unknown): v is ShelfName {
  return typeof v === 'string' && (SHELF_NAMES as readonly string[]).includes(v);
}

/** Fill in shelf + favorite for entries written before shelves existed. */
function normalizeEntry(e: ShelfEntry): ShelfEntry {
  return {
    ...e,
    shelf: isShelfName(e.shelf) ? e.shelf : (e.progress ? 'reading' : 'tbr'),
    favorite: e.favorite === true,
  };
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
  /** 'upload' = her own EPUB; its id is ≥ UPLOAD_ID_BASE so it never meets a Gutenberg number.
   *  (A Kindle notebook card has no LibraryBook at all — see ShelfEntry.source.) */
  source: 'gutenberg' | 'upload';
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
  arrayBuffer?(): Promise<ArrayBuffer>;
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
    return Array.isArray(data) ? (data as ShelfEntry[]).map(normalizeEntry) : [];
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

/** What shelving a book did with a Kindle notebook card of the same title. */
export interface KindleArrival {
  /** Highlights laid onto the new text. */
  placed: number;
  /** Highlights whose words weren't found; they stay on the card. */
  waiting: number;
  /** True when the card left the shelf (everything placed). */
  retired: boolean;
}

export type SavedEntry = ShelfEntry & { kindle?: KindleArrival };

export function saveBook(book: LibraryBook, root = libraryDir()): SavedEntry {
  ensureDirs(root);
  writeJson(join(root, 'books', `${book.id}.json`), book);
  const shelf = readShelf(root);
  const existing = shelf.find((e) => e.id === book.id);
  // A Kindle notebook card for this title: the real book takes its place on
  // the shelf (and its star) the first time it is shelved.
  const key = titleKey(book.title);
  const card = key ? shelf.find((e) => e.source === 'kindle' && e.id !== book.id && titleKey(e.title) === key) : undefined;
  const entry: ShelfEntry = {
    id: book.id,
    title: book.title,
    authors: book.authors,
    cover: book.cover,
    chapterCount: book.chapters.length,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    progress: existing?.progress ?? null,
    shelf: existing?.shelf ?? card?.shelf ?? 'tbr',
    favorite: existing?.favorite ?? card?.favorite ?? false,
    ...(existing?.spineColor !== undefined ? { spineColor: existing.spineColor } : {}),
    // Her review stays through a re-shelve, and moves over from a Kindle card.
    ...((existing?.review ?? card?.review) ? { review: existing?.review ?? card?.review } : {}),
  };
  writeShelf([entry, ...shelf.filter((e) => e.id !== book.id)], root);
  // Kindle highlights brought in before the book was shelved land on it now.
  let placed = 0;
  try {
    placed = applyKindlePending(entry, root);
  } catch (err) {
    console.warn('[library] waiting Kindle highlights could not be placed:', err instanceof Error ? err.message : err);
  }
  if (!card) return entry;
  // The card retires once every highlight on it has found its words. Any that
  // didn't stay waiting on the card, which stays on the shelf to show them.
  const waiting = readKindlePending(root)[key]?.highlights.length ?? 0;
  const retired = waiting === 0;
  if (retired) {
    dropShelfEntry(card.id, root);
    console.log(`[library] "${book.title}" arrived: ${placed} Kindle highlight(s) placed, its Kindle notebook card retired`);
  } else {
    console.log(`[library] "${book.title}" arrived: ${placed} Kindle highlight(s) placed, ${waiting} couldn't be found in the text and stay on its Kindle notebook card`);
  }
  return { ...entry, kindle: { placed, waiting, retired } };
}

/** Take an entry off the shelf with its own files; the pending store is untouched. */
function dropShelfEntry(id: number, root: string): boolean {
  const shelf = readShelf(root);
  const next = shelf.filter((e) => e.id !== id);
  if (next.length === shelf.length) return false;
  writeShelf(next, root);
  rmSync(join(root, 'books', `${id}.json`), { force: true });
  rmSync(join(root, 'notes', `${id}.json`), { force: true });
  rmSync(join(root, 'highlights', `${id}.json`), { force: true });
  const covers = join(root, 'covers');
  if (existsSync(covers)) {
    for (const f of readdirSync(covers)) if (f.startsWith(`${id}.`)) rmSync(join(covers, f), { force: true });
  }
  // Cached read-aloud for this book goes with it.
  const audio = join(root, 'audio');
  if (existsSync(audio)) {
    for (const f of readdirSync(audio)) if (f.startsWith(`${id}-`)) rmSync(join(audio, f), { force: true });
  }
  return true;
}

export function removeBook(id: number, root = libraryDir()): boolean {
  const entry = readShelf(root).find((e) => e.id === id);
  if (!dropShelfEntry(id, root)) return false;
  // A Kindle notebook card's highlights are its waiting ones: taking the card
  // off the shelf takes them too, the way any book's highlights go with it.
  if (entry?.source === 'kindle') {
    const key = titleKey(entry.title);
    const store = readKindlePending(root);
    if (key && store[key]) {
      delete store[key];
      writeKindlePending(store, root);
    }
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
  // Opening a To Be Read book and reading it moves it to Currently Reading.
  // Finished and DNF stay put: rereading a finished book is still finished.
  if (entry.shelf === 'tbr') entry.shelf = 'reading';
  writeShelf(shelf, root);
  return entry;
}

/** Move a book to another shelf and/or star it. Unknown shelf names are refused. */
export function setShelf(
  id: number,
  change: { shelf?: unknown; favorite?: unknown },
  root = libraryDir(),
): ShelfEntry | null {
  const shelf = readShelf(root);
  const entry = shelf.find((e) => e.id === id);
  if (!entry) return null;
  if (change.shelf !== undefined) {
    if (!isShelfName(change.shelf)) throw new LibraryError(`Unknown shelf: ${String(change.shelf)}`);
    entry.shelf = change.shelf;
  }
  if (change.favorite !== undefined) entry.favorite = change.favorite === true;
  writeShelf(shelf, root);
  return entry;
}

/**
 * Rate a book (1–5 whole stars) with an optional review. stars null clears the
 * review. Text without stars is refused: a review always carries its rating.
 */
export function setReview(
  id: number,
  input: { stars?: unknown; text?: unknown },
  root = libraryDir(),
): ShelfEntry | null {
  const shelf = readShelf(root);
  const entry = shelf.find((e) => e.id === id);
  if (!entry) return null;
  if (input.stars === null) {
    delete entry.review;
  } else {
    const stars = Number(input.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new LibraryError('Pick 1 to 5 stars.');
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (text.length > MAX_REVIEW_CHARS) throw new LibraryError(`Keep the review under ${MAX_REVIEW_CHARS} characters.`);
    entry.review = { stars, text, updatedAt: new Date().toISOString() };
  }
  writeShelf(shelf, root);
  return entry;
}

// ── spine colors ──────────────────────────────────────────────────────────

/** A cover's dominant color as #rrggbb, or null if it can't be read. */
export async function coverColor(image: Uint8Array): Promise<string | null> {
  try {
    const { dominant } = await sharp(image).stats();
    const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
  } catch {
    return null;
  }
}

async function coverBytes(cover: string, root: string, fetchImpl: FetchLike): Promise<Uint8Array | null> {
  const local = cover.match(/^\/api\/library\/covers\/(\d+\.(?:jpg|png|gif|webp))$/);
  if (local) {
    const path = join(root, 'covers', local[1]);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }
  if (!/^https:\/\/(?:www\.)?gutenberg\.org\//.test(cover)) return null;
  const res = await fetchImpl(cover, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) }) as unknown as { ok: boolean; arrayBuffer?: () => Promise<ArrayBuffer> };
  if (!res.ok || !res.arrayBuffer) return null;
  return new Uint8Array(await res.arrayBuffer());
}

let filling: Promise<number> | null = null;

/** Work out the spine color of every shelved book that doesn't have one yet.
 *  One run at a time; answers how many books it colored. */
export function fillSpineColors(root = libraryDir(), fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<number> {
  if (filling) return filling;
  filling = (async () => {
    let colored = 0;
    for (const entry of readShelf(root).filter((e) => e.spineColor === undefined)) {
      let color: string | null = null;
      try {
        const bytes = entry.cover ? await coverBytes(entry.cover, root, fetchImpl) : null;
        color = bytes ? await coverColor(bytes) : null;
      } catch {
        color = null;
      }
      // Re-read so a move made meanwhile isn't written over.
      const shelf = readShelf(root);
      const target = shelf.find((e) => e.id === entry.id);
      // Gone, or its cover changed meanwhile (a Kindle card's was just found): next run.
      if (!target || target.cover !== entry.cover) continue;
      target.spineColor = color;
      writeShelf(shelf, root);
      if (color) colored++;
    }
    return colored;
  })().finally(() => { filling = null; });
  return filling;
}

// ── her own books ─────────────────────────────────────────────────────────

/** Uploaded books number from here up; Gutenberg ids are far below it. */
export const UPLOAD_ID_BASE = 1_000_000_000;
/** Kindle notebook cards number from here up, clear of uploads. */
export const KINDLE_ID_BASE = 2_000_000_000;
export const COVER_FILE_RE = /^\d+\.(jpg|png|gif|webp)$/;

export function coversDir(root = libraryDir()): string {
  return join(root, 'covers');
}

/** Shelve an EPUB she uploaded: parse it, keep its cover, land it on To Be Read. */
export function shelveUpload(bytes: Uint8Array, root = libraryDir()): SavedEntry {
  const parsed = parseEpub(bytes);
  const id = Math.max(UPLOAD_ID_BASE, ...readShelf(root).map((e) => e.id).filter((n) => n < KINDLE_ID_BASE)) + 1;
  let cover: string | null = null;
  if (parsed.cover) {
    mkdirSync(coversDir(root), { recursive: true });
    const file = `${id}.${parsed.cover.ext}`;
    writeFileSync(join(coversDir(root), file), parsed.cover.data);
    cover = `/api/library/covers/${file}`;
  }
  return saveBook({
    id,
    title: parsed.title,
    authors: parsed.authors,
    cover,
    source: 'upload',
    fetchedAt: new Date().toISOString(),
    chapters: parsed.chapters,
  }, root);
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

// Gutendex is a free outside service; when it is slow or down, the Library
// falls back to Gutenberg's own OPDS catalog, so search and shelving keep
// working. Gutendex gets a short leash for that reason.
const GUTENDEX_TIMEOUT_MS = 8_000;
const OPDS = 'https://www.gutenberg.org/ebooks';

async function getJson(fetchImpl: FetchLike, url: string, timeoutMs = 20_000): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Catalog answered ${res.status}`);
  return res.json();
}

async function getText(fetchImpl: FetchLike, url: string, timeoutMs = 20_000): Promise<string> {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Gutenberg catalog answered ${res.status}`);
  return res.text();
}

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}

const gutenbergCover = (id: number) => `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`;

/** Search results from Gutenberg's OPDS feed: one <entry> per book, its id in
 *  /ebooks/<n>.opds, its author in <content>. Non-book entries are skipped. */
export function parseOpdsSearch(xml: string): CatalogResult[] {
  const out: CatalogResult[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1];
    const id = Number(entry.match(/<id>[^<]*\/ebooks\/(\d+)\.opds<\/id>/)?.[1]);
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    if (!Number.isInteger(id) || id <= 0 || !title) continue;
    const author = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1];
    out.push({
      id,
      title: decodeXml(title),
      authors: author ? [decodeXml(author)] : [],
      cover: gutenbergCover(id),
      languages: [],
      downloads: 0,
    });
  }
  return out;
}

/** One book's details from its OPDS page, shaped like a Gutendex record so
 *  the rest of shelving reads it the same way. */
export function parseOpdsBook(id: number, xml: string): GutendexBook | null {
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  const title = entry?.match(/<title>([\s\S]*?)<\/title>/)?.[1];
  if (!entry || !title) return null;
  // "Author: Wilde, Oscar, 1854-1900" → "Wilde, Oscar" (authorName flips it).
  const authors = [...entry.matchAll(/<p>\s*Author:\s*([^<]+?)\s*<\/p>/g)]
    .map((a) => decodeXml(a[1]).replace(/,\s*(?:\d{1,4}\??|-)\s*-?\s*\d{0,4}\??\s*(?:BCE?|AD)?\s*$/i, '').trim())
    .filter(Boolean)
    .map((name) => ({ name }));
  return { id, title: decodeXml(title), authors, formats: { 'image/jpeg': gutenbergCover(id) } };
}

export async function searchCatalog(query: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<CatalogResult[]> {
  try {
    const url = `${CATALOG}?search=${encodeURIComponent(query)}`;
    const data = (await getJson(fetchImpl, url, GUTENDEX_TIMEOUT_MS)) as { results?: GutendexBook[] };
    return (data.results ?? []).filter(hasPlainText).map(toResult);
  } catch (err) {
    console.warn('[library] Gutendex search failed, using Gutenberg\'s own catalog:', err instanceof Error ? err.message : err);
    return parseOpdsSearch(await getText(fetchImpl, `${OPDS}/search.opds/?query=${encodeURIComponent(query)}`));
  }
}

async function bookMeta(id: number, fetchImpl: FetchLike): Promise<GutendexBook> {
  try {
    const meta = (await getJson(fetchImpl, `${CATALOG}/${id}`, GUTENDEX_TIMEOUT_MS)) as GutendexBook;
    if (meta && typeof meta.id === 'number') return meta;
    throw new Error('no record');
  } catch (err) {
    console.warn(`[library] Gutendex lookup for ${id} failed, using Gutenberg's own catalog:`, err instanceof Error ? err.message : err);
    const meta = parseOpdsBook(id, await getText(fetchImpl, `${OPDS}/${id}.opds`));
    if (!meta) throw new Error('Book not found in the catalog');
    return meta;
  }
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
export async function fetchAndShelve(id: number, fetchImpl: FetchLike = fetch as unknown as FetchLike, root = libraryDir()): Promise<SavedEntry> {
  const meta = await bookMeta(id, fetchImpl);
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
  /** Her highlights on the words above (none past her place), page order. */
  highlights: Highlight[];
}

/** The paragraphs of chapter n she has reached: all of a finished chapter, her current one cut at her place. */
function reachedParagraphs(book: LibraryBook, n: number, progress: LibraryProgress): { all: string[]; visible: string[]; cut: boolean } {
  const all = paragraphsOf(book.chapters[n].text);
  if (n < progress.chapter) return { all, visible: all, cut: false };
  // Her place is a scroll fraction; round up a paragraph so the line she
  // is looking at is included, never further.
  const reach = Math.min(all.length, Math.ceil(progress.fraction * all.length) + 1);
  return { all, visible: all.slice(0, reach), cut: reach < all.length };
}

/**
 * Her highlights on one chapter that sit wholly on words she has reached.
 * A highlight can be further on than her bookmark (she read ahead, then went
 * back), and its words would give the page away, so it stays hidden until
 * she gets there again. Ordered as they fall on the page.
 */
function highlightsWithin(list: Highlight[], chapter: number, visible: string[]): Highlight[] {
  const page = foldText(visible.join('\n')).folded;
  return list
    .filter((h) => h.chapter === chapter)
    .map((h) => ({ h, at: page.indexOf(foldText(h.quote).folded) }))
    .filter(({ h, at }) => at !== -1 && foldText(h.quote).folded.length > 0)
    .sort((a, b) => a.at - b.at)
    .map(({ h }) => h);
}

/**
 * What a companion may read: any chapter she has finished, and her current
 * chapter up to where she is, with her highlights on it. Never past her
 * bookmark — the server, not the prompt, is what keeps it spoiler-free.
 */
export function readAlong(bookId: number, chapter: number | undefined, root = libraryDir()): ReadAlongResult {
  const entry = readShelf(root).find((e) => e.id === bookId);
  const book = readBook(bookId, root);
  if (entry?.source === 'kindle') throw new LibraryError('She reads that one in the Kindle app; there is no text here to read along with, only her Kindle highlights.');
  if (!entry || !book) throw new LibraryError('That book is not on her shelf.');
  if (!entry.progress) throw new LibraryError('She has not started this book yet.');
  const here = entry.progress.chapter;
  const n = chapter ?? here;
  if (!Number.isInteger(n) || n < 0 || n >= book.chapters.length) throw new LibraryError('No such chapter.');
  if (n > here) throw new LibraryError(`She is on chapter ${here + 1} — no reading ahead of her.`);
  const { all, visible, cut } = reachedParagraphs(book, n, entry.progress);
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
    highlights: highlightsWithin(readHighlights(bookId, root), n, visible),
  };
}

export interface HerHighlightsResult {
  bookId: number;
  title: string;
  authors: string[];
  /** A notebook card: she reads it in the Kindle app, so there are no chapters here. */
  readInKindle: boolean;
  highlights: Array<{
    /** 0-based chapter; null on a notebook card (see chapterHint). */
    chapter: number | null;
    chapterTitle: string | null;
    quote: string;
    color: HighlightColor;
    note: string;
    source: 'owner' | 'kindle';
    createdAt: string;
    /** Kindle's page or location, on a notebook card. */
    page?: string | null;
  }>;
}

/**
 * All her highlights in a book, up to her bookmark: every chapter she has
 * finished, and her current one cut at her place (the same reach as
 * readAlong). A Kindle notebook card has no text and no bookmark; its
 * highlights are what she chose to export, so all of them are hers to share.
 */
export function highlightsSoFar(bookId: number, root = libraryDir()): HerHighlightsResult {
  const entry = readShelf(root).find((e) => e.id === bookId);
  if (!entry) throw new LibraryError('That book is not on her shelf.');
  if (entry.source === 'kindle') {
    const card = readKindleCard(bookId, root);
    return {
      bookId,
      title: entry.title,
      authors: entry.authors,
      readInKindle: true,
      highlights: (card?.highlights ?? []).map((h) => ({
        chapter: null,
        chapterTitle: h.chapterHint,
        quote: h.quote,
        color: h.color,
        note: h.note,
        source: 'kindle' as const,
        createdAt: h.createdAt,
        page: h.page ?? null,
      })),
    };
  }
  const book = readBook(bookId, root);
  if (!book) throw new LibraryError('That book is not on her shelf.');
  if (!entry.progress) throw new LibraryError('She has not started this book yet.');
  const progress = entry.progress;
  const mine = readHighlights(bookId, root);
  const out: HerHighlightsResult['highlights'] = [];
  for (let n = 0; n <= Math.min(progress.chapter, book.chapters.length - 1); n++) {
    for (const h of highlightsWithin(mine, n, reachedParagraphs(book, n, progress).visible)) {
      out.push({ chapter: n, chapterTitle: book.chapters[n].title, quote: h.quote, color: h.color, note: h.note, source: h.source, createdAt: h.createdAt });
    }
  }
  return { bookId, title: book.title, authors: book.authors, readInKindle: false, highlights: out };
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

// ── her highlights ─────────────────────────────────────────────────────────
// Hers alone: made in the reader or brought in from a Kindle notebook. Kept
// in highlights/<bookId>.json. A quote is stored as the chapter's own words
// (whitespace squashed), so the reader finds it on the page exactly.

export interface Highlight {
  id: string;
  chapter: number;
  quote: string;
  color: HighlightColor;
  note: string;
  source: 'owner' | 'kindle';
  createdAt: string;
}

export { HIGHLIGHT_COLORS, type HighlightColor };

function isColor(v: unknown): v is HighlightColor {
  return typeof v === 'string' && (HIGHLIGHT_COLORS as readonly string[]).includes(v);
}

function highlightsPath(bookId: number, root: string): string {
  return join(root, 'highlights', `${bookId}.json`);
}

export function readHighlights(bookId: number, root = libraryDir()): Highlight[] {
  const path = highlightsPath(bookId, root);
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(data) ? (data as Highlight[]) : [];
  } catch {
    return [];
  }
}

function writeHighlights(bookId: number, list: Highlight[], root: string): void {
  mkdirSync(join(root, 'highlights'), { recursive: true });
  writeJson(highlightsPath(bookId, root), list);
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const MAX_HIGHLIGHT_NOTE = 2000;

/**
 * Text folded for finding a quote: letters and digits only, lowercased,
 * accents dropped, apostrophes gone ("don’t" = "dont"), every other run of
 * punctuation or space a single space. `map[k]` is where folded character k
 * came from in the original, so a find can be cut back out of the page.
 */
export function foldText(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let i = 0;
  for (const ch of text) {
    const at = i;
    i += ch.length;
    if (/['’‘ʼ`]/.test(ch)) continue;
    const base = ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    if (base && /^[\p{L}\p{N}]+$/u.test(base)) {
      for (const c of base) { folded += c; map.push(at); }
    } else if (folded && !folded.endsWith(' ')) {
      folded += ' ';
      map.push(at);
    }
  }
  if (folded.endsWith(' ')) { folded = folded.slice(0, -1); map.pop(); }
  return { folded, map };
}

/**
 * Find a quote in a chapter's text however its punctuation, quotes, dashes
 * or spacing differ, and answer the chapter's own words for it (whitespace
 * squashed). Kindle can cut a highlight mid-sentence, mid-quote or mid-word,
 * so this is a plain folded substring search. A long quote that doesn't match
 * whole (an edition's wording drifted) is placed by its first and last words.
 */
export function locateQuote(chapterText: string, quote: string): string | null {
  const page = paragraphsOf(chapterText).join('\n');
  const hay = foldText(page);
  const needle = foldText(quote).folded;
  if (needle.length < 2) return null;
  // When the quote starts or ends on punctuation (an opening quote, a closing
  // "?”"), the page's punctuation clinging there rides along too.
  const clinging = (ch: string | undefined) => !!ch && !/\s/.test(ch) && !/[\p{L}\p{N}]/u.test(ch);
  const trimmed = quote.trim();
  const leads = clinging(trimmed[0]);
  const trails = clinging(trimmed[trimmed.length - 1]);
  const cut = (start: number, endExclusive: number) => {
    let from = hay.map[start];
    const last = hay.map[endExclusive - 1];
    let to = last + (page.codePointAt(last)! > 0xffff ? 2 : 1);
    while (leads && from > 0 && clinging(page[from - 1])) from--;
    while (trails && to < page.length && clinging(page[to])) to++;
    return squash(page.slice(from, to));
  };
  const at = hay.folded.indexOf(needle);
  if (at !== -1) return cut(at, at + needle.length);
  const words = needle.split(' ');
  if (words.length >= 12) {
    const headWords = words.slice(0, 6).join(' ');
    const tailWords = words.slice(-6).join(' ');
    const h = hay.folded.indexOf(headWords);
    if (h !== -1) {
      const t = hay.folded.indexOf(tailWords, h + headWords.length);
      if (t !== -1 && t + tailWords.length - h <= needle.length * 1.5) return cut(h, t + tailWords.length);
    }
  }
  return null;
}

const quoteKey = (chapter: number, quote: string) => `${chapter}:${foldText(quote).folded}`;

/** Highlight words she selected in the reader. */
export function addHighlight(
  bookId: number,
  input: { chapter: unknown; quote: unknown; color?: unknown; note?: unknown },
  root = libraryDir(),
): Highlight {
  const book = readBook(bookId, root);
  if (!book) throw new LibraryError('That book is not on the shelf.');
  const chapter = Number(input.chapter);
  if (!Number.isInteger(chapter) || chapter < 0 || chapter >= book.chapters.length) throw new LibraryError('No such chapter.');
  const raw = typeof input.quote === 'string' ? input.quote : '';
  if (raw.trim().length < 2) throw new LibraryError('Select a few words to highlight.');
  if (input.color !== undefined && !isColor(input.color)) throw new LibraryError('Pick yellow, pink, blue or orange.');
  const quote = locateQuote(book.chapters[chapter].text, raw);
  if (!quote) throw new LibraryError('Those words aren\'t in this chapter. Try selecting them again.');
  const entry: Highlight = {
    id: newId(),
    chapter,
    quote,
    color: isColor(input.color) ? input.color : 'yellow',
    note: typeof input.note === 'string' ? input.note.trim().slice(0, MAX_HIGHLIGHT_NOTE) : '',
    source: 'owner',
    createdAt: new Date().toISOString(),
  };
  writeHighlights(bookId, [...readHighlights(bookId, root), entry], root);
  return entry;
}

/** Change a highlight's color and/or note. */
export function updateHighlight(
  bookId: number,
  id: string,
  change: { color?: unknown; note?: unknown },
  root = libraryDir(),
): Highlight | null {
  const list = readHighlights(bookId, root);
  const h = list.find((x) => x.id === id);
  if (!h) return null;
  if (change.color !== undefined) {
    if (!isColor(change.color)) throw new LibraryError('Pick yellow, pink, blue or orange.');
    h.color = change.color;
  }
  if (change.note !== undefined) {
    if (typeof change.note !== 'string') throw new LibraryError('The note should be words.');
    h.note = change.note.trim().slice(0, MAX_HIGHLIGHT_NOTE);
  }
  writeHighlights(bookId, list, root);
  return h;
}

export function removeHighlight(bookId: number, id: string, root = libraryDir()): boolean {
  const list = readHighlights(bookId, root);
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) return false;
  writeHighlights(bookId, next, root);
  return true;
}

// ── Kindle notebooks ───────────────────────────────────────────────────────

/** A title folded for matching: case, accents, punctuation, a series note in
 *  parentheses or brackets, a subtitle after ":" / ";" / a dash, and a
 *  leading "The"/"A"/"An" all ignored. "Flock (The Ravenhood Book 1)" = "Flock". */
export function titleKey(title: string): string {
  const main = title
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/\s*[:;]\s*|\s+[-–—]\s+/)[0];
  return foldText(main).folded.replace(/^(?:the|a|an) /, '');
}

export interface PendingHighlight {
  quote: string;
  color: HighlightColor;
  note: string;
  /** Kindle's chapter heading above it, kept so a notebook card can group by it
   *  and the real book's chapter can be found first. */
  chapterHint: string | null;
  /** Kindle's page (or location) number. Absent on ones kept before cards existed. */
  page?: string | null;
  createdAt: string;
}
/** Kindle highlights with no text to sit on yet, by titleKey. A notebook card
 *  reads its highlights from here; shelving the real book drains it. */
export interface PendingSlot {
  title: string;
  /** From the notebook's byline (absent on slots kept before cards existed). */
  authors?: string[];
  /** When a notebook for this title was last brought in. */
  importedAt?: string;
  highlights: PendingHighlight[];
}
type PendingStore = Record<string, PendingSlot>;

function pendingPath(root: string): string {
  return join(root, 'kindle-pending.json');
}

export function readKindlePending(root = libraryDir()): PendingStore {
  const path = pendingPath(root);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as PendingStore) : {};
  } catch {
    return {};
  }
}

function writeKindlePending(store: PendingStore, root: string): void {
  mkdirSync(root, { recursive: true });
  writeJson(pendingPath(root), store);
}

/** Order the chapters to search: the one whose title matches Kindle's heading first. */
function chapterOrder(book: LibraryBook, hint: string | null): number[] {
  const all = book.chapters.map((_, n) => n);
  const h = hint ? foldText(hint).folded : '';
  if (!h) return all;
  const hit = all.filter((n) => foldText(book.chapters[n].title).folded.includes(h));
  return [...hit, ...all.filter((n) => !hit.includes(n))];
}

interface PlaceResult { added: number; duplicates: number; unplaced: PendingHighlight[] }

/** Put Kindle highlights onto a shelved book: found ones stored (once), lost ones handed back. */
function placeKindle(bookId: number, items: PendingHighlight[], root: string): PlaceResult {
  const book = readBook(bookId, root);
  if (!book) return { added: 0, duplicates: 0, unplaced: items };
  const list = readHighlights(bookId, root);
  const seen = new Set(list.map((h) => quoteKey(h.chapter, h.quote)));
  let added = 0;
  let duplicates = 0;
  const unplaced: PendingHighlight[] = [];
  for (const item of items) {
    let placed = false;
    for (const n of chapterOrder(book, item.chapterHint)) {
      const quote = locateQuote(book.chapters[n].text, item.quote);
      if (!quote) continue;
      placed = true;
      const key = quoteKey(n, quote);
      if (seen.has(key)) { duplicates++; break; }
      seen.add(key);
      list.push({ id: newId(), chapter: n, quote, color: item.color, note: item.note, source: 'kindle', createdAt: item.createdAt });
      added++;
      break;
    }
    if (!placed) unplaced.push(item);
  }
  if (added) writeHighlights(bookId, list, root);
  return { added, duplicates, unplaced };
}

/** Keep highlights for a book that isn't shelved yet (or whose words weren't found), once each.
 *  `notebook` (on a card import) also records the byline and when it came in. */
function keepPending(
  title: string,
  items: PendingHighlight[],
  root: string,
  notebook?: { authors: string[]; importedAt: string },
): { kept: number; duplicates: number; waiting: number } {
  const key = titleKey(title);
  const store = readKindlePending(root);
  const slot: PendingSlot = store[key] ?? { title, highlights: [] };
  const seen = new Map(slot.highlights.map((h) => [foldText(h.quote).folded, h]));
  let kept = 0;
  let duplicates = 0;
  let touched = false;
  for (const item of items) {
    const k = foldText(item.quote).folded;
    const had = seen.get(k);
    if (had) {
      duplicates++;
      // Ones kept before pages were recorded pick theirs up from a re-import.
      if (!had.page && item.page) { had.page = item.page; touched = true; }
      continue;
    }
    seen.set(k, item);
    slot.highlights.push(item);
    kept++;
  }
  if (notebook) {
    if (notebook.authors.length) slot.authors = notebook.authors;
    slot.importedAt = notebook.importedAt;
    touched = true;
  }
  if (kept || touched) {
    store[key] = slot;
    writeKindlePending(store, root);
  }
  return { kept, duplicates, waiting: slot.highlights.length };
}

// ── Kindle notebook cards ──────────────────────────────────────────────────
// A store book read in the Kindle app can't be uploaded (DRM), so its
// notebook becomes a notes-only book on the shelf: a normal ShelfEntry with
// source 'kindle', no text, chapterCount 0. Its highlights stay in the pending
// store (the one home for Kindle highlights with no text to sit on), so when
// the real book is shelved, applyKindlePending lays them onto it as before and
// saveBook retires the card.

/** The card standing for this title, if there is one. */
function kindleCardFor(key: string, shelf: ShelfEntry[]): ShelfEntry | undefined {
  return key ? shelf.find((e) => e.source === 'kindle' && titleKey(e.title) === key) : undefined;
}

/** Put a notebook card on the shelf for a title (or refresh the one there). */
function ensureKindleCard(title: string, authors: string[], root: string): { entry: ShelfEntry; created: boolean } {
  const shelf = readShelf(root);
  const have = kindleCardFor(titleKey(title), shelf);
  if (have) {
    if (authors.length && have.authors.join('|') !== authors.join('|')) {
      have.authors = authors;
      writeShelf(shelf, root);
    }
    return { entry: have, created: false };
  }
  const id = Math.max(KINDLE_ID_BASE, ...shelf.map((e) => e.id)) + 1;
  const entry: ShelfEntry = {
    id,
    title,
    authors,
    cover: null,
    chapterCount: 0,
    addedAt: new Date().toISOString(),
    progress: null,
    shelf: 'reading',
    favorite: false,
    source: 'kindle',
  };
  writeShelf([entry, ...shelf], root);
  return { entry, created: true };
}

const BACKFILL_MARK = '.kindle-cards-v1';

/**
 * Once, for highlights kept before notebook cards existed: every waiting
 * title with no book on the shelf gets its card. Runs a single time (a mark
 * file says so), so a card she took off the shelf never comes back by itself.
 * Answers the cards it made.
 */
export function shelveWaitingNotebooks(root = libraryDir()): ShelfEntry[] {
  const mark = join(root, BACKFILL_MARK);
  if (existsSync(mark) || !existsSync(root)) return [];
  const made: ShelfEntry[] = [];
  for (const [key, slot] of Object.entries(readKindlePending(root))) {
    if (!slot?.title || !slot.highlights?.length || readShelf(root).some((e) => titleKey(e.title) === key)) continue;
    made.push(ensureKindleCard(slot.title, slot.authors ?? [], root).entry);
  }
  writeFileSync(mark, new Date().toISOString());
  return made;
}

export interface KindleNotebookView {
  id: number;
  title: string;
  authors: string[];
  cover: string | null;
  /** When a notebook for it was last brought in (the card's shelving date for older ones). */
  lastImportedAt: string;
  highlights: PendingHighlight[];
}

/** A notebook card's page: its highlights in the order Kindle printed them. */
export function readKindleCard(id: number, root = libraryDir()): KindleNotebookView | null {
  const entry = readShelf(root).find((e) => e.id === id);
  if (!entry || entry.source !== 'kindle') return null;
  const slot = readKindlePending(root)[titleKey(entry.title)];
  return {
    id: entry.id,
    title: entry.title,
    authors: entry.authors,
    cover: entry.cover,
    lastImportedAt: slot?.importedAt ?? entry.addedAt,
    highlights: slot?.highlights ?? [],
  };
}

/** The title Open Library knows: no series note in parentheses, no subtitle. */
function searchTitle(title: string): string {
  return title.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').split(/\s*[:;]\s*/)[0].replace(/\s+/g, ' ').trim() || title;
}

const COVER_LOOKUP_TIMEOUT_MS = 5_000;
const MAX_COVER_BYTES = 5 * 1024 * 1024;

/**
 * Best effort: find a notebook card's cover on Open Library by title and
 * author, keep it in covers/<id>.jpg, and point the card at it (its spine
 * color is then worked out afresh). Never throws; answers whether it found one.
 */
export async function findKindleCover(id: number, root = libraryDir(), fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<boolean> {
  try {
    const entry = readShelf(root).find((e) => e.id === id);
    if (!entry || entry.source !== 'kindle' || entry.cover) return false;
    const params = new URLSearchParams({ title: searchTitle(entry.title), limit: '1', fields: 'cover_i' });
    if (entry.authors[0]) params.set('author', entry.authors[0]);
    const found = (await getJson(fetchImpl, `https://openlibrary.org/search.json?${params}`, COVER_LOOKUP_TIMEOUT_MS)) as { docs?: Array<{ cover_i?: unknown }> } | null;
    const coverId = found?.docs?.[0]?.cover_i;
    if (typeof coverId !== 'number' || !Number.isInteger(coverId) || coverId <= 0) return false;
    // default=false: a missing image answers 404 instead of a blank placeholder.
    const res = await fetchImpl(`https://covers.openlibrary.org/b/id/${coverId}-M.jpg?default=false`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(COVER_LOOKUP_TIMEOUT_MS) });
    if (!res.ok || !res.arrayBuffer) return false;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // A real JPEG, of a sane size.
    if (bytes.length < 200 || bytes.length > MAX_COVER_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
    mkdirSync(coversDir(root), { recursive: true });
    writeFileSync(join(coversDir(root), `${id}.jpg`), bytes);
    // Re-read so a move made meanwhile isn't written over.
    const shelf = readShelf(root);
    const target = shelf.find((e) => e.id === id);
    if (!target) return false;
    target.cover = `/api/library/covers/${id}.jpg`;
    delete target.spineColor;
    writeShelf(shelf, root);
    return true;
  } catch (err) {
    console.warn('[library] no cover found for a Kindle notebook:', err instanceof Error ? err.message : err);
    return false;
  }
}

export interface KindleImportResult {
  book: { id: number; title: string } | null;
  /** The title the notebook gave, for a book that isn't on the shelf yet. */
  notebookTitle: string;
  added: number;
  duplicates: number;
  /** Highlights waiting for the book: words not found in it — or, when
   *  `pending`, every highlight kept for the book that isn't shelved yet. */
  unplaced: number;
  bookmarks: number;
  /** True when the book isn't on the shelf and the highlights wait for it. */
  pending: boolean;
  /** Set when the book isn't shelved: the notebook became (or refreshed) a
   *  notes-only card, which is `book`. `added` then counts highlights new to the
   *  card and `unplaced` every highlight on it. */
  notebookCard?: 'created' | 'updated';
}

/** Bring a parsed Kindle notebook onto the shelf. Safe to repeat: only new highlights are added. */
export function importKindleNotebook(notebook: KindleNotebook, root = libraryDir()): KindleImportResult {
  const items: PendingHighlight[] = notebook.highlights.map((h) => ({
    quote: h.text,
    color: h.color,
    note: h.note,
    chapterHint: h.chapterHint,
    page: h.page,
    createdAt: h.date ?? new Date().toISOString(),
  }));
  const key = titleKey(notebook.title);
  // A book with text wins over a notebook card of the same title.
  const entry = key ? readShelf(root).find((e) => e.source !== 'kindle' && titleKey(e.title) === key) : undefined;
  if (!entry) {
    if (!key) {
      const kept = keepPending(notebook.title, items, root);
      return { book: null, notebookTitle: notebook.title, added: 0, duplicates: kept.duplicates, unplaced: kept.waiting, bookmarks: notebook.bookmarks, pending: true };
    }
    const kept = keepPending(notebook.title, items, root, { authors: notebook.authors, importedAt: new Date().toISOString() });
    const card = ensureKindleCard(notebook.title, notebook.authors, root);
    return {
      book: { id: card.entry.id, title: card.entry.title },
      notebookTitle: notebook.title,
      added: kept.kept,
      duplicates: kept.duplicates,
      unplaced: kept.waiting,
      bookmarks: notebook.bookmarks,
      pending: true,
      notebookCard: card.created ? 'created' : 'updated',
    };
  }
  const placed = placeKindle(entry.id, items, root);
  if (placed.unplaced.length) keepPending(notebook.title, placed.unplaced, root);
  return {
    book: { id: entry.id, title: entry.title },
    notebookTitle: notebook.title,
    added: placed.added,
    duplicates: placed.duplicates,
    unplaced: placed.unplaced.length,
    bookmarks: notebook.bookmarks,
    pending: false,
  };
}

/** A book just landed on the shelf: any Kindle highlights waiting for its title go onto it. */
export function applyKindlePending(entry: { id: number; title: string }, root = libraryDir()): number {
  const key = titleKey(entry.title);
  if (!key) return 0;
  const store = readKindlePending(root);
  const slot = store[key];
  if (!slot?.highlights.length) return 0;
  const placed = placeKindle(entry.id, slot.highlights, root);
  if (placed.unplaced.length === slot.highlights.length) return 0;
  if (placed.unplaced.length) store[key] = { ...slot, highlights: placed.unplaced };
  else delete store[key];
  writeKindlePending(store, root);
  return placed.added;
}
