// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * The Story Shelf — choose-your-own-path books the companions write and run.
 *
 * A book goes on the shelf with its bible, the base story they wrote for it.
 * Its pages go in order: a scene is a companion's, a move is their person's, and
 * each scene answers the move before it. The companions write through the
 * loopback routes; their person reads and moves from the phone, which never writes
 * a scene.
 *
 * WHO MAY WRITE. Any companion in the house, on any book. They write together,
 * so a scene carries its own author rather than the book carrying an owner. A
 * move is only ever their person's, through the phone's door.
 *
 * ONE MOVE, THEN A SCENE. A move is only taken while the newest page is a
 * scene. That is also what stops a double tap from going in twice: the second
 * tap finds the first move on top and is refused. The page turn's own
 * bookkeeping (companion_pending, companion_error) lives here; queueing the
 * turn and talking to the companions' lane is services/story-shelf.ts.
 *
 * This module is the only writer to the three tables and validates every
 * status and kind itself; the migration deliberately has no CHECK lists (047).
 *
 * byte-light adaptations (ported from Aerie): companions are byte-light's
 * registry rows (services/db/rooms.ts), where the row id IS the slug, so
 * Aerie's getCompanionBySlug / `.slug` read listCompanions() / `.id` here; and
 * the shelf's thread is seated at creation (createThread companionIds), since
 * byte-light has no primary/participant split (assignCompanionToThread).
 * Both the same way the Card Room port reads them (services/db/cards.ts).
 */

import crypto from 'crypto';
import {
  STORY_LIMITS,
  STORY_OWNER_AUTHOR,
  type Message,
  type StoryAwaiting,
  type StoryBook,
  type StoryBookStatus,
  type StoryBookSummary,
  type StoryChoice,
  type StoryKeepsake,
  type StoryPage,
  type StoryPageKind,
  type StoryStat,
  type StoryStateCard,
  type StoryTalkLine,
} from '@bytelight/shared';
import { getDb } from './state.js';
import { getConfig, setConfig } from './config.js';
import { createThread, getThread } from './threads.js';
import { createMessage } from './messages.js';
import { listCompanions, type Companion } from './rooms.js';

export class StoryShelfError extends Error {
  constructor(public status: 400 | 404 | 409 | 503, message: string) {
    super(message);
    this.name = 'StoryShelfError';
  }
}

/** Said when a page turn ends and the book is still waiting on the page it was for. */
export const TURN_ENDED_EMPTY = 'The page turn ended without a new page. Ask again when you are ready.';

const FINISHED = 'That book is finished. A new story is a new book.';

interface BookRow {
  id: string;
  title: string;
  genre: string;
  spicy: number;
  blurb: string | null;
  bible: string;
  cover_url: string | null;
  created_by: string;
  status: StoryBookStatus;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  opened_at: string | null;
  companion_pending: number;
  companion_error: string | null;
}

interface PageRow {
  id: string;
  book_id: string;
  at: string;
  kind: StoryPageKind;
  author: string;
  text: string;
  image_url: string | null;
  state_json: string | null;
  choices_json: string | null;
  widget: string | null;
  choice_id: string | null;
}

/** Just enough of a page to say where a book stands. */
type PageMark = Pick<PageRow, 'id' | 'book_id' | 'at' | 'kind'>;

interface KeepsakeRow {
  id: string;
  item: string;
  note: string | null;
  from_book_id: string;
  to_book_id: string | null;
  maker: string;
  created_at: string;
  woven_at: string | null;
}

const now = () => new Date().toISOString();

// ─── Validation ──────────────────────────────────────────────────────

function textOrNull(raw: unknown, field: string, max: number, singleLine: boolean): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new StoryShelfError(400, `${field} must be text.`);
  const value = singleLine ? raw.replace(/\s+/g, ' ').trim() : raw.trim();
  if (!value) return null;
  if (value.length > max) {
    throw new StoryShelfError(400, `${field} must be ${max} characters or fewer (it was ${value.length}).`);
  }
  return value;
}

/** Optional text; a title-like field is folded onto one line. */
export function optionalStoryText(raw: unknown, field: string, max: number, singleLine = false): string | null {
  return textOrNull(raw, field, max, singleLine);
}

export function requiredStoryText(raw: unknown, field: string, max: number, singleLine = false): string {
  const value = textOrNull(raw, field, max, singleLine);
  if (!value) throw new StoryShelfError(400, `${field} is required.`);
  return value;
}

