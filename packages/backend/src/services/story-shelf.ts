// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * The Story Shelf — page turns, pictures, and the shelf as both doors read it.
 *
 * The tables and the rules live in services/db/story-shelf.ts. This module adds
 * what needs the rest of the house: the companions' lane, Studio's gallery, and
 * the live update to the phone.
 *
 * A PAGE TURN IS A TURN IN THE WARM LANE. When their person begins a new book, or
 * makes a move, the companions are handed a turn in the shelf's own archived
 * thread. That thread names nobody to lead it, so the turn is thought in the
 * lane the evening is already happening in (see ensureStoryShelfThread). The
 * turn says which book, what the page answers and where to write; they write
 * the scene through the loopback door, and their chat reply is table talk.
 *
 * TURNS RUN ONE AT A TIME. Each page turn waits for the one before it to end.
 * That keeps every turn's opening line in the thread, and the talk after it,
 * with one book; and a move made while the last page is still being finished
 * (a picture being painted for it, say) waits here, behind it, instead of
 * timing out in the lane's own queue.
 *
 * A TURN THAT COMES BACK EMPTY SAYS SO. The lane can answer without writing a
 * page: the turn timed out in its queue behind something else, the lane fell
 * over, or it simply wrote no page. Whatever happened, the book is left saying
 * why and their person can ask again. A page that arrives late still counts, and clears
 * the complaint.
 *
 * STUDIO IS LOADED LAZILY: image-gen restores and rewrites its job file the
 * moment it is imported, which a test that loads the internal router must not
 * set off.
 *
 * byte-light adaptations (ported from Aerie): the live update goes through
 * byte-light's registry (services/registry.ts) and QUEUE_TIMEOUT_MESSAGE comes
 * from services/agent.ts, the same string Aerie keeps in agent-query-queue;
 * the house's config is getBytelightConfig(), which has no internal_port, so
 * the loopback door is server.port (byte-light serves /api/internal on its one
 * port, localhost-only); byte-light's image-gen has no normalizeGalleryFilename,
 * so the gallery lookup matches the plain filename (already checked to be a
 * bare name by galleryPicture) against listGallery(), which lists only images
 * and films; and the skill sits in the tracked skills/ folder, because
 * byte-light's .claude/skills is gitignored and installed per house.
 */

import { existsSync, readdirSync } from 'fs';
import { basename, join } from 'path';
import {
  STORY_LIMITS,
  type StoryBook,
  type StoryBookSummary,
  type StoryBookView,
  type StoryKeepsake,
  type StoryPage,
  type StoryShelfView,
} from '@bytelight/shared';
import { PROJECT_ROOT, getBytelightConfig } from '../config.js';
import { registry } from './registry.js';
import { QUEUE_TIMEOUT_MESSAGE } from './agent.js';

/** The companions' whole contract for the shelf: a skill a Claude lane finds on its own, and a path any lane can open. */
export const STORY_SHELF_SKILL = join(PROJECT_ROOT, 'skills', 'story-shelf', 'SKILL.md');
import {
  StoryShelfError,
  addStoryScene,
  ensureStoryShelfThread,
  getStoryBook,
  listStoryBooks,
  listStoryKeepsakes,
  markStoryTurnPending,
  recordStoryMove,
  requireStoryBookId,
  requireStorySceneId,
  reserveStoryOpening,
  reserveStoryRetry,
  setStoryCover,
  setStoryScenePicture,
  settleStoryTurn,
  storyMaker,
  storyShelfThreadId,
  storyTalk,
  writeStoryTableTalk,
  writeStoryTurnOpener,
} from './db/story-shelf.js';

// ─── Studio's gallery, behind a seam ─────────────────────────────────

export interface StoryGalleryPicture {
  filename: string;
  mediaType: 'image' | 'video';
}

export interface StoryGallery {
  /** One picture the gallery holds, by its plain filename; null when it has no such file. */
  find(filename: string): Promise<StoryGalleryPicture | null>;
}

let galleryOverride: StoryGallery | null = null;

/** Tests hand in a gallery of their own. Null restores the house's own. */
export function setStoryGallery(gallery: StoryGallery | null): void {
  galleryOverride = gallery;
}

