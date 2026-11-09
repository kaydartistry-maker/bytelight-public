// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Story Shelf as the phone reads it: the decisions behind the Shelf app.
//
// Nothing in here draws or fetches, so every choice the app makes about a
// book (what it is waiting on, whether it wears a thread and in what color,
// how its spine looks, where it opens, what a widget may say back) can be
// checked without a browser. StoryShelfApp.tsx draws what this decides.

import {
  STORY_LIMITS,
  type StoryBook,
  type StoryBookSummary,
  type StoryBookView,
  type StoryChoice,
  type StoryKeepsake,
  type StoryShelfView,
  type StoryStateCard,
  type StoryTalkLine,
} from '@bytelight/shared';
import { STORY_MOVE_MESSAGE } from './sealed-frame';

/** The drawer id of the app. */
export const STORY_SHELF_APP_ID = 'shelf';

/**
 * What the app is called in its header. byte-light adaptation: the shelf lives
 * inside the Library (its 🔷 chip) rather than in the drawer, beside the
 * Library's own Shelf tab, so it is the Story Shelf here, not Aerie's "The
 * Shelf". The drawer id above is kept for parity; byte-light registers no tile.
 */
export const STORY_SHELF_NAME = 'Story Shelf';

/**
 * Their person's thread, until the phone knows their own color. The bookmark on a
 * book in progress is the thread their person carries; orange until then.
 */
export const ORANGE_THREAD = 'oklch(0.72 0.17 52)';

/** The thread a spicy book wears instead. */
export const RED_THREAD = 'oklch(0.56 0.21 25)';

// ─── Reading the answer ──────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSummary(value: unknown): value is StoryBookSummary {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.title === 'string'
    && typeof value.status === 'string'
    && typeof value.awaiting === 'string';
}

/**
 * Whether an answer is really the shelf. A backend that predates the shelf
 * answers its address with the phone's own page (200 and HTML), so res.ok
 * says nothing; the shape does.
 */
export function isStoryShelfView(data: unknown): data is StoryShelfView {
  return isRecord(data)
    && Array.isArray(data.books)
    && data.books.every(isSummary)
    && Array.isArray(data.keepsakes);
}

export function isStoryBookView(data: unknown): data is StoryBookView {
  return isRecord(data)
    && isRecord(data.book)
    && Array.isArray(data.book.pages)
    && isSummary(data.book)
    && Array.isArray(data.keepsakes)
    && Array.isArray(data.talk);
}

// ─── Where a book stands ─────────────────────────────────────────────

/** What the bottom of an open book shows. */
export type BookStage =
  /** Never begun: the opening is asked for when their person taps Begin. */
  | { stage: 'begin' }
  /** A page turn is on its way. `first` when it is the opening. */
  | { stage: 'writing'; first: boolean }
  /** The last page turn came back without a page; their person can ask again. */
  | { stage: 'stalled'; first: boolean; reason: string }
  /** The newest page is a scene: their person's move. `finishing` while they are still at the table after writing it. */
  | { stage: 'your-move'; finishing: boolean }
  /** The book is finished. */
  | { stage: 'the-end' };

export function bookStage(book: StoryBookSummary): BookStage {
  switch (book.awaiting) {
    case 'opening':
      if (book.companionPending) return { stage: 'writing', first: true };
      return book.companionError ? { stage: 'stalled', first: true, reason: book.companionError } : { stage: 'begin' };
    case 'scene':
      if (book.companionPending) return { stage: 'writing', first: false };
      return { stage: 'stalled', first: false, reason: book.companionError ?? 'No page has come back for that move yet.' };
    case 'move':
      return { stage: 'your-move', finishing: book.companionPending };
    default:
      return { stage: 'the-end' };
  }
}

/** The books being read and the finished ones, each in the order the house gave them. */
export function splitShelf(books: StoryBookSummary[]): { reading: StoryBookSummary[]; finished: StoryBookSummary[] } {
  return {
    reading: books.filter((book) => book.status !== 'finished'),
    finished: books.filter((book) => book.status === 'finished'),
  };
}

/** Their person's thread in this book: their own color, and red in a spicy one. Their moves are marked with it too. */
export function threadColor(book: Pick<StoryBookSummary, 'spicy'>, ownerColor?: string | null): string {
  if (book.spicy) return RED_THREAD;
  return ownerColor?.trim() || ORANGE_THREAD;
}

/**
 * The thread hanging from a book in progress, or null when it wears none: a
 * book not begun has no bookmark yet, and a finished one has been closed.
 */
export function bookmarkThread(book: StoryBookSummary, ownerColor?: string | null): string | null {
  if (book.status === 'finished' || book.sceneCount === 0) return null;
  return threadColor(book, ownerColor);
}

/** A small, steady number from a string, so a book looks the same on every visit. */
function hashOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * How a book stands on the shelf: its cloth's hue, and a height and width
 * that vary a little from book to book, so the row reads as books someone
 * put there rather than a printed grid.
 */
