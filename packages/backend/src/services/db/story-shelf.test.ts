// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Story Shelf's rules, checked against a real database: what a book, a
// scene and a move must carry, what a book is waiting on, the one-move guard,
// the keepsakes between books, the shelf's own thread, and the table talk.
//
// Every message a test writes is ten characters or fewer, or a system line,
// on purpose. createMessage embeds anything longer in the background, and on
// a machine without the model that fetches ninety megabytes mid-test.
//
// byte-light adaptations: companions are plain registry rows (the row id IS
// the slug), seeded with an INSERT the way the other ported tests here seed
// them, since byte-light has no createCompanion; the shelf's roster is read
// with getThreadRoster (services/db/rooms.ts), which has no role column, so
// "nobody leads" is checked as every companion seated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STORY_LIMITS } from '@bytelight/shared';
import { initDb, getDb } from './init.js';
import { getThreadRoster } from './rooms.js';
import { createMessage } from './messages.js';
import { getThread } from './threads.js';
import {
  StoryShelfError,
  addStoryScene,
  createStoryBook,
  createStoryKeepsake,
  ensureStoryShelfThread,
  finishStoryBook,
  getStoryBook,
  listStoryBooks,
  listStoryKeepsakes,
  recordStoryMove,
  reserveStoryOpening,
  reserveStoryRetry,
  setStoryCover,
  setStoryScenePicture,
  settleStoryTurn,
  storyShelfThreadId,
  storyTalk,
  weaveStoryKeepsake,
  writeStoryTurnOpener,
} from './story-shelf.js';

function freshHouse(): void {
  initDb(':memory:');
  getDb().prepare('DELETE FROM companions').run();
  for (const slug of ['example', 'other']) {
    getDb().prepare("INSERT INTO companions (id, display_name, brain) VALUES (?, ?, 'test')").run(slug, slug[0].toUpperCase() + slug.slice(1));
  }
}

function book(extra: Record<string, unknown> = {}) {
  return createStoryBook({
    maker: 'example', title: 'The Night Market', genre: 'cozy gothic', bible: 'The stalls trade places at night.', ...extra,
  });
}

function scene(bookId: string, extra: Record<string, unknown> = {}) {
  return addStoryScene(bookId, {
    maker: 'example',
    text: 'The gate is open.',
    choices: [{ label: 'Go left' }, { label: 'Wait' }],
    ...extra,
  });
}