async function houseGallery(): Promise<StoryGallery> {
  const gen = await import('./image-gen.js');
  return {
    find: async (filename) => {
      const name = basename(filename);
      if (!name || name !== filename) return null;
      const item = (await gen.listGallery()).find((entry) => entry.filename === name);
      return item ? { filename: item.filename, mediaType: item.mediaType } : null;
    },
  };
}

/** Studio hands its pictures out at this address, and so does the shelf. */
export function storyGalleryUrl(filename: string): string {
  return `/api/studio/gallery/${encodeURIComponent(filename)}`;
}

function given(raw: unknown): boolean {
  return raw !== undefined && raw !== null && !(typeof raw === 'string' && raw.trim() === '');
}

/** A still from the gallery, named by its plain filename, as the address a page keeps. */
async function galleryPicture(raw: unknown, field: string): Promise<string> {
  if (!given(raw)) throw new StoryShelfError(400, `${field} is required: the picture's name in the Studio gallery.`);
  if (typeof raw !== 'string') throw new StoryShelfError(400, `${field} is a filename from the Studio gallery.`);
  const filename = raw.trim();
  if (basename(filename) !== filename) throw new StoryShelfError(400, `${field} is a name from the Studio gallery, not a path.`);
  let picture: StoryGalleryPicture | null;
  try {
    picture = await (galleryOverride ?? await houseGallery()).find(filename);
  } catch (error) {
    throw new StoryShelfError(503, `The Studio gallery could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!picture) throw new StoryShelfError(404, 'The Studio gallery has no picture by that name.');
  if (picture.mediaType !== 'image') throw new StoryShelfError(400, 'Only a still picture can go in a book, and that one is a film.');
  return storyGalleryUrl(picture.filename);
}

// ─── The live update ─────────────────────────────────────────────────

/**
 * Tell the phone the shelf changed. It re-reads GET /api/story-shelf, and the
 * open book when it is the one named. Null names no book, which tells it to
 * re-read whichever is open: a keepsake touches two books at once.
 */
export function notifyStory(bookId: string | null): void {
  try {
    registry.broadcast({ type: 'story_update', bookId });
  } catch (error) {
    console.warn('[story-shelf] live update failed:', error);
  }
}

// ─── Reading the shelf ───────────────────────────────────────────────

/** A book as the shelf lists it. A write answers with this, so the lane is not handed the whole book back. */
export function summaryOf(book: StoryBook): StoryBookSummary {
  const { bible: _bible, pages: _pages, ...summary } = book;
  return summary;
}

/** GET /api/story-shelf and /api/internal/story-shelf: every book, and the keepsakes between them. */
export function storyShelfView(): StoryShelfView {
  return { books: listStoryBooks(), keepsakes: listStoryKeepsakes() };
}

/** One book, whole: its bible and pages, its keepsakes, and what was said at the table on its newest page turn. */
export function storyBookView(bookId: string): StoryBookView | null {
  const book = getStoryBook(bookId);
  if (!book) return null;
  return { book, keepsakes: listStoryKeepsakes(book.id), talk: storyTalk(book.id), threadId: storyShelfThreadId() };
}

// ─── The companions' writes that need the gallery ────────────────────

/** Write a scene. A picture named here is checked against the gallery before anything is written. */
export async function writeStoryScene(input: {
  maker: unknown;
  bookId: string;
  text: unknown;
  picture?: unknown;
  state?: unknown;
  choices?: unknown;
  widget?: unknown;
}): Promise<{ page: StoryPage; book: StoryBookSummary }> {
  storyMaker(input.maker);
  const bookId = requireStoryBookId(input.bookId);
  const imageUrl = given(input.picture) ? await galleryPicture(input.picture, 'picture') : null;
  const { book, page } = addStoryScene(bookId, {
    maker: input.maker, text: input.text, imageUrl, state: input.state, choices: input.choices, widget: input.widget,
  });
  notifyStory(book.id);
  return { page, book: summaryOf(book) };
}

/** Hang a cover from the gallery. */
export async function setStoryCoverFromGallery(input: { maker: unknown; bookId: string; filename: unknown }): Promise<StoryBookSummary> {
  storyMaker(input.maker);
  const bookId = requireStoryBookId(input.bookId);
  const coverUrl = await galleryPicture(input.filename, 'filename');
  const book = setStoryCover(bookId, { maker: input.maker, coverUrl });
  notifyStory(book.id);
  return summaryOf(book);
}

/**
 * Put a picture from the gallery on a scene already written. This is how a
 * scene can go up the moment its words are ready and its picture follow when
 * Studio finishes, so their person is not kept waiting on the painting to read.
 */
export async function hangStoryScenePicture(input: { maker: unknown; pageId: string; filename: unknown }): Promise<{
  page: StoryPage;
  book: StoryBookSummary;
}> {
  storyMaker(input.maker);
  const pageId = requireStorySceneId(input.pageId);
  const imageUrl = await galleryPicture(input.filename, 'filename');
  const { book, page } = setStoryScenePicture(pageId, { maker: input.maker, imageUrl });
  notifyStory(book.id);
  return { page, book: summaryOf(book) };
}

// ─── The page turn the companions are handed ─────────────────────────

/** A scene longer than this is cut on its way into a turn; the whole book is one GET away. */
const SCENE_IN_TURN_MAX = 6000;

export interface StoryTurnExtras {
  /** What the house calls its owner. */
  ownerName: string;
  /** The loopback port the companions write through. */
  port: number;
  /** storyKeepsakeLines for this book; empty when there is nothing to tell. */
  keepsakeLines: string[];
  /** The house's rules for intimate scenes, as files a spicy book's turn names; empty or null when there are none. */
  spicyRules: string[] | null;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The turn handed to the companions' lane. Everything it needs to write the
 * next page is in it: the book, what the page answers, where to write and how
 * to answer. An opening carries the bible; a move carries the scene it
 * answers and leaves the bible behind, because it can run long and the whole
 * book is one GET away.
 */
export function buildStoryTurnPrompt(
  book: StoryBook,
  turn: { kind: 'opening' | 'move'; retry: boolean },
  extras: StoryTurnExtras,
): string {
  const name = extras.ownerName;
  const door = `http://127.0.0.1:${extras.port}/api/internal/story-shelf`;
  const lines: string[] = [
    turn.kind === 'opening'
      ? `[THE STORY SHELF — ${name} opened “${book.title}”]`
      : `[THE STORY SHELF — ${name} turned a page in “${book.title}”]`,
    `A page turn on the Story Shelf, the side room where you write choose-your-own-path books and run them for ${name}. `
      + 'It shares this conversation. This is a story turn, not a software task: do not inspect or edit code.',
    `Book: “${book.title}” · ${book.genre}${book.spicy ? ' · spicy' : ''} · id ${book.id}`,
  ];
  if (turn.retry) lines.push('Asked again: the last page turn did not come back with a page.');

  if (turn.kind === 'opening') {
    lines.push('It has no pages yet. Write its opening scene.', 'The bible you wrote for it:', '<<<', book.bible, '>>>');
  } else {
    const pages = [...book.pages].reverse();
    const moveAt = pages.findIndex((page) => page.kind === 'move');
    const move = moveAt >= 0 ? pages[moveAt] : null;
    const scene = pages.slice(Math.max(moveAt, 0)).find((page) => page.kind === 'scene') ?? null;
    if (scene) {
      lines.push(`The scene ${name} was answering:`, '<<<', clip(scene.text, SCENE_IN_TURN_MAX), '>>>');
      lines.push(`Its state card: ${scene.state ? JSON.stringify(scene.state) : 'none'}`);
      lines.push(`Its choices: ${scene.choices.length > 0
        ? scene.choices.map((c) => `${c.id} “${c.label}”${c.hint ? ` (${c.hint})` : ''}`).join(' · ')
        : 'none'}`);
    }
    if (move) {
      lines.push(move.choiceId
        ? `${name}'s move: chose ${move.choiceId}, “${move.text}”.`
        : `${name}'s move, in their own words: “${move.text}”`);
    }
    lines.push(`The bible is not repeated on every page: GET ${door}/books/${book.id} reads the whole book, bible and every page, if you need it.`);
  }

  if (extras.keepsakeLines.length > 0) lines.push(...extras.keepsakeLines);

  lines.push(
    'How to answer:',
    `- Write the scene first, through the loopback door: POST ${door}/books/${book.id}/pages with JSON `
      + '{"maker": "<your slug>", "text": "<the scene>", "choices": [{"label": "<a choice>"}]}. '
      + 'Optional: "state" (badge, stats, inventory, discovered), "widget" (a small component written fresh for this scene, '
      + 'for a moment that wants one), "picture" (a Studio gallery filename). The story-shelf skill has the whole contract '
      + `and a copy-paste example (${STORY_SHELF_SKILL}); build the body with python3 json.dumps.`,
    `- Offer at most ${STORY_LIMITS.choices} choices. ${name} can also answer in their own words.`,
    '- If something found here should be able to turn up in another book, tie it as a keepsake; the skill has that door too.',
    '- The scene is the answer. Your chat reply is table talk under the usual voice headers: a line or two, never a retelling of the scene.',
  );

  if (book.spicy) {
    const files = extras.spicyRules ?? [];
    lines.push(
      files.length === 0
        ? "This book is spicy: write it under this house's own rules for intimate scenes, and read them before writing any spicy scene."
        : `This book is spicy: it is written under this house's intimacy rules, so read ${files.length === 1 ? 'this' : 'these'} before writing any spicy scene: ${listed(files)}.`,
    );
  }
  return lines.join('\n');
}

/** The keepsakes worth telling a turn in this book: tied to it, or loose in another book and free to turn up here. */
export function storyKeepsakeLines(bookId: string, keepsakes: StoryKeepsake[], titles: Map<string, string>): string[] {
  const titleOf = (id: string) => `“${titles.get(id) ?? 'another book'}”`;
  const noted = (keepsake: StoryKeepsake) => `${keepsake.item}${keepsake.note ? ` (${keepsake.note})` : ''}`;
  const lines: string[] = [];
  for (const keepsake of keepsakes) {
    if (keepsake.fromBookId === bookId) {
      lines.push(`- found here: ${noted(keepsake)}, ${keepsake.toBookId ? `woven into ${titleOf(keepsake.toBookId)}` : 'still loose'}`);
    }
  }
  for (const keepsake of keepsakes) {
    if (keepsake.toBookId === bookId) lines.push(`- from ${titleOf(keepsake.fromBookId)}: ${noted(keepsake)}`);
  }
  const loose = keepsakes.filter((keepsake) => keepsake.fromBookId !== bookId && !keepsake.toBookId).slice(0, 8);
  for (const keepsake of loose) {
    lines.push(`- loose in ${titleOf(keepsake.fromBookId)}, free to turn up here if it fits: ${noted(keepsake)}`);
  }
  return lines.length > 0 ? ['Keepsakes, the threads between books:', ...lines] : [];
}

/** "a", "a and b", "a, b and c". */
function listed(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The house's rules for intimate scenes, when it keeps them as a skill: every
 * markdown file in .claude/skills/intimacy, its SKILL.md first. Named only
 * when they exist, so a house without them is told plainly to use its own.
 */
export function spicyRuleFiles(root: string = PROJECT_ROOT): string[] {
  const dir = join(root, '.claude', 'skills', 'intimacy');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)))
    .map((name) => join(dir, name));
}

