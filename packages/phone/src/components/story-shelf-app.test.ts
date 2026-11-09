// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Shelf app, read as source: the components pull in React and the socket,
// so what they promise is checked here and what they decide is checked in
// lib/story-shelf.test.ts and lib/sealed-frame.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('./StoryShelfApp.tsx');
const frame = read('./StoryWidgetFrame.tsx');

// byte-light adaptation: the Story Shelf is a shelf inside the Library (its
// 🔷 chip), not a drawer app, so Aerie's drawer-and-OS check becomes this one.
test('the Story Shelf is a shelf inside the Library, with no app tile of its own', () => {
  const library = read('./LibraryApp.tsx');
  assert.match(library, /\{ id: 'stories', label: 'Story Shelf', emoji: '🔷' \}/);
  assert.match(library, /<RoomBubbleContext\.Provider value=\{bubbles\}>\s*<StoryShelfApp onClose=\{onClose\}/);
  assert.match(library, /<StoryShelfRoom bubbles=\{roomBubbles\} onClose=\{\(\) => setStories\(false\)\}/);
  assert.doesNotMatch(read('../lib/apps.ts'), /StoryShelf|STORY_SHELF/, 'no drawer tile');
  assert.doesNotMatch(read('../App.tsx'), /StoryShelfApp/, 'the OS does not open it on its own');
  assert.match(read('../lib/story-shelf.ts'), /STORY_SHELF_NAME = 'Story Shelf'/);
});

