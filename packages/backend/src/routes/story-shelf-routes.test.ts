// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Story Shelf over HTTP: the loopback door the companions write through,
// the authed door their person reads and moves through, and the page turns in
// between. The lane here is a stand-in that writes through the real loopback
// door, the way the companions do, so a page turn is checked end to end.
//
// Every message a test writes is ten characters or fewer, or a system line:
// createMessage embeds anything longer in the background, and on a machine
// without the model that fetches ninety megabytes mid-test.
//
// byte-light adaptations: the loopback door is createInternalRoutes() mounted
// under /api with express.json and trust proxy 1, as server.ts and api.ts
// compose it (Aerie has a separate internal-server); config boots on defaults
// in a scratch RESONANT_HOME with APP_PASSWORD set; companions are plain
// registry rows (id = slug) seeded with an INSERT; the live update is
// byte-light's registry (services/registry.ts), QUEUE_TIMEOUT_MESSAGE comes
// from services/agent.ts, and the session cookie is bytelight_session. A
// relayed request to the door is refused with byte-light's 403 Localhost only
// (Aerie's internal server answers 404).
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { ServerMessage, StoryBookSummary, StoryBookView, StoryShelfView } from '@bytelight/shared';

// The phone's door has to be shut without a session, so this house has a password.
process.env.APP_PASSWORD = 'story-test-password';
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const tmpRoot = mkdtempSync(join(tmpdir(), 'story-shelf-routes-test-'));
process.env.RESONANT_HOME = tmpRoot;
const { loadConfig } = await import('../config.js');
loadConfig(join(tmpRoot, 'no-config.yaml'));

const { initDb, getDb } = await import('../services/db/init.js');
const { createMessage } = await import('../services/db/messages.js');
const { getThread } = await import('../services/db/threads.js');
const { createWebSession } = await import('../services/db/web-sessions.js');
const { createInternalRoutes } = await import('./internal-routes.js');
const { setStoryGallery, storyTurnsIdle, storyTalkIdle } = await import('../services/story-shelf.js');
const { QUEUE_TIMEOUT_MESSAGE } = await import('../services/agent.js');
const { TURN_ENDED_EMPTY } = await import('../services/db/story-shelf.js');
const { registry } = await import('../services/registry.js');
const storyShelfRoutes = (await import('./story-shelf.js')).default;

const SUMMARY_KEYS = [
  'id', 'title', 'genre', 'spicy', 'blurb', 'coverUrl', 'createdBy', 'status', 'createdAt', 'updatedAt', 'finishedAt',
  'openedAt', 'pageCount', 'sceneCount', 'bookmark', 'awaiting', 'companionPending', 'companionError',
];

const exampleId = 'example';

function freshHouse(): void {
  initDb(':memory:');
  getDb().prepare('DELETE FROM companions').run();
  for (const slug of ['example', 'other']) {
    getDb().prepare("INSERT INTO companions (id, display_name, brain) VALUES (?, ?, 'test')").run(slug, slug[0].toUpperCase() + slug.slice(1));
  }
}

/** The loopback door, as server.ts and api.ts compose it. */
function createInternalApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api', createInternalRoutes());
  return app;
}

/** A gallery holding two stills and a film. */
function fakeGallery(): void {
  setStoryGallery({
    find: async (filename) => {
      if (filename === 'gate.png' || filename === 'cover.png') return { filename, mediaType: 'image' };
      if (filename === 'walk.mp4') return { filename, mediaType: 'video' };
      return null;
    },
  });
}

async function listen(app: express.Express): Promise<{ base: string; close: () => void }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

/** Collect every broadcast for the life of the test. */
function listenForUpdates(): ServerMessage[] {
  const seen: ServerMessage[] = [];
  const original = registry.broadcast;
  registry.broadcast = (message: ServerMessage) => { seen.push(message); };
  test.after(() => { registry.broadcast = original; });
  return seen;
}

