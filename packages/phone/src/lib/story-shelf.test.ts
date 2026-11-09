// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Shelf app's decisions, checked without a browser: what counts as the
// shelf at all, what a book is waiting on, which books wear a thread and in
// what color, how a spine looks, where a book opens, and what a widget may say.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STORY_LIMITS, type StoryBook, type StoryBookSummary, type StoryKeepsake, type StoryPage } from '@bytelight/shared';
import {
  TABLE_WAIT_MS,
  bibleSections,
  tableAwaiting,
  ORANGE_THREAD,
  RED_THREAD,
  SPINE_TITLE_MIN,
  bookStage,
  bookmarkPageId,
  bookmarkThread,
  isStoryBookView,
  isStoryShelfView,
  keepsakeEntries,
  readWidgetMove,
  splitShelf,
  spineLook,
  spineTitle,
  stateCardHasContent,
  threadColor,
  widgetMove,
} from './story-shelf';

function summary(extra: Partial<StoryBookSummary> = {}): StoryBookSummary {
  return {
    id: 'b1', title: 'The Night Market', genre: 'cozy gothic', spicy: false, blurb: null, coverUrl: null, createdBy: 'example',
    status: 'reading', createdAt: 'x', updatedAt: 'x', finishedAt: null, openedAt: null, pageCount: 0, sceneCount: 0,
    bookmark: null, awaiting: 'opening', companionPending: false, companionError: null, ...extra,
  };
}

function page(id: string, kind: 'scene' | 'move'): StoryPage {
  return {
    id, bookId: 'b1', at: 'x', kind, author: kind === 'move' ? 'owner' : 'example', text: id, imageUrl: null,
    state: null, choices: [], widget: null, choiceId: null,
  };
}

function book(pages: StoryPage[], extra: Partial<StoryBook> = {}): StoryBook {
  return { ...summary(), bible: 'b', pages, ...extra };
}

test('only the real shelf counts as the shelf, so an older backend answering with the phone page is caught', () => {
  assert.equal(isStoryShelfView({ books: [summary()], keepsakes: [] }), true);
  assert.equal(isStoryShelfView('<!doctype html>'), false);
  assert.equal(isStoryShelfView(null), false);
  assert.equal(isStoryShelfView({ books: 'x', keepsakes: [] }), false);
  assert.equal(isStoryShelfView({ books: [] }), false);
  assert.equal(isStoryShelfView({ books: [{ id: 'b1' }], keepsakes: [] }), false);

  assert.equal(isStoryBookView({ book: book([page('p1', 'scene')]), keepsakes: [], talk: [], threadId: null }), true);
  assert.equal(isStoryBookView({ book: summary(), keepsakes: [], talk: [], threadId: null }), false, 'a book without pages is not a book view');
  assert.equal(isStoryBookView({ book: book([]), keepsakes: [], talk: 'x', threadId: null }), false);
});

test('a book’s stage says what the bottom of the page shows', () => {
  assert.deepEqual(bookStage(summary()), { stage: 'begin' });
  assert.deepEqual(bookStage(summary({ companionPending: true })), { stage: 'writing', first: true });
  assert.deepEqual(bookStage(summary({ companionError: 'They were busy.' })), { stage: 'stalled', first: true, reason: 'They were busy.' });
  assert.deepEqual(bookStage(summary({ awaiting: 'scene', companionPending: true })), { stage: 'writing', first: false });
  assert.deepEqual(bookStage(summary({ awaiting: 'scene' })), { stage: 'stalled', first: false, reason: 'No page has come back for that move yet.' });
  assert.deepEqual(bookStage(summary({ awaiting: 'move' })), { stage: 'your-move', finishing: false });
  assert.deepEqual(bookStage(summary({ awaiting: 'move', companionPending: true })), { stage: 'your-move', finishing: true },
    'a page that has arrived is their person’s to answer even while they are still finishing up');
  assert.deepEqual(bookStage(summary({ status: 'finished', awaiting: 'nothing' })), { stage: 'the-end' });
});

test('the shelf splits into the books being read and the finished ones, keeping the house’s order', () => {
  const books = [summary({ id: 'a' }), summary({ id: 'b', status: 'finished' }), summary({ id: 'c' })];
  const { reading, finished } = splitShelf(books);
  assert.deepEqual(reading.map((b) => b.id), ['a', 'c']);
  assert.deepEqual(finished.map((b) => b.id), ['b']);
});