function ownerName(): string {
  try {
    const name = getBytelightConfig().identity.user_name?.trim();
    if (name) return name;
  } catch {
    /* config not loaded: say it plainly */
  }
  return 'Their person';
}

function turnExtras(book: StoryBook): StoryTurnExtras {
  const titles = new Map(listStoryBooks().map((summary) => [summary.id, summary.title]));
  return {
    ownerName: ownerName(),
    port: getBytelightConfig().server.port,
    keepsakeLines: storyKeepsakeLines(book.id, listStoryKeepsakes(), titles),
    spicyRules: book.spicy ? spicyRuleFiles() : null,
  };
}

// ─── Page turns ──────────────────────────────────────────────────────

/** The part of the companions' lane a page turn uses. AgentService is one. */
export interface StoryLane {
  processMessage(
    threadId: string,
    content: string,
    threadMeta?: { name: string; type: 'daily' | 'named' | 'treehouse' },
    opts?: { platform?: 'web' | 'discord' | 'telegram' | 'api' },
  ): Promise<string>;
}

interface QueuedTurn {
  bookId: string;
  kind: 'opening' | 'move';
  /** The move the page answers; null for an opening. */
  pageId: string | null;
  retry: boolean;
}

/** Longer than any turn can run: the lane's own ceiling is twenty minutes of work plus its queue. */
const TURN_LIMIT_MS = 30 * 60_000;