/** The companion writing, who may be any companion in the house. */
export function storyMaker(rawMaker: unknown): Companion {
  const slug = typeof rawMaker === 'string' ? rawMaker.trim() : '';
  if (!slug) throw new StoryShelfError(400, 'maker is required: the slug of the companion writing.');
  const companion = listCompanions().find((candidate) => candidate.id === slug);
  if (!companion) throw new StoryShelfError(400, `Unknown companion slug '${slug}'.`);
  return companion;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function spicyFlag(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') throw new StoryShelfError(400, 'spicy must be true or false.');
  return raw;
}

function idOf(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

const STATE_KEYS = ['badge', 'stats', 'inventory', 'discovered'];
const STATS_SHAPE = 'stats must be a list of { label, value }, where value is a short line or a number.';

function statList(raw: unknown): StoryStat[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new StoryShelfError(400, STATS_SHAPE);
  if (raw.length > STORY_LIMITS.stats) {
    throw new StoryShelfError(400, `stats can hold at most ${STORY_LIMITS.stats} lines (it had ${raw.length}).`);
  }
  return raw.map((entry) => {
    if (!isPlainObject(entry)) throw new StoryShelfError(400, STATS_SHAPE);
    const rawValue = typeof entry.value === 'number' && Number.isFinite(entry.value) ? String(entry.value) : entry.value;
    if (typeof entry.label !== 'string' || typeof rawValue !== 'string') throw new StoryShelfError(400, STATS_SHAPE);
    const label = optionalStoryText(entry.label, 'a stat label', STORY_LIMITS.statLabel, true);
    const value = optionalStoryText(rawValue, 'a stat value', STORY_LIMITS.statValue, true);
    if (!label || !value) throw new StoryShelfError(400, STATS_SHAPE);
    return { label, value };
  });
}

function lineList(raw: unknown, field: string, max: number): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
    throw new StoryShelfError(400, `${field} must be a list of short lines.`);
  }
  if (raw.length > STORY_LIMITS.listItems) {
    throw new StoryShelfError(400, `${field} can hold at most ${STORY_LIMITS.listItems} lines (it had ${raw.length}).`);
  }
  return raw
    .map((item) => optionalStoryText(item, `a line in ${field}`, max, true))
    .filter((item): item is string => item !== null);
}

/**
 * A scene's state card, or null when it says nothing. Strict about its keys,
 * because the phone only draws these four and a card that quietly dropped a
 * fifth would look written and read empty.
 */
export function normalizeStoryState(raw: unknown): StoryStateCard | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    throw new StoryShelfError(400, 'state must be an object: { badge?, stats?, inventory?, discovered? }.');
  }
  const extra = Object.keys(raw).filter((key) => !STATE_KEYS.includes(key));
  if (extra.length > 0) {
    throw new StoryShelfError(400, `state can only carry badge, stats, inventory and discovered (it had ${extra.join(', ')}).`);
  }
  const card: StoryStateCard = {};
  const badge = optionalStoryText(raw.badge, 'state.badge', STORY_LIMITS.badge, true);
  if (badge) card.badge = badge;
  const stats = statList(raw.stats);
  if (stats.length > 0) card.stats = stats;
  const inventory = lineList(raw.inventory, 'inventory', STORY_LIMITS.inventoryItem);
  if (inventory.length > 0) card.inventory = inventory;
  const discovered = lineList(raw.discovered, 'discovered', STORY_LIMITS.discoveredItem);
  if (discovered.length > 0) card.discovered = discovered;
  return Object.keys(card).length > 0 ? card : null;
}

const CHOICE_ID = /^[A-Za-z0-9_-]+$/;
const CHOICES_SHAPE = 'choices must be a list of { id?, label, hint? }.';

/** A scene's choices. A choice without an id is numbered by its place: c1, c2… */
export function normalizeStoryChoices(raw: unknown): StoryChoice[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new StoryShelfError(400, CHOICES_SHAPE);
  if (raw.length > STORY_LIMITS.choices) {
    throw new StoryShelfError(400, `A scene offers at most ${STORY_LIMITS.choices} choices (it had ${raw.length}).`);
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    if (!isPlainObject(entry)) throw new StoryShelfError(400, CHOICES_SHAPE);
    const label = optionalStoryText(entry.label, `choice ${index + 1}'s label`, STORY_LIMITS.choiceLabel, true);
    if (!label) throw new StoryShelfError(400, `choice ${index + 1} needs a label: the words their person taps.`);
    const id = entry.id === undefined || entry.id === null || entry.id === '' ? `c${index + 1}` : entry.id;
    if (typeof id !== 'string' || !CHOICE_ID.test(id) || id.length > STORY_LIMITS.choiceId) {
      throw new StoryShelfError(
        400,
        `choice id '${String(id)}' must be letters, digits, dashes or underscores, ${STORY_LIMITS.choiceId} at most.`,
      );
    }
    if (seen.has(id)) throw new StoryShelfError(400, `choice id '${id}' is used twice in one scene.`);
    seen.add(id);
    const hint = optionalStoryText(entry.hint, `choice ${index + 1}'s hint`, STORY_LIMITS.choiceHint, true);
    return hint ? { id, label, hint } : { id, label };
  });
}