interface LaneCall {
  threadId: string;
  prompt: string;
  meta: unknown;
  opts: unknown;
}

/**
 * A stand-in for the companions' lane. Each turn runs `answer`, which may write
 * a page through the loopback door, and hands back whatever it returns.
 */
function fakeLane(answer: (call: LaneCall, n: number) => Promise<string> | string = () => 'ok') {
  const calls: LaneCall[] = [];
  return {
    calls,
    processMessage: async (threadId: string, prompt: string, meta?: unknown, opts?: unknown) => {
      const call = { threadId, prompt, meta, opts };
      calls.push(call);
      return answer(call, calls.length);
    },
  };
}

/** Both doors, a signed-in session for the phone's, and the lane behind it. */
async function house(lane: ReturnType<typeof fakeLane> | null) {
  const token = `story-${Math.random().toString(36).slice(2)}`;
  createWebSession({
    id: token, token, createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const internal = await listen(createInternalApp());
  const phoneApp = express();
  phoneApp.use(express.json());
  if (lane) phoneApp.locals.agentService = lane;
  phoneApp.use('/api/story-shelf', storyShelfRoutes);
  const phone = await listen(phoneApp);
  const cookie = `bytelight_session=${token}`;
  return {
    internal,
    phone,
    lane: (method: string, path: string, body?: unknown) => call(internal.base, method, `/api/internal/story-shelf${path}`, body),
    owner: (method: string, path: string, body?: unknown) => call(phone.base, method, `/api/story-shelf${path}`, body, { cookie }),
    close: () => { internal.close(); phone.close(); },
  };
}

async function shelveBook(doors: Awaited<ReturnType<typeof house>>, extra: Record<string, unknown> = {}): Promise<StoryBookSummary> {
  const made = await doors.lane('POST', '/books', {
    maker: 'example', title: 'The Night Market', genre: 'cozy gothic', bible: 'BIBLE: the stalls move.', ...extra,
  });
  assert.equal(made.status, 201, made.text);
  return made.json.book as StoryBookSummary;
}

async function writeScene(doors: Awaited<ReturnType<typeof house>>, bookId: string, extra: Record<string, unknown> = {}) {
  const written = await doors.lane('POST', `/books/${bookId}/pages`, {
    maker: 'example', text: 'The gate is open.', choices: [{ label: 'Go left' }, { label: 'Wait' }], ...extra,
  });
  assert.equal(written.status, 201, written.text);
  return written.json;
}

test.afterEach(() => {
  setStoryGallery(null);
});

test('the loopback door shelves a book, writes its pages, and tells the phone at every step', async () => {
  freshHouse();
  fakeGallery();
  const updates = listenForUpdates();
  const doors = await house(null);
  try {
    const book = await shelveBook(doors, { spicy: true, blurb: 'Only the reader notices.' });
    assert.deepEqual(Object.keys(book), SUMMARY_KEYS, 'a write answers with the book as the shelf lists it, not the whole book');
    assert.deepEqual([book.spicy, book.awaiting], [true, 'opening']);

    const written = await writeScene(doors, book.id, {
      picture: 'gate.png',
      state: { badge: 'Night 1', stats: [{ label: 'Courage', value: 2 }] },
      widget: 'function App({ move }) { return <button onClick={() => move("c2")}>Wait</button>; }',
    });
    assert.deepEqual(Object.keys(written), ['page', 'book']);
    assert.deepEqual(Object.keys(written.book), SUMMARY_KEYS);
    assert.equal(written.page.imageUrl, '/api/studio/gallery/gate.png');
    assert.deepEqual(written.page.choices.map((c: { id: string }) => c.id), ['c1', 'c2']);
    assert.equal(written.book.awaiting, 'move');

    const later = await writeScene(doors, book.id, { text: 'Night falls.', choices: [] });
    const pictured = await doors.lane('POST', `/pages/${later.page.id}/picture`, { maker: 'other', filename: 'gate.png' });
    assert.equal(pictured.status, 200, pictured.text);
    assert.equal(pictured.json.page.imageUrl, '/api/studio/gallery/gate.png');

    const covered = await doors.lane('POST', `/books/${book.id}/cover`, { maker: 'other', filename: 'cover.png' });
    assert.equal(covered.status, 200, covered.text);
    assert.equal(covered.json.book.coverUrl, '/api/studio/gallery/cover.png');

    const second = await shelveBook(doors, { title: 'The Lighthouse' });
    const tied = await doors.lane('POST', '/keepsakes', { maker: 'example', fromBookId: book.id, item: 'the brass key' });
    assert.equal(tied.status, 201, tied.text);
    const woven = await doors.lane('POST', `/keepsakes/${tied.json.keepsake.id}/weave`, { maker: 'other', toBookId: second.id });
    assert.equal(woven.status, 200, woven.text);
    assert.equal(woven.json.keepsake.toBookId, second.id);

    const read = await doors.lane('GET', `/books/${book.id}`);
    assert.equal(read.status, 200);
    const view = read.json as StoryBookView;
    assert.deepEqual(Object.keys(view), ['book', 'keepsakes', 'talk', 'threadId']);
    assert.equal(view.book.bible, 'BIBLE: the stalls move.');
    assert.deepEqual(view.book.pages.map((p) => p.text), ['The gate is open.', 'Night falls.']);
    assert.deepEqual(view.keepsakes.map((k) => k.item), ['the brass key']);
    assert.deepEqual([view.talk, view.threadId], [[], null], 'reading a book never makes the shelf a thread');

    const shelf = (await doors.lane('GET', '')).json as StoryShelfView;
    assert.deepEqual(Object.keys(shelf), ['books', 'keepsakes']);
    assert.deepEqual(shelf.books.map((b) => Object.keys(b)), [SUMMARY_KEYS, SUMMARY_KEYS]);

    const finished = await doors.lane('POST', `/books/${book.id}/finish`, { maker: 'example' });
    assert.equal(finished.status, 200);
    assert.deepEqual([finished.json.book.status, finished.json.book.awaiting], ['finished', 'nothing']);

    const told = updates.filter((m) => m.type === 'story_update').map((m) => (m as { bookId: string | null }).bookId);
    // A keepsake touches two books, so it names neither: null tells the phone
    // to re-read whatever book is open.
    assert.deepEqual(told, [book.id, book.id, book.id, book.id, book.id, second.id, null, null, book.id],
      'shelved, scene, scene, picture, cover, second shelved, keepsake tied, keepsake woven, finished');
  } finally {
    doors.close();
  }
});

test('every refusal from the loopback door is one plain sentence under error', async () => {
  freshHouse();
  fakeGallery();
  const doors = await house(null);
  const refused = async (method: string, path: string, body: unknown, status: number, sentence: RegExp) => {
    const res = await doors.lane(method, path, body);
    assert.equal(res.status, status, `${method} ${path} ${JSON.stringify(body)} → ${res.text}`);
    assert.deepEqual(Object.keys(res.json ?? {}), ['error'], `${path} answers { error } and nothing else`);
    assert.match(res.json.error, sentence);
  };
  try {
    const book = await shelveBook(doors);
    await refused('POST', '/books', { title: 'x', genre: 'x', bible: 'x' }, 400, /maker is required/);
    await refused('POST', '/books', { maker: 'nobody', title: 'x', genre: 'x', bible: 'x' }, 400, /Unknown companion slug 'nobody'/);
    await refused('POST', `/books/${book.id}/pages`, { maker: 'example', text: 'x', picture: 'missing.png' }, 404, /The Studio gallery has no picture by that name/);
    await refused('POST', `/books/${book.id}/pages`, { maker: 'example', text: 'x', picture: 'walk.mp4' }, 400, /that one is a film/);
    await refused('POST', `/books/${book.id}/pages`, { maker: 'example', text: 'x', picture: '../secret.png' }, 400, /not a path/);
    await refused('POST', `/books/${book.id}/pages`, { maker: 'example', text: 'x', picture: 7 }, 400, /picture is a filename/);
    await refused('POST', `/books/${book.id}/pages`, { maker: 'example', text: 'x', state: { mood: 1 } }, 400, /state can only carry/);
    await refused('POST', '/books/no-such-book/pages', { maker: 'example', text: 'x' }, 404, /no book with that id/);
    await refused('POST', `/books/${book.id}/cover`, { maker: 'example' }, 400, /filename is required/);
    await refused('POST', '/pages/no-such-page/picture', { maker: 'example', filename: 'gate.png' }, 404, /no page with that id/);
    await refused('POST', '/keepsakes', { maker: 'example', item: 'x' }, 400, /fromBookId is required/);
    await refused('GET', '/books/no-such-book', undefined, 404, /no book with that id/);
    assert.equal((await doors.lane('GET', `/books/${book.id}`)).status, 200, 'and every refusal above wrote nothing');
    assert.equal(((await doors.lane('GET', `/books/${book.id}`)).json as StoryBookView).book.pageCount, 0);
  } finally {
    doors.close();
  }
});

test('a relayed request to the shelf door is refused like any other internal route', async () => {
  freshHouse();
  const { base, close } = await listen(createInternalApp());
  try {
    const res = await call(base, 'GET', '/api/internal/story-shelf', undefined, { 'x-forwarded-for': '203.0.113.9' });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { error: 'Localhost only' });
  } finally {
    close();
  }
});

test('the phone reads the shelf only with a session, and cannot move without the companions’ lane', async () => {
  freshHouse();
  const doors = await house(null);
  try {
    const book = await shelveBook(doors);
    const shut = await call(doors.phone.base, 'GET', '/api/story-shelf');
    assert.equal(shut.status, 401, 'no session, no shelf');
    const shelf = await doors.owner('GET', '');
    assert.equal(shelf.status, 200);
    assert.deepEqual((shelf.json as StoryShelfView).books.map((b) => b.title), ['The Night Market']);
    const opened = await doors.owner('GET', `/books/${book.id}`);
    assert.equal(opened.status, 200);
    assert.equal((opened.json as StoryBookView).book.bible, 'BIBLE: the stalls move.', 'their person may read the bible they wrote');
    assert.equal((await doors.owner('GET', '/books/no-such-book')).status, 404);

    const noLane = await doors.owner('POST', `/books/${book.id}/open`, {});
    assert.equal(noLane.status, 503);
    assert.match(noLane.json.error, /lane is not available/);
    assert.equal((await doors.owner('POST', `/books/${book.id}/pages`, { maker: 'example', text: 'x' })).status, 404,
      'the phone has no door to write a scene through');
  } finally {
    doors.close();
  }
});

test('walking into a new book sends the companions one opening turn, carrying the bible, in the shelf’s own thread', async () => {
  freshHouse();
  const updates = listenForUpdates();
  let doors!: Awaited<ReturnType<typeof house>>;
  const lane = fakeLane(async (turn) => {
    // The companions write the opening through the loopback door, then say a line at the table.
    const book = (await doors.lane('GET', '')).json.books[0] as StoryBookSummary;
    await writeScene(doors, book.id);
    createMessage({ id: 'said-1', threadId: turn.threadId, role: 'companion', content: 'Ready?', companionId: exampleId, platform: 'api', createdAt: new Date().toISOString() });
    return 'ok';
  });
  doors = await house(lane);
  try {
    const book = await shelveBook(doors);
    const opened = await doors.owner('POST', `/books/${book.id}/open`, {});
    assert.equal(opened.status, 200, opened.text);
    assert.deepEqual(Object.keys(opened.json), ['view', 'dispatched']);
    assert.equal(opened.json.dispatched, true);
    assert.equal((opened.json.view as StoryBookView).book.companionPending, true, 'the book says its opening is on its way');

    await storyTurnsIdle();
    assert.equal(lane.calls.length, 1);
    const [turn] = lane.calls;
    const thread = getThread(turn.threadId)!;
    assert.equal(thread.name, 'The Story Shelf');
    assert.ok(thread.archived_at, 'the turn arrives in the shelf’s own archived thread');
    assert.deepEqual(turn.meta, { name: 'The Story Shelf', type: 'named' });
    assert.deepEqual(turn.opts, { platform: 'api' });
    assert.match(turn.prompt, /opened “The Night Market”/);
    assert.match(turn.prompt, /BIBLE: the stalls move\./);
    assert.match(turn.prompt, new RegExp(`/api/internal/story-shelf/books/${book.id}/pages`));

    const view = (await doors.owner('GET', `/books/${book.id}`)).json as StoryBookView;
    assert.deepEqual([view.book.awaiting, view.book.companionPending, view.book.companionError], ['move', false, null]);
    assert.deepEqual(view.talk.map((line) => [line.content, line.companionSlug]), [['Ready?', 'example']]);
    assert.equal(view.threadId, turn.threadId);

    const again = await doors.owner('POST', `/books/${book.id}/open`, {});
    assert.equal(again.json.dispatched, false, 'a started book needs nothing but its bookmark');
    await storyTurnsIdle();
    assert.equal(lane.calls.length, 1);
    assert.ok(updates.some((m) => m.type === 'story_update' && m.bookId === book.id));
  } finally {
    doors.close();
  }
});

test('a move goes in once and reaches the lane with the scene it answers; an empty turn says so and can be asked again', async () => {
  freshHouse();
  let doors!: Awaited<ReturnType<typeof house>>;
  let writePage = false;
  const lane = fakeLane(async () => {
    if (writePage) {
      const book = (await doors.lane('GET', '')).json.books[0] as StoryBookSummary;
      await writeScene(doors, book.id, { text: 'The lamplighter turns.' });
    }
    return 'ok';
  });
  doors = await house(lane);
  try {
    const book = await shelveBook(doors);
    await writeScene(doors, book.id);

    const moved = await doors.owner('POST', `/books/${book.id}/move`, { choiceId: 'c2' });
    assert.equal(moved.status, 202, moved.text);
    const view = moved.json.view as StoryBookView;
    assert.deepEqual([view.book.awaiting, view.book.companionPending], ['scene', true]);
    assert.deepEqual(view.book.pages.at(-1)!.text, 'Wait');
    const twice = await doors.owner('POST', `/books/${book.id}/move`, { text: 'Hi' });
    assert.equal(twice.status, 409);
    assert.match(twice.json.error, /Your move is already in/);

    await storyTurnsIdle();
    assert.equal(lane.calls.length, 1);
    assert.match(lane.calls[0].prompt, /The scene .+ was answering:\n<<<\nThe gate is open\.\n>>>/);
    assert.match(lane.calls[0].prompt, /move: chose c2, “Wait”\./);
    assert.doesNotMatch(lane.calls[0].prompt, /BIBLE:/);

    const said = getDb().prepare("SELECT role, content, metadata FROM messages WHERE thread_id = ? AND role = 'user'").all(lane.calls[0].threadId) as Array<{ content: string; metadata: string }>;
    assert.deepEqual(said.map((m) => m.content), ['Wait'], 'the move is in the thread in their person’s own words');
    assert.equal(JSON.parse(said[0].metadata).storyBookId, book.id);

    const stalled = (await doors.owner('GET', `/books/${book.id}`)).json as StoryBookView;
    assert.deepEqual([stalled.book.awaiting, stalled.book.companionPending, stalled.book.companionError], ['scene', false, TURN_ENDED_EMPTY]);

    writePage = true;
    const retried = await doors.owner('POST', `/books/${book.id}/retry`, {});
    assert.equal(retried.status, 202, retried.text);
    await storyTurnsIdle();
    assert.equal(lane.calls.length, 2);
    assert.match(lane.calls[1].prompt, /Asked again: the last page turn did not come back with a page\./);
    const answered = (await doors.owner('GET', `/books/${book.id}`)).json as StoryBookView;
    assert.deepEqual([answered.book.awaiting, answered.book.companionPending, answered.book.companionError], ['move', false, null]);
    assert.deepEqual(answered.book.pages.map((p) => p.kind), ['scene', 'move', 'scene']);

    const nothing = await doors.owner('POST', `/books/${book.id}/retry`, {});
    assert.equal(nothing.status, 409);
    assert.match(nothing.json.error, /the next move is yours/);
    const bad = await doors.owner('POST', `/books/${book.id}/move`, { choiceId: 'c9' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /no choice 'c9'/);
  } finally {
    doors.close();
  }
});

test('a line said at the table while the lane is busy keeps asking until it is answered, instead of being dropped', async () => {
  // The lane's own line gives up on a caller after ninety seconds and a turn can
  // run far longer, so a line said during one used to come back refused and
  // reach nobody.
  freshHouse();
  let doors!: Awaited<ReturnType<typeof house>>;
  let bookId = '';
  const lane = fakeLane(async (call, n) => {
    if (n === 1) {
      await writeScene(doors, bookId);
      return 'ok';
    }
    if (n === 2) return QUEUE_TIMEOUT_MESSAGE;
    createMessage({
      id: `answered-${n}`, threadId: call.threadId, role: 'companion', content: 'Got it this time.', companionId: exampleId,
      platform: 'api', createdAt: new Date().toISOString(),
    });
    return 'ok';
  });
  doors = await house(lane);
  try {
    const book = await shelveBook(doors);
    bookId = book.id;
    assert.equal((await doors.owner('POST', `/books/${book.id}/open`, {})).status, 200);
    await storyTurnsIdle();

    const said = await doors.owner('POST', `/books/${book.id}/talk`, { text: 'Is anyone there?' });
    assert.equal(said.status, 202, said.text);
    await storyTalkIdle();

    assert.equal(lane.calls.length, 3, 'a refusal from a busy lane is asked again, not dropped');
    assert.equal(lane.calls[2].prompt, lane.calls[1].prompt, 'the same line, asked again');
    assert.match(lane.calls[2].prompt, /\nIs anyone there\?$/);
    const read = (await doors.owner('GET', `/books/${book.id}`)).json as StoryBookView;
    assert.deepEqual(read.talk.map((line) => [line.role, line.content]), [['user', 'Is anyone there?'], ['companion', 'Got it this time.']],
      'the line sits at the table once, however many times it had to ask');
  } finally {
    doors.close();
  }
});

test('table talk goes in in their person’s own words, reaches the lane as talk rather than a move, and never turns the page', async () => {
  freshHouse();
  let doors!: Awaited<ReturnType<typeof house>>;
  let bookId = '';
  const lane = fakeLane(async (call, n) => {
    if (n === 1) {
      await writeScene(doors, bookId);
    } else {
      createMessage({
        id: `said-${n}`, threadId: call.threadId, role: 'companion', content: 'Ha.', companionId: exampleId,
        platform: 'api', createdAt: new Date().toISOString(),
      });
    }
    return 'ok';
  });
  doors = await house(lane);
  try {
    const book = await shelveBook(doors);
    bookId = book.id;
    assert.equal((await doors.owner('POST', `/books/${book.id}/open`, {})).status, 200);
    await storyTurnsIdle();
    assert.equal(lane.calls.length, 1, 'the opening turn wrote the first scene');

    const said = await doors.owner('POST', `/books/${book.id}/talk`, { text: '  Eek!  ' });
    assert.equal(said.status, 202, said.text);
    const view = said.json.view as StoryBookView;
    assert.deepEqual(view.book.pages.map((p) => p.kind), ['scene'], 'talk is not a move and turns no page');
    assert.deepEqual([view.book.awaiting, view.book.companionPending], ['move', false]);

    assert.equal(lane.calls.length, 2);
    assert.equal(lane.calls[1].threadId, lane.calls[0].threadId, 'it is said in the shelf’s own thread');
    assert.match(lane.calls[1].prompt, /said this at the table while reading “The Night Market”/);
    assert.match(lane.calls[1].prompt, /This is table talk, not a move\./);
    assert.match(lane.calls[1].prompt, /\nEek!$/);
    assert.doesNotMatch(lane.calls[1].prompt, /BIBLE:/);

    const read = (await doors.owner('GET', `/books/${book.id}`)).json as StoryBookView;
    assert.deepEqual(read.talk.map((line) => [line.role, line.content]), [['user', 'Eek!'], ['companion', 'Ha.']]);

    const empty = await doors.owner('POST', `/books/${book.id}/talk`, { text: '   ' });
    assert.equal(empty.status, 400);
    assert.match(empty.json.error, /nothing to say/);
    const nowhere = await doors.owner('POST', '/books/no-such-book/talk', { text: 'Hi' });
    assert.equal(nowhere.status, 404);
    assert.equal(lane.calls.length, 2, 'a refused line reaches nobody');
  } finally {
    doors.close();
  }
});

test('a page turn the lane never took, or dropped, says why', async () => {
  freshHouse();
  const answers: Array<() => string> = [
    () => '[Request timed out in queue]',
    () => { throw new Error('the lane fell over'); },
  ];
  const lane = fakeLane((_call, n) => answers[n - 1]());
  const doors = await house(lane);
  try {
    const book = await shelveBook(doors);
    await doors.owner('POST', `/books/${book.id}/open`, {});
    await storyTurnsIdle();
    const timedOut = (await doors.owner('GET', `/books/${book.id}`)).json as StoryBookView;
    assert.match(timedOut.book.companionError ?? '', /timed out waiting for them/);

    await doors.owner('POST', `/books/${book.id}/retry`, {});
    await storyTurnsIdle();
    const dropped = (await doors.owner('GET', `/books/${book.id}`)).json as StoryBookView;
    assert.match(dropped.book.companionError ?? '', /line to the table dropped/);
    assert.equal(dropped.book.companionPending, false);
  } finally {
    doors.close();
  }
});

test('page turns run one at a time, so what each turn said at the table stays with its own book', async () => {
  freshHouse();
  let doors!: Awaited<ReturnType<typeof house>>;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const lane = fakeLane(async (turn, n) => {
    const titles = n === 1 ? 'The Night Market' : 'The Lighthouse';
    if (n === 1) await gate;
    const book = ((await doors.lane('GET', '')).json.books as StoryBookSummary[]).find((b) => b.title === titles)!;
    await writeScene(doors, book.id, { text: `${titles} opens.` });
    createMessage({ id: `said-${n}`, threadId: turn.threadId, role: 'companion', content: n === 1 ? 'Market.' : 'Lamp.', companionId: exampleId, platform: 'api', createdAt: new Date().toISOString() });
    return 'ok';
  });
  doors = await house(lane);
  try {
    const market = await shelveBook(doors);
    const lighthouse = await shelveBook(doors, { title: 'The Lighthouse' });
    await doors.owner('POST', `/books/${market.id}/open`, {});
    await doors.owner('POST', `/books/${lighthouse.id}/open`, {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(lane.calls.length, 1, 'the second turn waits for the first to finish');
    const waiting = (await doors.owner('GET', `/books/${lighthouse.id}`)).json as StoryBookView;
    assert.equal(waiting.book.companionPending, true, 'and its book says a page is on its way');
    release();
    await storyTurnsIdle();
    assert.equal(lane.calls.length, 2);
    const talk = async (id: string) => ((await doors.owner('GET', `/books/${id}`)).json as StoryBookView).talk.map((line) => line.content);
    assert.deepEqual(await talk(market.id), ['Market.']);
    assert.deepEqual(await talk(lighthouse.id), ['Lamp.']);
  } finally {
    doors.close();
  }
});