test('a book in progress wears their person’s thread at its bookmark: their own color, or red on a spicy book', () => {
  const started = summary({ sceneCount: 2, pageCount: 3, awaiting: 'move' });
  assert.equal(bookmarkThread(started, 'oklch(0.7 0.18 50)'), 'oklch(0.7 0.18 50)', 'the thread is their person’s color');
  assert.equal(bookmarkThread(started), ORANGE_THREAD, 'and orange until the phone knows their person’s color');
  assert.equal(bookmarkThread(started, '  '), ORANGE_THREAD);
  assert.equal(bookmarkThread({ ...started, spicy: true }, 'oklch(0.7 0.18 50)'), RED_THREAD);
  assert.equal(bookmarkThread(summary()), null, 'a book not yet begun has no bookmark');
  assert.equal(bookmarkThread({ ...started, status: 'finished' }), null, 'a finished book has been closed');
  assert.match(ORANGE_THREAD, /^oklch\(/);
  assert.match(RED_THREAD, /^oklch\(/);
});

test('their person’s thread in a book is their own color, and red in a spicy one, begun or not', () => {
  assert.equal(threadColor(summary(), 'oklch(0.7 0.18 50)'), 'oklch(0.7 0.18 50)');
  assert.equal(threadColor(summary()), ORANGE_THREAD);
  assert.equal(threadColor(summary({ spicy: true }), 'oklch(0.7 0.18 50)'), RED_THREAD);
});

test('a spine looks the same every time for the same book, and different books lean differently', () => {
  const one = spineLook(summary({ id: 'book-one' }));
  assert.deepEqual(spineLook(summary({ id: 'book-one' })), one);
  assert.ok(one.hue >= 0 && one.hue < 360);
  assert.ok(one.height >= 196 && one.height <= 216, `height ${one.height}`);
  assert.ok(one.width >= 56 && one.width <= 64, `width ${one.width}`);
  const looks = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => spineLook(summary({ id })).hue));
  assert.ok(looks.size > 3, 'a shelf of books is not one color');
});

test('a title runs down its spine in two lines at most, as large as it fits, and never breaks a word to get there', () => {
  assert.deepEqual(spineTitle('Low Tide', 160), { text: 'Low Tide', size: 13 });
  const roomy = spineTitle('The Lighthouse Keeper’s Ledger', 150);
  assert.deepEqual(roomy, { text: 'The Lighthouse Keeper’s Ledger', size: 13 });
  const tight = spineTitle('The Lighthouse Keeper’s Ledger', 100);
  assert.equal(tight.text, 'The Lighthouse Keeper’s Ledger', 'smaller letters come before fewer words');
  assert.ok(tight.size < 13 && tight.size >= SPINE_TITLE_MIN, `size ${tight.size}`);
  for (const run of [60, 80, 120, 140, 180]) {
    assert.ok(spineTitle('The Night Market After Hours', run).size <= spineTitle('The Night Market After Hours', run + 20).size, 'a longer spine never gets smaller letters');
  }
  assert.equal(spineTitle('The\n  Night Market ', 160).text, 'The Night Market', 'whitespace is folded the way it renders');
});

test('a title too long for any size stops at the end of a word and says there is more', () => {
  const title = 'Whatever Waits Beneath the Willow Wood When the Lanterns Go Out One by One';
  const fit = spineTitle(title, 120);
  assert.match(fit.text, /…$/);
  const kept = fit.text.slice(0, -1);
  assert.ok(kept.length > 0 && title.startsWith(kept) && title[kept.length] === ' ', `"${fit.text}" stops at a word`);
  assert.equal(fit.size, SPINE_TITLE_MIN);
  const word = 'Supercalifragilisticexpialidociously';
  assert.deepEqual(spineTitle(word, 80), { text: word, size: SPINE_TITLE_MIN }, 'a word no size can hold is left whole for the spine to break');
});

test('a book opens at its bookmark: the newest page', () => {
  assert.equal(bookmarkPageId(book([])), null);
  assert.equal(bookmarkPageId(book([page('p1', 'scene')])), 'p1');
  assert.equal(bookmarkPageId(book([page('p1', 'scene'), page('p2', 'move')])), 'p2', 'their person’s own move, when its answer is still coming');
});

test('a widget may say one thing, a short move, and anything else is ignored', () => {
  assert.equal(readWidgetMove({ type: 'story-move', value: '  open   the   lock ' }), 'open the lock');
  assert.equal(readWidgetMove({ type: 'story-move', value: 'c2' }), 'c2');
  assert.equal(readWidgetMove({ type: 'story-move', value: '' }), null);
  assert.equal(readWidgetMove({ type: 'story-move', value: '   ' }), null);
  assert.equal(readWidgetMove({ type: 'story-move', value: 42 }), null);
  assert.equal(readWidgetMove({ type: 'story-move', value: 'x'.repeat(STORY_LIMITS.widgetMove + 1) }), null);
  assert.equal(readWidgetMove({ type: 'resize', value: '400' }), null);
  assert.equal(readWidgetMove('story-move'), null);
  assert.equal(readWidgetMove(null), null);
  assert.equal(readWidgetMove([{ type: 'story-move', value: 'x' }]), null);
});

test('a widget’s move is a choice when it names one, and their person’s own words when it does not', () => {
  const choices = [{ id: 'c1', label: 'Go left' }, { id: 'c2', label: 'Wait' }];
  assert.deepEqual(widgetMove('c2', choices), { choiceId: 'c2', label: 'Wait' });
  assert.deepEqual(widgetMove('I pick the lock', choices), { text: 'I pick the lock' });
});