function widgetSource(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new StoryShelfError(400, 'widget must be text: the source of its component.');
  const source = raw.trim();
  if (!source) return null;
  if (source.length > STORY_LIMITS.widget) {
    throw new StoryShelfError(400, `widget must be ${STORY_LIMITS.widget} characters or fewer (it was ${source.length}).`);
  }
  return source;
}

// ─── Reading ─────────────────────────────────────────────────────────

function bookRow(id: string): BookRow | undefined {
  return getDb().prepare('SELECT * FROM story_books WHERE id = ?').get(id) as BookRow | undefined;
}

function requireBook(id: unknown): BookRow {
  const row = bookRow(idOf(id));
  if (!row) throw new StoryShelfError(404, 'There is no book with that id on the shelf.');
  return row;
}

function pageRow(id: string): PageRow | undefined {
  return getDb().prepare('SELECT * FROM story_pages WHERE id = ?').get(id) as PageRow | undefined;
}

/**
 * The id of a book that exists, or the same refusal a write would give. Asked
 * before anything slow, such as a gallery lookup, so a mistyped id is told
 * about first.
 */
export function requireStoryBookId(id: unknown): string {
  return requireBook(id).id;
}

/** The id of a scene that exists, asked before anything slow for the same reason. */
export function requireStorySceneId(id: unknown): string {
  const page = pageRow(idOf(id));
  if (!page) throw new StoryShelfError(404, 'There is no page with that id in any book.');
  if (page.kind !== 'scene') throw new StoryShelfError(400, 'Only a scene has a picture, and that page is a move.');
  return page.id;
}

function pageRowsFor(bookId: string): PageRow[] {
  return getDb().prepare('SELECT * FROM story_pages WHERE book_id = ? ORDER BY at, rowid').all(bookId) as PageRow[];
}