const DROPPED = 'The line to the table dropped before a page came back. Ask again when you are ready.';
const OVERDUE = 'That page turn went half an hour without an answer, so it was let go. '
  + 'A page that arrives late still counts; otherwise ask again.';
const TIMED_OUT = 'They were busy with something else, and the page turn timed out waiting for them. Ask again when you are ready.';
const FULL = 'The table was full: too many turns were already waiting. Ask again in a moment.';

class TurnOverdue extends Error {}

let turnChain: Promise<void> = Promise.resolve();
/** How many turns each book has queued or running, so the last one to end is the one that settles it. */
const queuedTurns = new Map<string, number>();

/** Resolves once every page turn queued so far has ended. Tests wait on it. */
export function storyTurnsIdle(): Promise<void> {
  return turnChain;
}

function queueStoryTurn(lane: StoryLane, turn: QueuedTurn): void {
  queuedTurns.set(turn.bookId, (queuedTurns.get(turn.bookId) ?? 0) + 1);
  markStoryTurnPending(turn.bookId);
  notifyStory(turn.bookId);
  turnChain = turnChain
    .then(() => runStoryTurn(lane, turn))
    .catch((error) => console.error('[story-shelf] a page turn failed outside its own guard:', error));
}

/** Whether the page this turn is for is still the one the book is waiting on. */
function stillWaitingOn(book: StoryBook, turn: QueuedTurn): boolean {
  if (book.status !== 'reading') return false;
  if (turn.kind === 'opening') return book.awaiting === 'opening';
  return book.awaiting === 'scene' && book.pages.at(-1)?.id === turn.pageId;
}