test('a state card with nothing on it is not drawn', () => {
  assert.equal(stateCardHasContent(null), false);
  assert.equal(stateCardHasContent({}), false);
  assert.equal(stateCardHasContent({ inventory: [] }), false);
  assert.equal(stateCardHasContent({ badge: 'Night 1' }), true);
  assert.equal(stateCardHasContent({ stats: [{ label: 'Courage', value: '2' }] }), true);
});

test('the threads on a book read from its side: what was found here and where it went, and what came from elsewhere', () => {
  const titles = new Map([['b1', 'The Night Market'], ['b2', 'The Lighthouse']]);
  const keepsake = (extra: Partial<StoryKeepsake>): StoryKeepsake => ({
    id: 'k', item: 'x', note: null, fromBookId: 'b1', toBookId: null, maker: 'example', createdAt: 'x', wovenAt: null, ...extra,
  });
  assert.deepEqual(keepsakeEntries('b1', [
    keepsake({ id: 'k1', item: 'the brass key', toBookId: 'b2', note: 'It opens the lamp room.' }),
    keepsake({ id: 'k2', item: 'a ribbon' }),
    keepsake({ id: 'k3', item: 'a gull feather', fromBookId: 'b2', toBookId: 'b1' }),
  ], titles), [
    { id: 'k1', direction: 'found', item: 'the brass key', note: 'It opens the lamp room.', otherBookId: 'b2', otherTitle: 'The Lighthouse' },
    { id: 'k2', direction: 'found', item: 'a ribbon', note: null, otherBookId: null, otherTitle: null },
    { id: 'k3', direction: 'arrived', item: 'a gull feather', note: null, otherBookId: 'b2', otherTitle: 'The Lighthouse' },
  ]);
});

test('a bible keeps its shape open and folds the parts that give the story away', () => {
  const bible = [
    'THE LIGHTHOUSE AT LOW TIDE',
    'A keeper, a storm, and a lamp nobody lit.',
    '',
    'THE SHAPE OF IT',
    'Slow, salty, a little sad, and warm at the end.',
    '',
    'THE PEOPLE',
    'The keeper. The ferryman. The girl on the rocks.',
    '',
    'WHAT IS HIDDEN',
    'The ferryman drowned in 1902.',
  ].join('\n');
  const parts = bibleSections(bible, 'The Lighthouse at Low Tide');
  assert.deepEqual(parts.map((part) => [part.heading, part.open]), [
    ['THE LIGHTHOUSE AT LOW TIDE', true],
    ['THE SHAPE OF IT', true],
    ['THE PEOPLE', false],
    ['WHAT IS HIDDEN', false],
  ]);
  assert.equal(parts[3].text, 'The ferryman drowned in 1902.', 'a part keeps its own words, trimmed, and nothing of the next');
  assert.doesNotMatch(parts.filter((part) => part.open).map((part) => part.text).join(' '), /drowned/, 'nothing hidden is in an open part');
});

test('a bible reads its headings in any of the three ways we write them', () => {
  const marked = bibleSections('Before anything.\n## The shape of it\nCozy.\n**Secrets**\nA key.\n### Where it can go\nNorth.', 'Whatever');
  assert.deepEqual(marked.map((part) => [part.heading, part.open]), [
    [null, true],
    ['The shape of it', true],
    ['Secrets', false],
    ['Where it can go', false],
  ]);
  assert.equal(marked[0].text, 'Before anything.');
});

test('a bible with no headings stays whole and open, and a capital word inside a sentence is not a heading', () => {
  const plain = bibleSections('Just one paragraph about the MARKET at night.\nAnd a second line.', 'The Night Market');
  assert.deepEqual(plain.map((part) => [part.heading, part.open]), [[null, true]]);
  assert.match(plain[0].text, /second line/);
  assert.deepEqual(bibleSections('   ', 'Empty'), []);
});

test("their person's line at the table is waiting while it is the newest there and younger than a page turn may run", () => {
  const now = Date.parse('2026-03-03T20:00:00.000Z');
  const line = (role: 'user' | 'companion', minutesAgo: number) => ({ role, createdAt: new Date(now - minutesAgo * 60_000).toISOString() });
  assert.equal(tableAwaiting([], now), false, 'an empty table waits on nothing');
  assert.equal(tableAwaiting([line('user', 1), line('companion', 0)], now), false, 'answered');
  assert.equal(tableAwaiting([line('companion', 2), line('user', 1)], now), true, 'said and not yet answered');
  assert.equal(tableAwaiting([line('user', 31)], now), false, 'a line older than a page turn may run has been given up on');
  assert.equal(tableAwaiting([{ role: 'user', createdAt: 'not a date' }], now), false);
  assert.equal(TABLE_WAIT_MS, 30 * 60_000);
});