function newestPage(bookId: string): PageMark | undefined {
  return getDb()
    .prepare('SELECT id, book_id, at, kind FROM story_pages WHERE book_id = ? ORDER BY at DESC, rowid DESC LIMIT 1')
    .get(bookId) as PageMark | undefined;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function pageView(row: PageRow): StoryPage {
  return {
    id: row.id,
    bookId: row.book_id,
    at: row.at,
    kind: row.kind,
    author: row.author,
    text: row.text,
    imageUrl: row.image_url,
    state: parseJson<StoryStateCard | null>(row.state_json, null),
    choices: parseJson<StoryChoice[]>(row.choices_json, []),
    widget: row.widget,
    choiceId: row.choice_id,
  };
}

function awaitingOf(row: BookRow, marks: PageMark[]): StoryAwaiting {
  if (row.status === 'finished') return 'nothing';
  if (!marks.some((mark) => mark.kind === 'scene')) return 'opening';
  return marks[marks.length - 1].kind === 'move' ? 'scene' : 'move';
}

/** A book as the shelf lists it. `marks` are its pages, oldest first. */
function summarize(row: BookRow, marks: PageMark[]): StoryBookSummary {
  const newest = marks.length > 0 ? marks[marks.length - 1] : null;
  return {
    id: row.id,
    title: row.title,
    genre: row.genre,
    spicy: row.spicy === 1,
    blurb: row.blurb,
    coverUrl: row.cover_url,
    createdBy: row.created_by,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    openedAt: row.opened_at,
    pageCount: marks.length,
    sceneCount: marks.filter((mark) => mark.kind === 'scene').length,
    // Where their person left off is the newest page: the scene to answer, or
    // their own move when the page answering it has not arrived yet.
    bookmark: newest ? { pageId: newest.id, at: newest.at } : null,
    awaiting: awaitingOf(row, marks),
    companionPending: row.companion_pending === 1,
    companionError: row.companion_error,
  };
}

export function getStoryBook(id: string): StoryBook | null {
  const row = bookRow(id);
  if (!row) return null;
  const pages = pageRowsFor(row.id);
  return { ...summarize(row, pages), bible: row.bible, pages: pages.map(pageView) };
}

/**
 * Every book on the shelf. The ones being read come first, led by whichever
 * their person was in last, so the book they put down is the first one they see; the
 * finished ones follow, newest finished first.
 */
export function listStoryBooks(): StoryBookSummary[] {
  const db = getDb();
  const marks = new Map<string, PageMark[]>();
  for (const mark of db.prepare('SELECT id, book_id, at, kind FROM story_pages ORDER BY at, rowid').all() as PageMark[]) {
    const list = marks.get(mark.book_id);
    if (list) list.push(mark);
    else marks.set(mark.book_id, [mark]);
  }
  const rows = db.prepare(`
    SELECT * FROM story_books
    ORDER BY CASE status WHEN 'finished' THEN 1 ELSE 0 END,
             CASE WHEN status = 'finished' THEN COALESCE(finished_at, updated_at)
                  ELSE max(COALESCE(opened_at, ''), updated_at) END DESC,
             rowid DESC
  `).all() as BookRow[];
  return rows.map((row) => summarize(row, marks.get(row.id) ?? []));
}

function keepsakeView(row: KeepsakeRow): StoryKeepsake {
  return {
    id: row.id,
    item: row.item,
    note: row.note,
    fromBookId: row.from_book_id,
    toBookId: row.to_book_id,
    maker: row.maker,
    createdAt: row.created_at,
    wovenAt: row.woven_at,
  };
}

/** Every keepsake, or every one found in a book or woven into it. Oldest first. */
export function listStoryKeepsakes(bookId?: string): StoryKeepsake[] {
  const db = getDb();
  const rows = bookId
    ? db.prepare('SELECT * FROM story_keepsakes WHERE from_book_id = ? OR to_book_id = ? ORDER BY created_at, rowid').all(bookId, bookId)
    : db.prepare('SELECT * FROM story_keepsakes ORDER BY created_at, rowid').all();
  return (rows as KeepsakeRow[]).map(keepsakeView);
}

// ─── The companions' writes ──────────────────────────────────────────

/** Put a new book on the shelf. Its opening is written when their person begins it. */
export function createStoryBook(input: {
  maker: unknown;
  title: unknown;
  genre: unknown;
  spicy?: unknown;
  blurb?: unknown;
  bible: unknown;
}): StoryBook {
  const maker = storyMaker(input.maker);
  const title = requiredStoryText(input.title, 'title', STORY_LIMITS.title, true);
  const genre = requiredStoryText(input.genre, 'genre', STORY_LIMITS.genre, true);
  const spicy = spicyFlag(input.spicy);
  const blurb = optionalStoryText(input.blurb, 'blurb', STORY_LIMITS.blurb);
  const bible = requiredStoryText(input.bible, 'bible', STORY_LIMITS.bible);
  const id = crypto.randomUUID();
  const at = now();
  getDb().prepare(`
    INSERT INTO story_books (id, title, genre, spicy, blurb, bible, created_by, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'reading', ?, ?)
  `).run(id, title, genre, spicy ? 1 : 0, blurb, bible, maker.id, at, at);
  return getStoryBook(id)!;
}

/** Hang a cover on a book. The URL has already been checked against the gallery. */
export function setStoryCover(bookId: string, input: { maker: unknown; coverUrl: string }): StoryBook {
  storyMaker(input.maker);
  const book = requireBook(bookId);
  getDb().prepare('UPDATE story_books SET cover_url = ?, updated_at = ? WHERE id = ?').run(input.coverUrl, now(), book.id);
  return getStoryBook(book.id)!;
}

/**
 * Write a scene. A page arriving is the answer to whatever was waiting on it,
 * so it clears any complaint about a page turn that came back empty; whether a
 * turn is still running is the turn's own business and is left alone.
 */
export function addStoryScene(bookId: string, input: {
  maker: unknown;
  text: unknown;
  imageUrl?: string | null;
  state?: unknown;
  choices?: unknown;
  widget?: unknown;
}): { book: StoryBook; page: StoryPage } {
  const maker = storyMaker(input.maker);
  const book = requireBook(bookId);
  if (book.status === 'finished') throw new StoryShelfError(409, FINISHED);
  const text = requiredStoryText(input.text, 'text', STORY_LIMITS.sceneText);
  const state = normalizeStoryState(input.state);
  const choices = normalizeStoryChoices(input.choices);
  const widget = widgetSource(input.widget);
  const id = crypto.randomUUID();
  const at = now();
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO story_pages (id, book_id, at, kind, author, text, image_url, state_json, choices_json, widget, choice_id)
      VALUES (?, ?, ?, 'scene', ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id, book.id, at, maker.id, text, input.imageUrl ?? null,
      state ? JSON.stringify(state) : null, choices.length > 0 ? JSON.stringify(choices) : null, widget,
    );
    db.prepare('UPDATE story_books SET updated_at = ?, companion_error = NULL WHERE id = ?').run(at, book.id);
  })();
  return { book: getStoryBook(book.id)!, page: pageView(pageRow(id)!) };
}