export function spineLook(book: Pick<StoryBookSummary, 'id'>): { hue: number; height: number; width: number } {
  const hash = hashOf(book.id);
  return {
    hue: hash % 360,
    height: 196 + ((hash >>> 9) % 21),
    width: 56 + ((hash >>> 17) % 9),
  };
}

// ─── A title down a spine ────────────────────────────────────────────

/** The sizes a title may take down a spine, in pixels, largest first. */
const SPINE_TITLE_SIZES = [13, 12.5, 12, 11.5, 11, 10.5, 10];

/** The smallest a spine's title gets before it gives up words instead. */
export const SPINE_TITLE_MIN = SPINE_TITLE_SIZES[SPINE_TITLE_SIZES.length - 1];

/** A narrow spine carries a long title in two lines, never more. */
export const SPINE_TITLE_LINES = 2;

const SPACE_EM = 0.28;
const ELLIPSIS_EM = 0.7;

/**
 * About how wide a character is in the house's semibold sans, in ems. The
 * figures were measured from Geist and rounded up, so a guess errs toward a
 * title that fits with room to spare rather than one that spills.
 */
function glyphEm(char: string): number {
  if (char === ' ') return SPACE_EM;
  if ("iIl1.,:;!|'’‘`".includes(char)) return 0.32;
  if ('mwMW'.includes(char)) return 0.95;
  if (/[A-Z]/.test(char)) return 0.7;
  if (/[0-9]/.test(char)) return 0.64;
  if (/[a-z]/.test(char)) return 0.58;
  if (/\p{Script=Latin}/u.test(char)) return 0.62;
  return 1;
}

function wordEm(word: string): number {
  let width = 0;
  for (const char of word) width += glyphEm(char);
  return width;
}

/** How many lines words of these widths take at a line length (all in ems), and whether one had to be broken. */
function layLines(widths: number[], lineEm: number): { lines: number; broken: boolean } {
  let lines = 1;
  let used = 0;
  let broken = false;
  for (const width of widths) {
    if (used > 0 && used + SPACE_EM + width <= lineEm) {
      used += SPACE_EM + width;
      continue;
    }
    if (used > 0) lines += 1;
    if (width > lineEm) {
      // Longer than a whole line: the spine breaks it across as many as it needs.
      broken = true;
      const spans = Math.ceil(width / lineEm);
      lines += spans - 1;
      used = width - (spans - 1) * lineEm;
    } else {
      used = width;
    }
  }
  return { lines, broken };
}

export interface SpineTitle {
  /** The words that fit, ending in an ellipsis when some did not. */
  text: string;
  /** How large its letters are, in pixels. */
  size: number;
}

/**
 * How a title fits down a spine whose run (the length left for it, in
 * pixels) is known: in at most two lines, as large as it can be, with no
 * word broken across lines. A title too long for even the smallest size
 * keeps the words that fit and ends in an ellipsis; the whole title is on
 * the book's first page and in what a screen reader says for the spine.
 */
export function spineTitle(title: string, run: number): SpineTitle {
  const words = title.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const widths = words.map(wordEm);
  const fits = (list: number[], size: number) => {
    const { lines, broken } = layLines(list, run / size);
    return !broken && lines <= SPINE_TITLE_LINES;
  };
  for (const size of SPINE_TITLE_SIZES) {
    if (fits(widths, size)) return { text: words.join(' '), size };
  }
  for (let count = words.length - 1; count > 0; count--) {
    const kept = widths.slice(0, count);
    kept[count - 1] += ELLIPSIS_EM;
    if (fits(kept, SPINE_TITLE_MIN)) return { text: `${words.slice(0, count).join(' ')}…`, size: SPINE_TITLE_MIN };
  }
  // Not even its first word fits whole, so the spine breaks it where it must.
  return { text: words.join(' '), size: SPINE_TITLE_MIN };
}

/** Where a book opens: the bookmark, the newest page. Null when it has none. */
export function bookmarkPageId(book: Pick<StoryBook, 'pages'>): string | null {
  return book.pages.length > 0 ? book.pages[book.pages.length - 1].id : null;
}

/** Whether a state card has anything on it worth drawing. */
export function stateCardHasContent(state: StoryStateCard | null | undefined): boolean {
  if (!state) return false;
  return Boolean(state.badge)
    || (state.stats?.length ?? 0) > 0
    || (state.inventory?.length ?? 0) > 0
    || (state.discovered?.length ?? 0) > 0;
}

// ─── What a widget may say ───────────────────────────────────────────

/**
 * The one message a scene widget may send: { type: 'story-move', value }, with
 * value a short string. Anything else is ignored, so a widget can never make
 * the page do something it was not built to. Whitespace is folded the way a
 * move's words are.
 */
