// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Story Shelf — the shapes its routes answer with.
//
// A shelf of choose-your-own-path books the companions write and run for the
// owner of the house. They write through the loopback routes
// (/api/internal/story-shelf/...); the phone reads the shelf, opens a book and
// makes a move through /api/story-shelf. Both answer with the shapes below, so
// the phone and the backend code against the same contract, and the limits
// live here once so the phone never offers what the backend will refuse.

/** A book is being read until the companions close it. */
export type StoryBookStatus = 'reading' | 'finished';

/**
 * A scene is a page the companions wrote. A move is their person's: a choice
 * taken, or a move in their own words, which the next scene answers.
 */
export type StoryPageKind = 'scene' | 'move';

/** Who wrote a move. A scene's author is the slug of the companion who wrote it. */
export const STORY_OWNER_AUTHOR = 'owner';

/** What a book is waiting on, decided from its pages. */
export type StoryAwaiting =
  /** No scene yet: the companions have not written the opening. */
  | 'opening'
  /** The newest page is their person's move: the next scene answers it. */
  | 'scene'
  /** The newest page is a scene: the next move is their person's. */
  | 'move'
  /** The book is finished. */
  | 'nothing';

/** Length caps in characters, after trimming. The skill file quotes these. */
export const STORY_LIMITS = {
  title: 120,
  genre: 40,
  blurb: 600,
  bible: 20000,
  sceneText: 12000,
  moveText: 1000,
  widget: 30000,
  choices: 6,
  choiceId: 32,
  choiceLabel: 120,
  choiceHint: 160,
  badge: 60,
  stats: 12,
  statLabel: 40,
  statValue: 60,
  listItems: 24,
  inventoryItem: 80,
  discoveredItem: 120,
  keepsakeItem: 80,
  keepsakeNote: 400,
  /** A widget's move is a short string: a choice id, or a few words. */
  widgetMove: 200,
} as const;

export interface StoryStat {
  label: string;
  value: string;
}

/**
 * The card under a scene: where things stand. Every part is optional, and a
 * scene with nothing to say about it carries no card at all.
 */
export interface StoryStateCard {
  /** One short line on top, e.g. "Night 2" or "Lantern lit". */
  badge?: string;
  stats?: StoryStat[];
  /** What their person is carrying. */
  inventory?: string[];
  /** What has been found out. */
  discovered?: string[];
}

export interface StoryChoice {
  id: string;
  label: string;
  hint?: string;
}

export interface StoryPage {
  id: string;
  bookId: string;
  /** ISO timestamp. Pages arrive oldest first. */
  at: string;
  kind: StoryPageKind;
  /** A companion slug on a scene; STORY_OWNER_AUTHOR on a move. */
  author: string;
  /** The scene, or the move as their person made it (a choice's label, or their own words). */
  text: string;
  /** Relative Studio gallery URL, e.g. /api/studio/gallery/<file>. Scenes only. */
  imageUrl: string | null;
  state: StoryStateCard | null;
  /** The choices a scene offers. Empty on a move, and on a scene that offers none. */
  choices: StoryChoice[];
  /** Source of the small interactive widget written for this scene, if any. */
  widget: string | null;
  /** On a move: the id of the choice taken, or null for a move in their person's own words. */
  choiceId: string | null;
}

/** A book as the shelf lists it: everything but the bible and the pages. */
export interface StoryBookSummary {
  id: string;
  title: string;
  genre: string;
  spicy: boolean;
  blurb: string | null;
  coverUrl: string | null;
  /** Slug of the companion who put it on the shelf. */
  createdBy: string;
  status: StoryBookStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** When their person last walked into it. */
  openedAt: string | null;
  pageCount: number;
  sceneCount: number;
  /** Where their person left off: the newest scene, or their newest move when it is newer. */
  bookmark: { pageId: string; at: string } | null;
  awaiting: StoryAwaiting;
  /** A page turn is queued or being written for this book right now. */
  companionPending: boolean;
  /** Why the last page turn did not come back with a page, when it did not. */
  companionError: string | null;
}

export interface StoryBook extends StoryBookSummary {
  /** The base story the companions wrote for it. It may give things away. */
  bible: string;
  pages: StoryPage[];
}

/**
 * One of the little threads woven between books: a keepsake found in one story
 * that turns up in another. It hangs loose until it is woven into a second book.
 */
export interface StoryKeepsake {
  id: string;
  /** What it is, in a few words: "the brass key". */
  item: string;
  note: string | null;
  fromBookId: string;
  toBookId: string | null;
  /** Slug of the companion who tied it. */
  maker: string;
  createdAt: string;
  wovenAt: string | null;
}

/** A line said at the table during the newest page turn of a book. */
export interface StoryTalkLine {
  id: string;
  role: 'user' | 'companion' | 'system';
  content: string;
  companionSlug: string | null;
  createdAt: string;
}

/** GET /api/story-shelf and GET /api/internal/story-shelf: the whole shelf. */
export interface StoryShelfView {
  /** Books being read first, the most recently opened leading; then the finished ones. */
  books: StoryBookSummary[];
  keepsakes: StoryKeepsake[];
}

/** GET /api/story-shelf/books/:id and GET /api/internal/story-shelf/books/:id. */
export interface StoryBookView {
  book: StoryBook;
  /** Every keepsake found in this book or woven into it. */
  keepsakes: StoryKeepsake[];
  /** What was said at the table during this book's newest page turn. */
  talk: StoryTalkLine[];
  /** The shelf's conversation thread, so reading the talk can count as reading it. */
  threadId: string | null;
}