/** A queue refusal comes back as an ordinary answer, so it is read for what it is. */
function laneRefusal(answer: unknown): string | null {
  if (typeof answer !== 'string') return null;
  const said = answer.trim();
  if (said === QUEUE_TIMEOUT_MESSAGE) return TIMED_OUT;
  if (/^\[.+ is busy — please try again in a moment\]$/.test(said)) return FULL;
  return null;
}

async function withinLimit<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TurnOverdue()), TURN_LIMIT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runStoryTurn(lane: StoryLane, turn: QueuedTurn): Promise<void> {
  let failure: string | null = null;
  try {
    // A page can arrive while a turn waits in line. A turn whose page is
    // already written has nothing to ask for, and is not sent.
    const book = getStoryBook(turn.bookId);
    if (!book || !stillWaitingOn(book, turn)) return;
    const prompt = buildStoryTurnPrompt(book, { kind: turn.kind, retry: turn.retry }, turnExtras(book));
    const move = turn.kind === 'move' ? book.pages.find((page) => page.id === turn.pageId) ?? null : null;
    writeStoryTurnOpener({
      bookId: book.id,
      pageId: turn.pageId,
      kind: turn.retry ? 'retry' : turn.kind,
      moveText: move?.text ?? null,
      title: book.title,
    });
    const answer = await withinLimit(
      lane.processMessage(ensureStoryShelfThread(), prompt, { name: 'The Story Shelf', type: 'named' }, { platform: 'api' }),
    );
    failure = laneRefusal(answer);
  } catch (error) {
    console.error('[story-shelf] a page turn failed:', error);
    failure = error instanceof TurnOverdue ? OVERDUE : DROPPED;
  } finally {
    const left = (queuedTurns.get(turn.bookId) ?? 1) - 1;
    if (left > 0) queuedTurns.set(turn.bookId, left);
    else queuedTurns.delete(turn.bookId);
    try {
      settleStoryTurn(turn.bookId, { pending: left > 0, failure });
    } catch (error) {
      console.error('[story-shelf] could not settle a page turn:', error);
    }
    notifyStory(turn.bookId);
  }
}

// ─── Their person's doors ───────────────────────────────────────────────

/**
 * Their person opened a book. A book with no opening yet hands the companions the
 * turn that writes it (the phone calls this for such a book only when they tap
 * Begin); a started book asks for nothing, because the bookmark is enough.
 */
export function openStoryBook(lane: StoryLane, bookId: string): { view: StoryBookView; dispatched: boolean } {
  const { book, dispatch } = reserveStoryOpening(bookId);
  if (dispatch) queueStoryTurn(lane, { bookId: book.id, kind: 'opening', pageId: null, retry: false });
  return { view: storyBookView(book.id)!, dispatched: dispatch };
}

