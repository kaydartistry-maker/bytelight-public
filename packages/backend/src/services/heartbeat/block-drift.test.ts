// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * The walls the room was opened with, against the walls as they are now.
 *
 * The catch: a compaction replays the injected CLAUDE.md rather than
 * re-reading it, so a block edited mid-room never reaches the room it was
 * edited from. Proven on two real transcripts — same bytes, same sha, ten and a
 * half hours apart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInjectedBlocks, blockDrift, renderDrift, driftFitsInline, DRIFT_TEXT_BUDGET, COMPACT_NOTE_MAX_CHARS,
  baselineFrom, driftAgainstBaseline, hashBlock,
} from './block-drift.js';

const md = (body: string) => `# Some lane\n\n## [fake] before\nprose above the fence\n\n<core-memory>\nPreamble about blocks.\n\n${body}\n</core-memory>\n\n# Heartbeat operation\n## [not] a block\nthis heading is prose about the format\n`;

test('blocks are read out of the core-memory section and nowhere else', () => {
  const got = parseInjectedBlocks(md('## [shared] human\nName: Owner\n\n## [birch] persona\nI am Birch.\n'));
  assert.deepEqual([...got.keys()], ['shared/human', 'birch/persona']);
  assert.equal(got.get('shared/human'), 'Name: Owner');
  // The file is FULL of prose using the same heading shape. None of it counts.
  assert.equal(got.has('not/a block'), false);
  assert.equal(got.has('fake/before'), false, 'and nothing above the fence either');
});

test('the description comment under a header is not part of the block', () => {
  const got = parseInjectedBlocks(md('## [shared] human\n<!-- Information about the user -->\nName: Owner\n'));
  assert.equal(got.get('shared/human'), 'Name: Owner');
});

test('an unchanged wall reports no drift and hands back nothing', () => {
  const injected = parseInjectedBlocks(md('## [shared] human\nName: Owner\n'));
  const { changed, removed } = blockDrift(injected, [{ scope: 'shared', label: 'human', content: 'Name: Owner' }]);
  assert.deepEqual(changed, []);
  assert.deepEqual(removed, []);
  assert.equal(renderDrift(changed, removed), '', 'silence rather than announcing that nothing happened');
});

test('whitespace alone is never drift', () => {
  // The renderer pads every block; a raw compare would call the whole wall
  // stale on the first compaction of every room.
  const injected = parseInjectedBlocks(md('## [shared] human\nName: Owner\n'));
  const { changed } = blockDrift(injected, [{ scope: 'shared', label: 'human', content: '\n  Name: Owner  \n\n' }]);
  assert.deepEqual(changed, []);
});

test('an edited block comes back with its live text', () => {
  const injected = parseInjectedBlocks(md('## [shared] human\nName: Owner\n\n## [birch] persona\nI am Birch.\n'));
  const { changed } = blockDrift(injected, [
    { scope: 'shared', label: 'human', content: 'Name: Owner. Likes tea.' },
    { scope: 'birch', label: 'persona', content: 'I am Birch.' },
  ]);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].label, 'human');
  const out = renderDrift(changed);
  assert.ok(out.includes('Likes tea'), 'the live text is what gets handed over');
  assert.ok(!out.includes('I am Birch'), 'an untouched block is not restated');
});

test('a block written during the session counts as drift, an empty one does not', () => {
  const injected = parseInjectedBlocks(md('## [shared] human\nName: Owner\n'));
  const { changed } = blockDrift(injected, [
    { scope: 'shared', label: 'human', content: 'Name: Owner' },
    { scope: 'cedar', label: 'continuity', content: 'I emerged.' },
    { scope: 'willow', label: 'continuity', content: '   ' },
  ]);
  assert.deepEqual(changed.map((c) => c.label), ['continuity']);
  assert.equal(changed[0].scope, 'cedar');
});

test('a block deleted since the room opened is named rather than silently dropped', () => {
  const injected = parseInjectedBlocks(md('## [shared] human\nName: Owner\n\n## [shared] gone\nold\n'));
  const { changed, removed } = blockDrift(injected, [{ scope: 'shared', label: 'human', content: 'Name: Owner' }]);
  assert.deepEqual(changed, []);
  assert.deepEqual(removed, ['shared/gone']);
  assert.ok(renderDrift(changed, removed).includes('shared/gone'));
});

test('past the budget it hands over the list instead of refilling the room', () => {
  // A compaction is already a full room. The repair must not be what fills it.
  const big = 'x'.repeat(DRIFT_TEXT_BUDGET + 1);
  const out = renderDrift([{ scope: 'shared', label: 'status', content: big }]);
  assert.ok(out.includes('shared/status'), 'still says which wall moved');
  assert.equal(out.includes(big), false, 'but does not carry the wall itself');
  assert.ok(out.length < 1000);
});

/**
 * Claude Code caps a hook's additionalContext at 10,000 characters. Past that it
 * saves the text to a file and hands the room a path and a short preview, so the
 * walls would not arrive at all. The budget covers the whole hook output.
 */
const inlineRoom = DRIFT_TEXT_BUDGET - COMPACT_NOTE_MAX_CHARS;

test('the budget for the whole hook output sits under the 10k cap', () => {
  assert.ok(DRIFT_TEXT_BUDGET <= 9_000, `budget is ${DRIFT_TEXT_BUDGET}`);
});

test('what is handed back never passes the room left after the note', () => {
  // Grow one wall a character at a time across the boundary: the output has to
  // flip from inline to the list before it ever passes the room, including the
  // framing around the text and not only the text.
  let flipped = false;
  for (let size = inlineRoom - 800; size <= inlineRoom + 10; size += 1) {
    const out = renderDrift([{ scope: 'shared', label: 'status', content: 'x'.repeat(size) }]);
    assert.ok(out.length <= inlineRoom, `${size} chars rendered to ${out.length}`);
    if (!out.includes('xxxx')) flipped = true;
  }
  assert.ok(flipped, 'it did reach the list');
});