/** Run a write and hand back the refusal, so a test can read its status and sentence. */
function refusal(write: () => unknown): StoryShelfError {
  try {
    write();
  } catch (error) {
    assert.ok(error instanceof StoryShelfError, `expected a StoryShelfError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the write to be refused');
}

function refused(write: () => unknown, status: number, sentence: RegExp): void {
  const error = refusal(write);
  assert.equal(error.status, status, error.message);
  assert.match(error.message, sentence);
}

test('a book goes on the shelf with its bible, and the shelf says what it is waiting on', () => {
  freshHouse();
  const made = book({ title: '  The   Night  Market After Hours ', spicy: true, blurb: '  Only the reader notices. ' });
  assert.equal(made.title, 'The Night Market After Hours', 'a title is folded onto one line');
  assert.equal(made.blurb, 'Only the reader notices.');
  assert.equal(made.bible, 'The stalls trade places at night.');
  assert.deepEqual(
    [made.status, made.spicy, made.createdBy, made.awaiting, made.sceneCount, made.pageCount, made.bookmark, made.companionPending],
    ['reading', true, 'example', 'opening', 0, 0, null, false],
  );
  assert.deepEqual(made.pages, []);

  const [listed] = listStoryBooks();
  assert.deepEqual(Object.keys(listed), [
    'id', 'title', 'genre', 'spicy', 'blurb', 'coverUrl', 'createdBy', 'status', 'createdAt', 'updatedAt', 'finishedAt',
    'openedAt', 'pageCount', 'sceneCount', 'bookmark', 'awaiting', 'companionPending', 'companionError',
  ], 'the shelf lists books without their bibles or pages');
  assert.equal(listed.id, made.id);
  assert.equal(book({ title: 'Plain' }).spicy, false, 'a book is not spicy unless it says so');
});

test('a scene carries its own choices, state card and widget, checked on the way in', () => {
  freshHouse();
  const { id } = book();
  const { page, book: after } = scene(id, {
    text: '  The gate is open.\n\nA stall has moved.  ',
    choices: [{ label: '  Go   left ', hint: 'toward the lamps' }, { id: 'wait', label: 'Wait' }],
    state: {
      badge: ' Night 1 ',
      stats: [{ label: 'Courage', value: 3 }, { label: 'Lamps', value: 'lit' }],
      inventory: ['a brass key', '  '],
      discovered: ['The stalls move.'],
    },
    widget: 'function App({ move }) { return <button onClick={() => move("wait")}>Wait</button>; }',
  });
  assert.deepEqual(Object.keys(page), ['id', 'bookId', 'at', 'kind', 'author', 'text', 'imageUrl', 'state', 'choices', 'widget', 'choiceId']);
  assert.equal(page.text, 'The gate is open.\n\nA stall has moved.', 'a scene keeps its paragraphs');
  assert.deepEqual([page.kind, page.author, page.imageUrl, page.choiceId], ['scene', 'example', null, null]);
  assert.deepEqual(page.choices, [
    { id: 'c1', label: 'Go left', hint: 'toward the lamps' },
    { id: 'wait', label: 'Wait' },
  ], 'a choice without an id is numbered by its place');
  assert.deepEqual(page.state, {
    badge: 'Night 1',
    stats: [{ label: 'Courage', value: '3' }, { label: 'Lamps', value: 'lit' }],
    inventory: ['a brass key'],
    discovered: ['The stalls move.'],
  });
  assert.match(page.widget ?? '', /^function App/);
  assert.deepEqual([after.awaiting, after.sceneCount, after.bookmark?.pageId], ['move', 1, page.id]);

  const bare = scene(id, { text: 'Night falls.', choices: undefined }).page;
  assert.deepEqual([bare.choices, bare.state, bare.widget], [[], null, null], 'everything but the words is optional');
  assert.equal(scene(id, { state: { inventory: ['  '] } }).page.state, null, 'a card with nothing on it is no card');
});

test('every refusal on the way in is one plain sentence, with a status that says what kind', () => {
  freshHouse();
  const { id } = book();
  refused(() => book({ maker: undefined }), 400, /maker is required/);
  refused(() => book({ maker: 'nobody' }), 400, /Unknown companion slug 'nobody'/);
  refused(() => book({ title: '   ' }), 400, /title is required/);
  refused(() => book({ genre: undefined }), 400, /genre is required/);
  refused(() => book({ bible: '' }), 400, /bible is required/);
  refused(() => book({ title: 't'.repeat(STORY_LIMITS.title + 1) }), 400, /title must be 120 characters or fewer \(it was 121\)/);
  refused(() => book({ spicy: 'yes' }), 400, /spicy must be true or false/);
  refused(() => book({ bible: 'b'.repeat(STORY_LIMITS.bible + 1) }), 400, /bible must be 20000 characters or fewer/);

  refused(() => scene('no-such-book'), 404, /no book with that id/);
  refused(() => scene(id, { text: undefined }), 400, /text is required/);
  refused(() => scene(id, { choices: 'go left' }), 400, /choices must be a list/);
  refused(() => scene(id, { choices: Array.from({ length: 7 }, (_, i) => ({ label: `c${i}` })) }), 400, /at most 6 choices/);
  refused(() => scene(id, { choices: [{ label: '' }] }), 400, /choice 1 needs a label/);
  refused(() => scene(id, { choices: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] }), 400, /choice id 'a' is used twice/);
  refused(() => scene(id, { choices: [{ id: 'has space', label: 'x' }] }), 400, /choice id 'has space'/);
  refused(() => scene(id, { state: { mood: 'tense' } }), 400, /state can only carry badge, stats, inventory and discovered \(it had mood\)/);
  refused(() => scene(id, { state: 'tense' }), 400, /state must be an object/);
  refused(() => scene(id, { state: { stats: [{ label: 'Courage' }] } }), 400, /stats must be a list of \{ label, value \}/);
  refused(() => scene(id, { state: { inventory: 'a key' } }), 400, /inventory must be a list of short lines/);
  refused(() => scene(id, { widget: 'w'.repeat(STORY_LIMITS.widget + 1) }), 400, /widget must be 30000 characters or fewer/);
  refused(() => scene(id, { widget: 42 }), 400, /widget must be text/);
});

test('a move is checked against the newest scene, and only one goes in before it is answered', () => {
  freshHouse();
  const { id } = book();
  refused(() => recordStoryMove(id, { choiceId: 'c1' }), 409, /no scene to answer yet/);
  scene(id);
  refused(() => recordStoryMove(id, {}), 400, /A move needs a choice id or your own words/);
  refused(() => recordStoryMove(id, { choiceId: 'c1', text: 'Both' }), 400, /a choice id or your own words, not both/);
  refused(() => recordStoryMove(id, { choiceId: 'c9' }), 400, /The newest scene has no choice 'c9'/);
  refused(() => recordStoryMove(id, { text: 'm'.repeat(STORY_LIMITS.moveText + 1) }), 400, /must be 1000 characters or fewer/);
  refused(() => recordStoryMove('nope', { text: 'Hi' }), 404, /no book with that id/);

  const { page, book: after } = recordStoryMove(id, { choiceId: 'c2' });
  assert.deepEqual([page.kind, page.author, page.text, page.choiceId, page.choices, page.state], ['move', 'owner', 'Wait', 'c2', [], null]);
  assert.deepEqual([after.awaiting, after.companionPending, after.bookmark?.pageId], ['scene', true, page.id]);
  refused(() => recordStoryMove(id, { text: 'Again' }), 409, /Your move is already in/);

  scene(id, { text: 'The lamplighter turns.', choices: [] });
  const own = recordStoryMove(id, { text: '  I knock.  ' }).page;
  assert.deepEqual([own.text, own.choiceId], ['I knock.', null], 'a move in their person’s own words carries no choice');
});

test('walking into a book asks for its opening once, and walking into a started book asks for nothing', () => {
  freshHouse();
  const { id } = book();
  const first = reserveStoryOpening(id);
  assert.equal(first.dispatch, true);
  assert.equal(first.book.companionPending, true);
  assert.ok(first.book.openedAt, 'walking in is remembered');
  assert.equal(reserveStoryOpening(id).dispatch, false, 'the opening is already being written');

  settleStoryTurn(id, { pending: false, failure: null });
  const stalled = getStoryBook(id)!;
  assert.deepEqual([stalled.companionPending, stalled.awaiting], [false, 'opening']);
  assert.match(stalled.companionError ?? '', /ended without a new page/);
  assert.equal(reserveStoryOpening(id).dispatch, true, 'a book whose opening never came can ask again by walking in');
  settleStoryTurn(id, { pending: false, failure: 'They were busy.' });
  assert.equal(getStoryBook(id)!.companionError, 'They were busy.', 'the reason the turn gave wins over the plain one');

  scene(id);
  assert.equal(getStoryBook(id)!.companionError, null, 'a page that arrives clears the complaint');
  const started = reserveStoryOpening(id);
  assert.equal(started.dispatch, false, 'the bookmark is enough');
  assert.equal(started.book.companionPending, false);

  settleStoryTurn(id, { pending: false, failure: 'ignored' });
  assert.equal(getStoryBook(id)!.companionError, null, 'a turn that ends with nothing waiting has nothing to complain about');
});

test('asking again is only for a page turn that did not come back', () => {
  freshHouse();
  const { id } = book();
  assert.deepEqual(reserveStoryRetry(id).kind, 'opening', 'a book with no opening can ask for one');
  refused(() => reserveStoryRetry(id), 409, /already under way/);
  settleStoryTurn(id, { pending: false, failure: null });
  scene(id);
  refused(() => reserveStoryRetry(id), 409, /the next move is yours/);
  const move = recordStoryMove(id, { choiceId: 'c1' }).page;
  refused(() => reserveStoryRetry(id), 409, /already under way/);
  settleStoryTurn(id, { pending: false, failure: null });
  const retry = reserveStoryRetry(id);
  assert.deepEqual([retry.kind, retry.pageId, retry.book.companionPending, retry.book.companionError], ['move', move.id, true, null]);
});

test('a finished book takes no new pages and no moves, and keeps its cover and pictures', () => {
  freshHouse();
  const { id } = book();
  const first = scene(id).page;
  const closed = finishStoryBook(id, { maker: 'other' });
  assert.deepEqual([closed.status, closed.awaiting], ['finished', 'nothing']);
  assert.ok(closed.finishedAt);
  refused(() => finishStoryBook(id, { maker: 'other' }), 409, /already finished/);
  refused(() => scene(id), 409, /That book is finished/);
  refused(() => recordStoryMove(id, { choiceId: 'c1' }), 409, /That book is finished/);
  refused(() => reserveStoryRetry(id), 409, /That book is finished/);
  assert.equal(reserveStoryOpening(id).dispatch, false);

  assert.equal(setStoryCover(id, { maker: 'other', coverUrl: '/api/studio/gallery/cover.png' }).coverUrl, '/api/studio/gallery/cover.png');
  const pictured = setStoryScenePicture(first.id, { maker: 'other', imageUrl: '/api/studio/gallery/gate.png' });
  assert.equal(pictured.page.imageUrl, '/api/studio/gallery/gate.png');
});

test('a picture goes on a scene, never on a move', () => {
  freshHouse();
  const { id } = book();
  scene(id);
  const move = recordStoryMove(id, { choiceId: 'c1' }).page;
  refused(() => setStoryScenePicture(move.id, { maker: 'example', imageUrl: '/api/studio/gallery/x.png' }), 400, /Only a scene has a picture/);
  refused(() => setStoryScenePicture('no-page', { maker: 'example', imageUrl: '/api/studio/gallery/x.png' }), 404, /no page with that id/);
  refused(() => setStoryCover('no-book', { maker: 'example', coverUrl: '/x.png' }), 404, /no book with that id/);
});

test('keepsakes hang loose until they are woven into a second book', () => {
  freshHouse();
  const market = book({ title: 'The Night Market' });
  const lighthouse = book({ title: 'The Lighthouse' });
  const key = createStoryKeepsake({ maker: 'example', fromBookId: market.id, item: '  the  brass key ', note: 'Warm to the touch.' });
  assert.deepEqual(Object.keys(key), ['id', 'item', 'note', 'fromBookId', 'toBookId', 'maker', 'createdAt', 'wovenAt']);
  assert.deepEqual([key.item, key.toBookId, key.wovenAt], ['the brass key', null, null]);

  const woven = weaveStoryKeepsake(key.id, { maker: 'other', toBookId: lighthouse.id, note: 'It opens the lamp room.' });
  assert.deepEqual([woven.toBookId, woven.note], [lighthouse.id, 'It opens the lamp room.']);
  assert.ok(woven.wovenAt);
  refused(() => weaveStoryKeepsake(key.id, { maker: 'other', toBookId: market.id }), 409, /already woven into “The Lighthouse”/);

  const tied = createStoryKeepsake({ maker: 'other', fromBookId: lighthouse.id, item: 'a gull feather', toBookId: market.id });
  assert.ok(tied.wovenAt, 'a keepsake can be tied to both books at once');
  assert.deepEqual(listStoryKeepsakes(market.id).map((k) => k.item).sort(), ['a gull feather', 'the brass key']);
  assert.equal(listStoryKeepsakes().length, 2);

  refused(() => createStoryKeepsake({ maker: 'example', fromBookId: market.id, item: 'x', toBookId: market.id }), 400, /two different books/);
  refused(() => createStoryKeepsake({ maker: 'example', fromBookId: 'nope', item: 'x' }), 404, /no book with that id/);
  refused(() => createStoryKeepsake({ maker: 'example', fromBookId: market.id, item: '' }), 400, /item is required/);
  refused(() => createStoryKeepsake({ maker: 'example', fromBookId: market.id, item: 'i'.repeat(STORY_LIMITS.keepsakeItem + 1) }), 400, /80 characters or fewer/);
  refused(() => weaveStoryKeepsake('nope', { maker: 'example', toBookId: market.id }), 404, /no keepsake with that id/);
});

test('the shelf leads with the book their person was in last, and the finished ones come after', () => {
  freshHouse();
  const first = book({ title: 'First' });
  const second = book({ title: 'Second' });
  const done = book({ title: 'Done' });
  getDb().prepare('UPDATE story_books SET updated_at = ?, created_at = ? WHERE id = ?').run('2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', first.id);
  getDb().prepare('UPDATE story_books SET updated_at = ?, created_at = ? WHERE id = ?').run('2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z', second.id);
  scene(done.id);
  finishStoryBook(done.id, { maker: 'example' });
  assert.deepEqual(listStoryBooks().map((b) => b.title), ['Second', 'First', 'Done']);
  reserveStoryOpening(first.id);
  assert.deepEqual(listStoryBooks().map((b) => b.title), ['First', 'Second', 'Done'], 'walking into a book brings it to the front');
});

test("the shelf's thread is archived, holds every companion, and names nobody to lead it", () => {
  freshHouse();
  assert.equal(storyShelfThreadId(), null, 'reading the shelf never makes a thread');
  const id = ensureStoryShelfThread();
  assert.equal(ensureStoryShelfThread(), id, 'one thread for the whole shelf');
  assert.equal(storyShelfThreadId(), id);
  const thread = getThread(id)!;
  assert.equal(thread.name, 'The Story Shelf');
  assert.ok(thread.archived_at, 'it lives in the shelf, not in the thread picker');
  const members = getThreadRoster(id);
  assert.deepEqual(members.map((m) => m.id), ['example', 'other']);
});

test('the talk is everything said at the table during this book’s page turns, oldest first, and nothing from another book’s', () => {
  freshHouse();
  const market = book({ title: 'The Night Market' });
  const lighthouse = book({ title: 'The Lighthouse' });
  const threadId = ensureStoryShelfThread();
  const companionId = (getDb().prepare("SELECT id FROM companions WHERE id = 'example'").get() as { id: string }).id;
  let at = Date.UTC(2026, 9, 8, 3, 0, 0);
  const say = (content: string) => createMessage({
    id: `said-${at}`, threadId, role: 'companion', content, companionId, platform: 'api', createdAt: new Date(at++).toISOString(),
  });

  assert.deepEqual(storyTalk(market.id), []);
  writeStoryTurnOpener({ bookId: market.id, pageId: null, kind: 'opening', moveText: null, title: market.title });
  say('Ready?');
  scene(market.id);
  const move = recordStoryMove(market.id, { choiceId: 'c1' }).page;
  const opener = writeStoryTurnOpener({ bookId: market.id, pageId: move.id, kind: 'move', moveText: move.text, title: market.title });
  assert.equal(opener.role, 'user', 'the move goes into the thread in their person’s own words');
  assert.equal(opener.content, 'Go left');
  say('Ha.');
  say('Go on.');
  writeStoryTurnOpener({ bookId: lighthouse.id, pageId: null, kind: 'opening', moveText: null, title: lighthouse.title });
  say('Lamp lit.');
  writeStoryTurnOpener({ bookId: market.id, pageId: null, kind: 'retry', moveText: null, title: market.title });
  say('Back again.');

  // A page turn used to wipe the table: only the newest turn's talk showed,
  // and their person read that as the talk being lost.
  assert.deepEqual(storyTalk(market.id).map((line) => [line.content, line.companionSlug, line.role]), [
    ['Ready?', 'example', 'companion'],
    ['Ha.', 'example', 'companion'],
    ['Go on.', 'example', 'companion'],
    ['Back again.', 'example', 'companion'],
  ]);
  assert.deepEqual(storyTalk(lighthouse.id).map((line) => line.content), ['Lamp lit.'], 'another book’s turn keeps its own talk');
  assert.deepEqual(storyTalk(market.id, 2).map((line) => line.content), ['Go on.', 'Back again.'], 'past the limit, the newest lines are kept');
  const system = getDb().prepare("SELECT role, content FROM messages WHERE thread_id = ? AND role = 'system' ORDER BY sequence").all(threadId) as Array<{ content: string }>;
  assert.ok(system.some((m) => m.content === 'Opened “The Lighthouse”.'), 'walking into a book is a line from the house, not words in their person’s mouth');
});