/** Put a picture on a scene that is already written. The URL has already been checked against the gallery. */
export function setStoryScenePicture(pageId: string, input: { maker: unknown; imageUrl: string }): {
  book: StoryBook;
  page: StoryPage;
} {
  storyMaker(input.maker);
  const page = pageRow(idOf(pageId));
  if (!page) throw new StoryShelfError(404, 'There is no page with that id in any book.');
  if (page.kind !== 'scene') throw new StoryShelfError(400, 'Only a scene has a picture, and that page is a move.');
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE story_pages SET image_url = ? WHERE id = ?').run(input.imageUrl, page.id);
    db.prepare('UPDATE story_books SET updated_at = ? WHERE id = ?').run(now(), page.book_id);
  })();
  return { book: getStoryBook(page.book_id)!, page: pageView(pageRow(page.id)!) };
}

/** Close a book. It stays on the shelf, finished, and takes no more pages. */
export function finishStoryBook(bookId: string, input: { maker: unknown }): StoryBook {
  storyMaker(input.maker);
  const book = requireBook(bookId);
  if (book.status === 'finished') throw new StoryShelfError(409, 'That book is already finished.');
  const at = now();
  getDb()
    .prepare("UPDATE story_books SET status = 'finished', finished_at = ?, updated_at = ? WHERE id = ?")
    .run(at, at, book.id);
  return getStoryBook(book.id)!;
}

// ─── Keepsakes: the threads between books ────────────────────────────

function keepsakeRow(id: string): KeepsakeRow | undefined {
  return getDb().prepare('SELECT * FROM story_keepsakes WHERE id = ?').get(id) as KeepsakeRow | undefined;
}