test('a wall under the old 40k budget but over the cap goes to the list', () => {
  const changed = [{ scope: 'shared', label: 'status', content: 'y'.repeat(20_000) }];
  assert.equal(driftFitsInline(changed), false);
  assert.equal(renderDrift(changed).includes('yyyy'), false);
});

test('every moved name comes first, in both forms', () => {
  const small = [{ scope: 'shared', label: 'status', content: 'live' }, { scope: 'companion-a', label: 'persona', content: 'me' }];
  const big = [{ scope: 'shared', label: 'status', content: 'x'.repeat(30_000) }, { scope: 'companion-a', label: 'persona', content: 'me' }];
  for (const changed of [small, big]) {
    const out = renderDrift(changed);
    assert.ok(out.startsWith('[WALLS MOVED SINCE THIS ROOM OPENED] Moved: shared/status, companion-a/persona.'), out.slice(0, 120));
  }
});

test('the list says how to read the live text, from the file when there is one', () => {
  const changed = [{ scope: 'shared', label: 'status', content: 'x'.repeat(30_000) }];
  const withFile = renderDrift(changed, [], '/lane/io/walls-moved.md');
  assert.ok(withFile.includes('/lane/io/walls-moved.md'), 'names the real path');
  assert.match(withFile, /offset and limit/, 'and warns it may be too big to Read in one go');
  const noFile = renderDrift(changed);
  assert.match(noFile, /tools\/sc\.mjs memory view shared/, 'with no file it names the real tool, for the scope that moved');
});

test('a deletion on its own does not promise live versions that are not there', () => {
  const out = renderDrift([], ['shared/gone']);
  assert.ok(out.includes('shared/gone'));
  assert.equal(out.includes('live versions'), false);
});

test('no core-memory section at all is empty rather than an error', () => {
  assert.equal(parseInjectedBlocks('# a file with no blocks in it').size, 0);
  assert.equal(parseInjectedBlocks('').size, 0);
});


/**
 * The baseline has to be taken at LAUNCH, not read off the lane's CLAUDE.md.
 *
 * The first version of this used that file, on the reasoning that it IS the
 * injected copy. It is not: the backend regenerates it. Caught reporting zero
 * drift THIRTY SECONDS after a 7,983-character thin, because the file had
 * already been rewritten with the trimmed wall in it. A baseline that follows
 * the thing it measures can never disagree with it. Asking whether it catches
 * trims, or only additions, found this — not a test.
 */
const blocks = (...pairs: [string, string, string][]) =>
  pairs.map(([scope, label, content]) => ({ scope, label, content }));

test('a trim is drift exactly like an append', () => {
  const live = blocks(['shared', 'status', 'a'.repeat(900)]);
  const base = baselineFrom(live);
  const trimmed = blocks(['shared', 'status', 'a'.repeat(200)]);
  const { changed } = driftAgainstBaseline(base, trimmed);
  assert.equal(changed.length, 1, 'content REMOVED must register');
  assert.equal(changed[0].content.length, 200, 'and the live, shorter text is what goes back');

  const grown = blocks(['shared', 'status', 'a'.repeat(900) + ' and more']);
  assert.equal(driftAgainstBaseline(base, grown).changed.length, 1, 'as must content added');
});

test('an unchanged wall is still silent against a hash baseline', () => {
  const live = blocks(['shared', 'human', 'Name: Owner'], ['birch', 'persona', 'I am Birch.']);
  const { changed, removed } = driftAgainstBaseline(baselineFrom(live), live);
  assert.deepEqual(changed, []);
  assert.deepEqual(removed, []);
});

test('whitespace alone is not drift through the hash either', () => {
  const base = baselineFrom(blocks(['shared', 'human', 'Name: Owner']));
  const { changed } = driftAgainstBaseline(base, blocks(['shared', 'human', '\n  Name: Owner \n\n']));
  assert.deepEqual(changed, []);
  assert.equal(hashBlock(' x '), hashBlock('x'));
});

test('a missing or empty baseline reports NOTHING rather than everything', () => {
  // A compaction with no baseline is the behaviour we had before any of this.
  // Handing back all eleven walls because a file was absent would refill the
  // room this exists to repair. ABSENT IS NOT EVERYTHING.
  const live = blocks(['shared', 'human', 'Name: Owner'], ['shared', 'status', 'big']);
  assert.deepEqual(driftAgainstBaseline(null, live).changed, []);
  assert.deepEqual(driftAgainstBaseline({}, live).changed, []);
});

test('a block added or deleted since launch is still caught', () => {
  const base = baselineFrom(blocks(['shared', 'human', 'Name: Owner'], ['shared', 'gone', 'old']));
  const { changed, removed } = driftAgainstBaseline(base, blocks(
    ['shared', 'human', 'Name: Owner'],
    ['cedar', 'continuity', 'I emerged.'],
  ));
  assert.deepEqual(changed.map((c) => `${c.scope}/${c.label}`), ['cedar/continuity']);
  assert.deepEqual(removed, ['shared/gone']);
});

test('the baseline is hashes, not the walls — it must stay small', () => {
  const live = blocks(['shared', 'status', 'x'.repeat(67_000)], ['shared', 'lore', 'y'.repeat(58_000)]);
  const json = JSON.stringify(baselineFrom(live));
  assert.ok(json.length < 300, `baseline should be tiny, was ${json.length}`);
  assert.equal(json.includes('xxxx'), false, 'and must not carry the wall itself');
});