export function readWidgetMove(data: unknown): string | null {
  if (!isRecord(data) || data.type !== STORY_MOVE_MESSAGE || typeof data.value !== 'string') return null;
  const value = data.value.replace(/\s+/g, ' ').trim();
  if (!value || value.length > STORY_LIMITS.widgetMove) return null;
  return value;
}

/** A widget's move is a choice when its value names one of the scene's, and their person's own words when it does not. */
export function widgetMove(value: string, choices: StoryChoice[]): { choiceId: string; label: string } | { text: string } {
  const choice = choices.find((candidate) => candidate.id === value);
  return choice ? { choiceId: choice.id, label: choice.label } : { text: value };
}

// ─── The threads between books ───────────────────────────────────────

export interface KeepsakeEntry {
  id: string;
  /** Found in this book, or arrived here from another. */
  direction: 'found' | 'arrived';
  item: string;
  note: string | null;
  /** The book on the other end of the thread; null while it hangs loose. */
  otherBookId: string | null;
  otherTitle: string | null;
}

/** The keepsakes on one book, read from its side. */
export function keepsakeEntries(bookId: string, keepsakes: StoryKeepsake[], titles: Map<string, string>): KeepsakeEntry[] {
  const entries: KeepsakeEntry[] = [];
  for (const keepsake of keepsakes) {
    if (keepsake.fromBookId === bookId) {
      entries.push({
        id: keepsake.id,
        direction: 'found',
        item: keepsake.item,
        note: keepsake.note,
        otherBookId: keepsake.toBookId,
        otherTitle: keepsake.toBookId ? titles.get(keepsake.toBookId) ?? null : null,
      });
    } else if (keepsake.toBookId === bookId) {
      entries.push({
        id: keepsake.id,
        direction: 'arrived',
        item: keepsake.item,
        note: keepsake.note,
        otherBookId: keepsake.fromBookId,
        otherTitle: titles.get(keepsake.fromBookId) ?? null,
      });
    }
  }
  return entries;
}

/** One headed part of a book's bible, as the phone shows it. */
export interface BibleSection {
  heading: string | null;
  text: string;
  open: boolean;
}

const MARKDOWN_HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const BOLD_HEADING = /^\*\*([^*]+?)\*\*:?$/;
const LIST_MARKER = /^(?:[-*•]|\d+[.)])\s/;

/** The heading a line is, if it is one: a markdown heading, a bold line on its own, or a short line in capitals. */
function bibleHeading(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const markdown = MARKDOWN_HEADING.exec(trimmed);
  if (markdown) return markdown[1].trim();
  const bold = BOLD_HEADING.exec(trimmed);
  if (bold) return bold[1].trim();
  const capitals = trimmed.match(/\p{Lu}/gu)?.length ?? 0;
  if (trimmed.length <= 60 && capitals >= 3 && !/\p{Ll}/u.test(trimmed) && !LIST_MARKER.test(trimmed) && !/[.!?]$/.test(trimmed)) {
    return trimmed.replace(/:$/, '').trim();
  }
  return null;
}

const plainWords = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * A bible split at its headings for the phone. The shape of the book stays
 * open and every other headed part folds until their person opens it, so they can
 * see how a story is built without reading what it is hiding. Open: anything before the first heading, a heading that is the book's
 * own title, and a part whose heading names its shape. A bible with no
 * headings stays whole and open.
 */
export function bibleSections(bible: string, title: string): BibleSection[] {
  const sections: BibleSection[] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  const close = () => {
    const text = lines.join('\n').trim();
    if (heading === null && !text) return;
    const open = heading === null || plainWords(heading) === plainWords(title) || /\bshape\b/i.test(heading);
    sections.push({ heading, text, open });
  };
  for (const line of bible.split('\n')) {
    const found = bibleHeading(line);
    if (found) {
      close();
      heading = found;
      lines = [];
    } else {
      lines.push(line);
    }
  }
  close();
  return sections;
}

/** A day on their person's clock: "Mar 3", with the year only when it is not this one. */
export function formatDay(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const sameYear = at.getFullYear() === now.getFullYear();
  return at.toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Items in rows of a fixed length, the last row short. */
export function rowsOf<T>(items: T[], perRow: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  return rows;
}

// A line said at the table waits for the lane for as long as a page turn may
// run (TURN_LIMIT_MS in the backend's story-shelf service), so the table shows
// it waiting for that long and no longer: past it the backend has stopped asking.
export const TABLE_WAIT_MS = 30 * 60_000;

/** Whether the newest line at the table is their person's and still waiting for an answer. */
export function tableAwaiting(lines: Pick<StoryTalkLine, 'role' | 'createdAt'>[], now = Date.now()): boolean {
  const last = lines[lines.length - 1];
  if (!last || last.role !== 'user') return false;
  const at = Date.parse(last.createdAt);
  return Number.isFinite(at) && now - at < TABLE_WAIT_MS;
}