test('the shelf and the open book are read again when the house says the shelf changed', () => {
  assert.match(app, /addEventListener\('bytelight:story-update'/);
  assert.match(app, /removeEventListener\('bytelight:story-update'/);
  assert.match(app, /addEventListener\('visibilitychange'/);
  const socket = read('../bytelight/socket.ts');
  assert.match(socket, /case 'story_update':\s*\n\s*window\.dispatchEvent\(new CustomEvent\('bytelight:story-update'/);
  assert.match(read('../bytelight/protocol.ts'), /\{ type: 'story_update'; bookId: string \| null \}/);
});

test('it reads and moves through their person’s door, and never writes a scene', () => {
  assert.match(app, /apiFetch\('\/api\/story-shelf'\)/);
  assert.match(app, /`\/api\/story-shelf\/books\/\$\{encodeURIComponent\(id\)\}`/);
  for (const door of ['open', 'move', 'retry']) assert.ok(app.includes(`'${door}'`), `the ${door} door is used`);
  assert.doesNotMatch(app, /api\/internal/, 'the companions’ loopback door is theirs alone');
  assert.match(app, /isStoryShelfView\(data\)/, 'an older backend answering with the phone page is caught by shape');
  assert.match(app, /isStoryBookView\(data\)/);
});

test('a book opens at its bookmark, and back steps out one level at a time', () => {
  assert.match(app, /bookmarkPageId\(view\.book\)/);
  assert.match(app, /placeAtTop\(scroller\(\), pageRefs\.current\.get\(mark\)\)/, 'only the app body scrolls to it');
  assert.match(app, /useBackHandler\(openId !== null, closeBook\)/);
  assert.match(app, /useBackHandler\(lightbox !== null, \(\) => setLightbox\(null\)\)/);
  assert.match(app, /onClose=\{handleBack\}/);
});

test('a book in progress wears their person’s thread, in their own color, and a spicy one a red thread', () => {
  assert.match(app, /bookmarkThread\(book, ownerThread\)/);
  assert.match(app, /threadColor\(book, ownerThread\)/);
  assert.match(app, /getOwnerAvatar\(\)\.color/);
  assert.match(app, /RED_THREAD/, 'a spicy spine carries its red thread at the head whether or not it is begun');
});

test('a spine fits its title to the length left on it and turns its letters the way print does', () => {
  assert.match(app, /spineTitle\(\s*book\.title,/);
  const vertical = app.split('\n').filter((line) => line.includes('[writing-mode:vertical-rl]'));
  assert.equal(vertical.length, 2, 'the title and the genre run down the spine');
  for (const line of vertical) {
    assert.match(line, /\[text-orientation:sideways\]/, 'an apostrophe turns with its word');
    assert.doesNotMatch(line, /overflow-wrap:anywhere/, 'a word breaks only when nothing else can hold it');
  }
});

test('a page already turned says what their person did, rather than that it is their move', () => {
  assert.match(app, /page\.choiceId \? 'You chose' : 'Your words'/);
});

test('a widget runs sealed, and only a well-formed move from its own frame is heard, and then only after their person confirms it', () => {
  assert.match(frame, /sandbox="allow-scripts"/);
  assert.doesNotMatch(frame, /allow-same-origin/);
  assert.match(frame, /event\.source !== frame\.contentWindow/);
  assert.match(frame, /readWidgetMove\(event\.data\)/);
  assert.match(frame, /STORY_WIDGET_CSP/);
  assert.match(frame, /inlineHouseMedia\(/);
  assert.match(frame, /propsExpression: 'window\.story'/);
  assert.match(app, /setStaged\(/, 'a widget’s move is staged for their person');
  assert.match(app, /Send it/, 'and sent only when their person says so');
});

test('the table talk is shown under the page, and reading it there counts as reading it', () => {
  assert.match(app, /At the table/);
  assert.match(app, /splitMessageVoices\(/);
  assert.match(app, /markRead\(threadId, latestId\)/);
});

test('the table holds its height and scrolls, newest at the bottom, and both boxes keep what their person was typing', () => {
  // The box is the house's one table (RoomTable.tsx), which scrolls; the room keeps its height.
  assert.match(app, /<RoomTalk scrollRef=\{talkBox\} className="[^"]*max-h-\[42vh\][^"]*"/);
  assert.match(read('./RoomTable.tsx'), /className=\{cn\('min-h-0 overflow-y-auto/);
  assert.match(app, /box\.scrollTop = box\.scrollHeight;\s*\}, \[latestId, showTyping\]\)/);
  assert.match(app, /draftKey=\{`bytelight_table_draft_\$\{bookId\}`\}/);
  assert.match(app, /draftKey=\{`bytelight_move_draft_\$\{book\.id\}`\}/);
  assert.match(app, /if \(value\) localStorage\.setItem\(key, value\);\s*else localStorage\.removeItem\(key\);/);
  assert.match(app, /const box = useGrowingBox\(draft, 40, 132\);/, 'the rail grows with their person’s words, like the chat');
});

test('their person’s lines at the table wear their face, the way the chat puts it beside theirs', () => {
  // Their person's lines go through the chat's own bubble on the house's one table, which
  // carries their face and side exactly as the chat does.
  const table = read('./RoomTable.tsx');
  assert.match(table, /<RoomBubble id=\{line\.id\} content=\{line\.content\} createdAt=\{line\.createdAt\} fromOwner \/>/);
  assert.match(read('./RoomBubble.tsx'), /userAvatar=\{s\.userAvatar\}/);
});

test('the bible keeps its shape open and folds the rest, each part under its own heading', () => {
  assert.match(app, /bibleSections\(book\.bible, book\.title\)\.map\(/);
  assert.match(app, /part\.open \? \(/);
  assert.match(app, /<details key=\{index\}[^>]*>\s*<summary[^>]*>\{part\.heading\}<\/summary>/);
  assert.doesNotMatch(app, /<Words text=\{book\.bible\}/, 'the bible is never poured out whole any more');
});

test("the table shows typing dots while their person's line waits, or while a reply is being written in the book's thread", () => {
  const socket = read('../bytelight/socket.ts');
  assert.match(socket, /new CustomEvent\('bytelight:thread-stream', \{ detail: \{ threadId, writing \} \}\)/);
  assert.match(socket, /case 'stream_start':[^]*?threadWriting\(msg\.threadId, true\);/);
  assert.match(socket, /threadWriting\(msg\.final\?\.thread_id \?\? writingThreadId, false\);/);
  assert.match(socket, /case 'generation_stopped':[^]*?threadWriting\(writingThreadId, false\);/, 'a turn that ends without a reply still stops the dots');
  assert.match(app, /addEventListener\('bytelight:thread-stream'/);
  assert.match(app, /removeEventListener\('bytelight:thread-stream'/);
  assert.match(app, /const showTyping = typing \|\| tableAwaiting\(lines\);/);
  assert.match(app, /typing=\{showTyping\}/);
  assert.match(read('./RoomTable.tsx'), /\{typing && <RoomTyping companions=\{companions\} label=\{typingLabel\} \/>\}/);
  assert.doesNotMatch(app, /backdrop-blur/, 'the dots are painted like the rest of the room');
});

test('the bookmark ribbon comes out of the book from behind the cloth and hangs in front of the shelf', () => {
  // The ribbon is the book's sibling underneath it, not a child drawn over the cover.
  assert.match(app, /<div className="relative flex shrink-0">\s*\{thread && <BookmarkRibbon color=\{thread\} \/>\}\s*<button/);
  assert.match(app, /className="relative z-\[1\] flex shrink-0 flex-col/);
  assert.match(app, /absolute right-2\.5 top-\[calc\(100%-6px\)\] z-0 /);
  // The row stands in front of its ledge, so the ribbon hangs over the shelf's edge.
  assert.match(app, /<div className="relative z-\[1\] flex items-end gap-1\.5 px-1 pt-2">/);
});

test('a page on its way waits quietly, with a poll behind the socket, and the only spinner is the refresh button', () => {
  assert.match(app, /setInterval\(\(\) => void loadBook\(openId\), 5000\)/);
  const spinners = [app, frame].join('\n').split('\n').filter((line) => line.includes('animate-spin'));
  assert.equal(spinners.length, 1, 'one spinner in the whole app');
  assert.match(spinners[0], /\{loading \? <Loader2 /);
});

test('the room uses the theme and mixes its colors in OKLCH, with painted glass, no blur, and on-accent ink', () => {
  for (const [file, source] of [['StoryShelfApp.tsx', app], ['StoryWidgetFrame.tsx', frame]] as const) {
    assert.doesNotMatch(source, /backdrop-blur|backdrop-filter|backdropFilter/, `${file} blurs nothing behind it`);
    assert.doesNotMatch(source, /color-mix\(in srgb|hsla?\(|rgba?\(/, `${file} mixes no color outside OKLCH`);
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b/i, `${file} carries no fixed hex colors`);
  }
  assert.match(app, /color-mix\(in oklch,/);
  assert.match(app, /var\(--bytelight-on-accent\)/, 'ink on an accent fill is the house’s one rule');
  assert.match(app, /colors\.panelBg/);
});