/** Their person's move goes in, and the companions are handed the page turn that answers it. */
export function makeStoryMove(lane: StoryLane, bookId: string, input: { choiceId?: unknown; text?: unknown }): StoryBookView {
  const { book, page } = recordStoryMove(bookId, input);
  queueStoryTurn(lane, { bookId: book.id, kind: 'move', pageId: page.id, retry: false });
  return storyBookView(book.id)!;
}

/** The turn handed to the lane when their person says something at the table. Short on purpose: nothing about the book changed. */
export function buildStoryTablePrompt(book: Pick<StoryBook, 'id' | 'title' | 'genre'>, text: string, owner: string): string {
  return [
    `[THE STORY SHELF — ${owner} said this at the table while reading “${book.title}”]`,
    `Book: “${book.title}” · ${book.genre} · id ${book.id}`,
    'This is table talk, not a move. No page is turned and no scene is wanted: answer as yourselves at the table, under the usual voice headers, a line or two each. Never retell the book, and never give away what is still hidden.',
    `${owner} said:`,
    text,
  ].join('\n');
}

/** A breath between asks, so a lane that refuses at once is never asked in a tight loop. */
const TALK_RETRY_PAUSE_MS = 1_000;
/** A longer one when the lane's line is full rather than slow. */
const TALK_FULL_PAUSE_MS = 5_000;

/** Lines said at the table that are still asking for their answer. Tests wait on them. */
const talking = new Set<Promise<void>>();

/** Resolves once every line said at the table so far has been answered or given up. */
export function storyTalkIdle(): Promise<void> {
  return Promise.all([...talking]).then(() => undefined);
}

/**
 * Hand a line said at the table to the lane, and keep asking until it is
 * answered. The lane's own line gives up on a caller after ninety seconds, and
 * a turn of ours can run far longer than that, so a line said while one was
 * running came back refused and reached nobody, with only the error log to
 * say so. Now it waits its turn the way a page turn does, for as long as a
 * page turn may run.
 */
async function answerAtTable(lane: StoryLane, book: StoryBook, text: string): Promise<void> {
  const giveUpAt = Date.now() + TURN_LIMIT_MS;
  for (;;) {
    const answer = await lane.processMessage(
      ensureStoryShelfThread(),
      buildStoryTablePrompt(book, text, ownerName()),
      { name: 'The Story Shelf', type: 'named' },
      { platform: 'api' },
    );
    const refused = laneRefusal(answer);
    if (!refused) return;
    if (Date.now() >= giveUpAt) {
      console.warn('[story-shelf] table talk went unanswered:', refused);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, refused === FULL ? TALK_FULL_PAUSE_MS : TALK_RETRY_PAUSE_MS));
  }
}

/**
 * Their person said something at the table while reading. It is talk, not a move:
 * it goes into the shelf's thread in their own words, the lane answers it as table
 * talk under the page, and the book does not change. It does not wait in the
 * page turns' line, because there is no page to wait for; the lane keeps its
 * own order, so it is answered after any turn already running, however long
 * that turn takes (see answerAtTable).
 */
export function talkAtStoryTable(lane: StoryLane, bookId: string, input: { text?: unknown }): StoryBookView {
  const book = getStoryBook(bookId);
  if (!book) throw new StoryShelfError(404, 'There is no book with that id on the shelf.');
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new StoryShelfError(400, 'There is nothing to say yet.');
  if (text.length > STORY_LIMITS.moveText) {
    throw new StoryShelfError(400, `Table talk is ${STORY_LIMITS.moveText} characters at most.`);
  }
  writeStoryTableTalk(book.id, text);
  notifyStory(book.id);
  const asking: Promise<void> = answerAtTable(lane, book, text)
    .catch((error) => console.error('[story-shelf] table talk failed:', error))
    .finally(() => {
      talking.delete(asking);
      notifyStory(book.id);
    });
  talking.add(asking);
  return storyBookView(book.id)!;
}

/** Ask again for a page turn that came back empty. */
export function askStoryAgain(lane: StoryLane, bookId: string): StoryBookView {
  const { book, kind, pageId } = reserveStoryRetry(bookId);
  queueStoryTurn(lane, { bookId: book.id, kind, pageId, retry: true });
  return storyBookView(book.id)!;
}