/** Tie a keepsake found in one book. It hangs loose until it turns up in another, unless toBookId says where now. */
export function createStoryKeepsake(input: {
  maker: unknown;
  fromBookId: unknown;
  item: unknown;
  note?: unknown;
  toBookId?: unknown;
}): StoryKeepsake {
  const maker = storyMaker(input.maker);
  if (!idOf(input.fromBookId)) throw new StoryShelfError(400, 'fromBookId is required: the book it was found in.');
  const from = requireBook(input.fromBookId);
  const item = requiredStoryText(input.item, 'item', STORY_LIMITS.keepsakeItem, true);
  const note = optionalStoryText(input.note, 'note', STORY_LIMITS.keepsakeNote);
  let toId: string | null = null;
  if (idOf(input.toBookId)) {
    toId = requireBook(input.toBookId).id;
    if (toId === from.id) throw new StoryShelfError(400, 'A keepsake runs between two different books.');
  }
  const id = crypto.randomUUID();
  const at = now();
  getDb().prepare(`
    INSERT INTO story_keepsakes (id, item, note, from_book_id, to_book_id, maker, created_at, woven_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, item, note, from.id, toId, maker.id, at, toId ? at : null);
  return keepsakeView(keepsakeRow(id)!);
}

/** The keepsake turns up in a second book. Weaving it into the same book again only updates its note. */
export function weaveStoryKeepsake(keepsakeId: string, input: { maker: unknown; toBookId: unknown; note?: unknown }): StoryKeepsake {
  storyMaker(input.maker);
  const row = keepsakeRow(idOf(keepsakeId));
  if (!row) throw new StoryShelfError(404, 'There is no keepsake with that id.');
  if (!idOf(input.toBookId)) throw new StoryShelfError(400, 'toBookId is required: the book it turns up in.');
  const to = requireBook(input.toBookId);
  if (row.to_book_id && row.to_book_id !== to.id) {
    const woven = bookRow(row.to_book_id);
    throw new StoryShelfError(409, `That keepsake is already woven into “${woven?.title ?? 'another book'}”.`);
  }
  if (to.id === row.from_book_id) throw new StoryShelfError(400, 'A keepsake runs between two different books.');
  const note = optionalStoryText(input.note, 'note', STORY_LIMITS.keepsakeNote) ?? row.note;
  getDb()
    .prepare('UPDATE story_keepsakes SET to_book_id = ?, note = ?, woven_at = COALESCE(woven_at, ?) WHERE id = ?')
    .run(to.id, note, now(), row.id);
  return keepsakeView(keepsakeRow(row.id)!);
}

// ─── Their person's moves, and the page turns that answer them ──────────

/**
 * Their person's move, checked against the newest scene. It is only taken while that
 * scene is on top, so a second tap is refused rather than going in twice, and
 * it marks the book as having a page turn on its way.
 */
export function recordStoryMove(bookId: string, input: { choiceId?: unknown; text?: unknown }): {
  book: StoryBook;
  page: StoryPage;
} {
  const db = getDb();
  const id = crypto.randomUUID();
  let ownBookId = '';
  db.transaction(() => {
    const book = requireBook(bookId);
    ownBookId = book.id;
    if (book.status === 'finished') throw new StoryShelfError(409, FINISHED);
    const newest = newestPage(book.id);
    if (!newest) throw new StoryShelfError(409, 'That book has no scene to answer yet: its opening has not been written.');
    if (newest.kind === 'move') throw new StoryShelfError(409, 'Your move is already in; the next page answers it.');

    const hasChoice = idOf(input.choiceId) !== '';
    const hasText = typeof input.text === 'string' ? input.text.trim() !== '' : input.text !== undefined && input.text !== null;
    if (hasChoice && hasText) throw new StoryShelfError(400, 'A move is a choice id or your own words, not both.');
    if (!hasChoice && !hasText) throw new StoryShelfError(400, 'A move needs a choice id or your own words.');

    let text: string;
    let choiceId: string | null = null;
    if (hasChoice) {
      choiceId = idOf(input.choiceId);
      const scene = pageView(pageRow(newest.id)!);
      const choice = scene.choices.find((candidate) => candidate.id === choiceId);
      if (!choice) throw new StoryShelfError(400, `The newest scene has no choice '${choiceId}'.`);
      text = choice.label;
    } else {
      text = requiredStoryText(input.text, 'Your move', STORY_LIMITS.moveText);
    }

    const at = now();
    db.prepare(`
      INSERT INTO story_pages (id, book_id, at, kind, author, text, image_url, state_json, choices_json, widget, choice_id)
      VALUES (?, ?, ?, 'move', ?, ?, NULL, NULL, NULL, NULL, ?)
    `).run(id, book.id, at, STORY_OWNER_AUTHOR, text, choiceId);
    db.prepare(`
      UPDATE story_books SET companion_pending = 1, companion_error = NULL, updated_at = ?, opened_at = ? WHERE id = ?
    `).run(at, at, book.id);
  })();
  return { book: getStoryBook(ownBookId)!, page: pageView(pageRow(id)!) };
}

/**
 * Their person opened a book. That is remembered, so the shelf leads with it.
 * A book with no opening and nothing on its way reserves its opening turn,
 * which the caller then sends; a started book needs nothing, because the
 * bookmark is enough.
 */
export function reserveStoryOpening(bookId: string): { book: StoryBook; dispatch: boolean } {
  const db = getDb();
  let dispatch = false;
  let ownBookId = '';
  db.transaction(() => {
    const book = requireBook(bookId);
    ownBookId = book.id;
    db.prepare('UPDATE story_books SET opened_at = ? WHERE id = ?').run(now(), book.id);
    const started = Boolean(db.prepare("SELECT 1 FROM story_pages WHERE book_id = ? AND kind = 'scene' LIMIT 1").get(book.id));
    if (book.status === 'reading' && !started && book.companion_pending === 0) {
      db.prepare('UPDATE story_books SET companion_pending = 1, companion_error = NULL WHERE id = ?').run(book.id);
      dispatch = true;
    }
  })();
  return { book: getStoryBook(ownBookId)!, dispatch };
}

/**
 * Ask again for a page turn that did not come back: the opening, or the page
 * answering the newest move. Refused while a turn is already on its way, and
 * when nothing is waiting on a page at all.
 */
export function reserveStoryRetry(bookId: string): { book: StoryBook; kind: 'opening' | 'move'; pageId: string | null } {
  const db = getDb();
  let kind: 'opening' | 'move' = 'opening';
  let pageId: string | null = null;
  let ownBookId = '';
  db.transaction(() => {
    const book = requireBook(bookId);
    ownBookId = book.id;
    if (book.status === 'finished') throw new StoryShelfError(409, FINISHED);
    if (book.companion_pending === 1) throw new StoryShelfError(409, 'A page turn is already under way for this book.');
    const newest = newestPage(book.id);
    if (newest && newest.kind === 'scene') {
      throw new StoryShelfError(409, 'Nothing is waiting on a page: the newest page is a scene, so the next move is yours.');
    }
    kind = newest ? 'move' : 'opening';
    pageId = newest?.id ?? null;
    db.prepare('UPDATE story_books SET companion_pending = 1, companion_error = NULL WHERE id = ?').run(book.id);
  })();
  return { book: getStoryBook(ownBookId)!, kind, pageId };
}

/**
 * A page turn ended. While another is still queued for the book it stays
 * pending. Otherwise it is settled, and if the book is still waiting on the
 * page the turn was for, it says why: the turn's own reason when it gave one,
 * the plain sentence when it did not.
 */
export function settleStoryTurn(bookId: string, outcome: { pending: boolean; failure: string | null }): StoryBook | null {
  const row = bookRow(bookId);
  if (!row) return null;
  if (outcome.pending) {
    getDb().prepare('UPDATE story_books SET companion_pending = 1 WHERE id = ?').run(row.id);
    return getStoryBook(row.id);
  }
  const marks = getDb()
    .prepare('SELECT id, book_id, at, kind FROM story_pages WHERE book_id = ? ORDER BY at, rowid')
    .all(row.id) as PageMark[];
  const awaiting = awaitingOf(row, marks);
  const stillWaiting = awaiting === 'opening' || awaiting === 'scene';
  const error = stillWaiting ? (outcome.failure?.trim() || TURN_ENDED_EMPTY) : null;
  getDb().prepare('UPDATE story_books SET companion_pending = 0, companion_error = ? WHERE id = ?').run(error, row.id);
  return getStoryBook(row.id);
}

/** Mark a book as having a page turn on its way, as a turn is queued for it. */
export function markStoryTurnPending(bookId: string): void {
  getDb().prepare('UPDATE story_books SET companion_pending = 1, companion_error = NULL WHERE id = ?').run(bookId);
}

// ─── The shelf's conversation ────────────────────────────────────────

const STORY_THREAD_CONFIG_KEY = 'storyshelf.thread_id';

/** The shelf's thread, if it has one yet. Reading never makes one. */
export function storyShelfThreadId(): string | null {
  const id = getConfig(STORY_THREAD_CONFIG_KEY);
  return id && getThread(id) ? id : null;
}

export function ensureStoryShelfThread(): string {
  const existing = storyShelfThreadId();
  if (existing) return existing;

  const id = crypto.randomUUID();
  const at = now();
  // byte-light seats a thread's roster at creation and has no primary column:
  // every companion is simply seated, which is the 'nobody leads' shape below.
  createThread({
    id, name: 'The Story Shelf', type: 'named', createdAt: at, sessionType: 'v2',
    companionIds: listCompanions().map((companion) => companion.id),
  });

  // Everyone participates and nobody is primary — the same shape as their person's
  // home thread, the Fleet Room and the Card Room, and deliberately so. That
  // column does two unrelated jobs: it says who leads a room, and it is what
  // the CLI session key resolves from (getDefaultCompanionForThread, read by
  // agent-dispatch). Naming a leader here would also give the shelf its own
  // cold session, which would walk into every book knowing the bible and
  // nothing about the evening. Left null, a page turn is thought in the warm
  // lane the conversation is already happening in. Messages are unaffected
  // either way: a reply is written to the thread its turn arrived on, and this
  // thread is archived below, so it shows only on the shelf.

  // The conversation belongs to the shelf rather than the main thread picker.
  // Archiving hides it from normal routing while keeping a complete history the
  // shelf can read and the companions' lane can resume.
  getDb().prepare('UPDATE threads SET archived_at = ? WHERE id = ?').run(at, id);
  setConfig(STORY_THREAD_CONFIG_KEY, id);

  createMessage({
    id: crypto.randomUUID(),
    threadId: id,
    role: 'system',
    content: 'The Story Shelf opened. Every book keeps its place.',
    platform: 'api',
    createdAt: at,
  });
  return id;
}

/**
 * The line a page turn opens with in the shelf's thread, written as the turn
 * starts. Their person's move goes in as their own words, because that is what
 * it is. An opening, or a page asked for again, is a line from the house
 * instead: it is not something their person said, and it should not be put in
 * their mouth.
 *
 * Every opener carries storyTurn in its metadata. That is how the table talk
 * is found: what the companions said after a book's newest opener, up to the
 * next opener of any book. Turns run one at a time, so nothing from another
 * book's turn can land in between.
 */
export function writeStoryTurnOpener(turn: {
  bookId: string;
  pageId: string | null;
  kind: 'opening' | 'move' | 'retry';
  moveText: string | null;
  title: string;
}): Message {
  const threadId = ensureStoryShelfThread();
  const metadata = { room: 'story-shelf', storyBookId: turn.bookId, storyPageId: turn.pageId, storyTurn: turn.kind };
  const fromHer = turn.kind === 'move' && Boolean(turn.moveText);
  return createMessage({
    id: crypto.randomUUID(),
    threadId,
    role: fromHer ? 'user' : 'system',
    content: fromHer
      ? turn.moveText!
      : turn.kind === 'opening'
        ? `Opened “${turn.title}”.`
        : `Asked again for the next page of “${turn.title}”.`,
    platform: 'api',
    metadata,
    createdAt: now(),
  });
}

/** metadata is JSON written by the house, but one malformed row must not break the read. */
const STORY_TURN = "CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.storyTurn') END";
const STORY_BOOK = "CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.storyBookId') END";
const STORY_TABLE = "CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.storyTable') END";

/**
 * A line their person says at the table while reading. It is talk, not a move:
 * it never turns a page, and it carries no storyTurn, so it never starts a
 * new stretch of table talk either. It goes in as their person's own words.
 */
export function writeStoryTableTalk(bookId: string, text: string): Message {
  const threadId = ensureStoryShelfThread();
  return createMessage({
    id: crypto.randomUUID(),
    threadId,
    role: 'user',
    content: text,
    platform: 'api',
    metadata: { room: 'story-shelf', storyBookId: bookId, storyTable: true },
    createdAt: now(),
  });
}

/**
 * Everything said at the table during this book's page turns: the companions'
 * lines in each of its turns, and their person's own table talk for it, oldest
 * first, the newest kept when there are more than the limit. A turn runs from
 * its opener to the next opener of any book, so a line said during another
 * book's turn stays with that book. It used to hold only the newest turn's
 * talk, so every page turned wiped the table, and their person read that as the
 * talk being lost.
 */
export function storyTalk(bookId: string, limit = 200): StoryTalkLine[] {
  const threadId = storyShelfThreadId();
  if (!threadId) return [];
  const db = getDb();
  const openers = db.prepare(`
    SELECT sequence, ${STORY_BOOK} AS bookId FROM messages
    WHERE thread_id = ? AND ${STORY_TURN} IS NOT NULL
    ORDER BY sequence
  `).all(threadId) as Array<{ sequence: number; bookId: string | null }>;
  const spans: Array<[number, number]> = [];
  openers.forEach((opener, index) => {
    if (opener.bookId !== bookId) return;
    const next = openers[index + 1];
    spans.push([opener.sequence, next ? next.sequence : Number.MAX_SAFE_INTEGER]);
  });
  if (spans.length === 0) return [];
  const rows = db.prepare(`
    SELECT id, role, content, companion_id, created_at, sequence FROM messages
    WHERE thread_id = ? AND sequence > ? AND deleted_at IS NULL
      AND (role = 'companion' OR (role = 'user' AND ${STORY_TABLE} = 1 AND ${STORY_BOOK} = ?))
    ORDER BY sequence
  `).all(threadId, spans[0][0], bookId) as Array<{
    id: string;
    role: 'companion' | 'user';
    content: string;
    companion_id: string | null;
    created_at: string;
    sequence: number;
  }>;
  // Their person's own table lines name their book; a companion's line belongs to the
  // turn it was said in.
  const said = rows.filter((row) => row.role === 'user' || spans.some(([from, to]) => row.sequence > from && row.sequence < to));
  const slugs = new Map(listCompanions().map((companion) => [companion.id, companion.id]));
  return said.slice(-Math.max(1, limit)).map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    companionSlug: row.companion_id ? slugs.get(row.companion_id) ?? null : null,
    createdAt: row.created_at,
  }));
}
