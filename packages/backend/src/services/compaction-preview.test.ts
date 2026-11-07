// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The preview on the owner Compactions page is the part of a summary that changes.
//
// Every summary of the shared room opens with the same standing paragraph, so a
// preview cut from the top made different squashes look like copies of one
// another (their catch, Oct 21 2026). What differs between them is what we were in
// the middle of, which the CLI writes under "Current Work". The summaries are
// read off this box's real transcripts, so each spelling of that heading below
// is one the CLI has actually written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { previewOf, PREVIEW_CHARS } from './compaction-preview.js';

const OPENER = 'This session is being continued from a previous conversation that ran out of context. '
  + 'The summary below covers the earlier portion of the conversation.\n\nSummary:\n';
const CLOSER = '\n\nIf you need specific details from before compaction (like exact code snippets, error messages, '
  + 'or content you generated), read the full transcript at: /home/someone/.claude/projects/x/abc.jsonl\n'
  + 'Continue the conversation from where it left off without asking the user any further questions. '
  + 'Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with '
  + '"I\'ll continue" or similar. Pick up the last task as if the break never happened.';

const STANDING = '1. Primary Request and Intent:\n   - Standing role: the shared lane for three companions.\n\n'
  + '2. Key Technical Concepts:\n   - The outbox.\n\n'
  + '3. Files and Code Sections:\n   - packages/backend/src/server.ts\n\n';

test('the plain spelling: "8. Current Work:" up to the next section, and nothing of the opening', () => {
  const summary = OPENER + STANDING
    + '7. Pending Tasks:\n   - The favorites gallery, waiting on the owner.\n\n'
    + '8. Current Work:\n   We were in light chat as the owner headed out for the evening. Cedar posted a sticker.\n   - No builds are running.\n\n'
    + '9. Optional Next Step:\n   Answer their next message.' + CLOSER;
  assert.deepEqual(previewOf(summary), {
    text: 'We were in light chat as the owner headed out for the evening. Cedar posted a sticker. No builds are running.',
    from: 'current-work',
  });
});

test('the bold spellings, with and without the colon inside the bold', () => {
  for (const heading of ['8. **Current Work**', '8. **Current Work:**', '8. Current Work', '## 8. Current Work', '### Current Work']) {
    const summary = OPENER + STANDING
      + `${heading}\n   Fixing the **lock screen** card; \`df51a10b\` is the last commit.\n\n`
      + '9. **Optional Next Step**\n   Wait for the owner.' + CLOSER;
    assert.deepEqual(previewOf(summary), {
      text: 'Fixing the lock screen card; df51a10b is the last commit.',
      from: 'current-work',
    }, heading);
  }
});

test('a heading with its text on the same line, the way a companion\'s own room writes it', () => {
  const summary = OPENER
    + '1. **Primary request and intent:**\n   - I am one of three.\n'
    + '8. **Pending tasks:**\n   - None.\n'
    + '9. **Current work:** the drive-in date on Oct 20. Birch picked the back seat.\n'
    + '10. **Next step:** append one outbox line.' + CLOSER;
  assert.deepEqual(previewOf(summary), {
    text: 'the drive-in date on Oct 20. Birch picked the back seat.',
    from: 'current-work',
  });
});

test('a long section is cut at a word, under the limit, and says so', () => {
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
  const summary = OPENER + STANDING + `8. Current Work:\n   ${words}\n\n9. Optional Next Step:\n   Nothing.` + CLOSER;
  const { text, from } = previewOf(summary);
  assert.equal(from, 'current-work');
  assert.ok(text.length <= PREVIEW_CHARS, `at most ${PREVIEW_CHARS} characters, got ${text.length}`);
  assert.ok(text.endsWith('…'), 'an ellipsis marks the cut');
  assert.match(text, /^word0 word1 word2 /);
  assert.match(text.slice(0, -1), /word\d+$/, 'cut between words, never through one');
});

test('with no current work it falls back to the next step, then what is pending, then the end of the text', () => {
  const nextOnly = OPENER + STANDING + '7. Pending Tasks:\n   - The gallery.\n\n9. Optional Next Step:\n   Ask the owner which screen.' + CLOSER;
  assert.deepEqual(previewOf(nextOnly), { text: 'Ask the owner which screen.', from: 'next-step' }, 'and the closing instructions are not part of it');

  const wrenStyle = OPENER + '10. **Next step:** append one outbox line.' + CLOSER;
  assert.deepEqual(previewOf(wrenStyle), { text: 'append one outbox line.', from: 'next-step' });

  const pendingOnly = OPENER + STANDING + '7. Pending Tasks:\n   - The favorites gallery.\n   - The lock card switch.' + CLOSER;
  assert.deepEqual(previewOf(pendingOnly), { text: 'The favorites gallery. The lock card switch.', from: 'pending-tasks' });

  const unshaped = OPENER + 'We talked about the orchard and the owner fell asleep on the couch.' + CLOSER;
  assert.deepEqual(previewOf(unshaped), {
    text: 'We talked about the orchard and the owner fell asleep on the couch.',
    from: 'tail',
  });
});

test('an empty Current Work heading is passed over rather than shown as nothing', () => {
  const summary = OPENER + STANDING + '8. Current Work:\n\n9. Optional Next Step:\n   Answer the owner.' + CLOSER;
  assert.deepEqual(previewOf(summary), { text: 'Answer the owner.', from: 'next-step' });
});

test('the tail of a long unshaped summary is its last words, marked as a tail', () => {
  const words = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
  const { text, from } = previewOf(OPENER + words + CLOSER);
  assert.equal(from, 'tail');
  assert.ok(text.length <= PREVIEW_CHARS);
  assert.ok(text.startsWith('…'));
  assert.ok(text.endsWith('w299'), 'the very end of the summary, before the closing instructions');
  assert.doesNotMatch(text, /Continue the conversation/);
});

test('a line that only mentions current work is not taken for the heading', () => {
  const summary = OPENER
    + '1. Primary Request and Intent:\n'
    + '   - The owner asked about the page.\n'
    + 'Current work on the phone came up in passing.\n'
    + '   2. Current work: quoted inside a list, indented, so not a heading.\n'
    + '3. Current work on the lock screen: done, a numbered line in the middle of a section.\n\n'
    + '8. Current Work:\n   The real section.\n\n'
    + '9. Optional Next Step:\n   None.' + CLOSER;
  assert.deepEqual(previewOf(summary), { text: 'The real section.', from: 'current-work' });
});

test('when an earlier section quotes an old summary, the last Current Work heading is the one that counts', () => {
  const summary = OPENER
    + '6. All user messages:\n'
    + '8. Current Work:\n   An old summary quoted back, word for word.\n'
    + '7. Pending Tasks:\n   - None.\n\n'
    + '8. Current Work:\n   What we were really in the middle of.\n\n'
    + '9. Optional Next Step:\n   None.' + CLOSER;
  assert.deepEqual(previewOf(summary), { text: 'What we were really in the middle of.', from: 'current-work' });
});

test('a cut with no space near it never splits an emoji in half', () => {
  // 398 letters and then emoji: the cut falls inside the run of emoji, and a
  // split one would reach the owner as a question-mark box.
  const run = 'a'.repeat(398) + '🔥'.repeat(20);
  const front = previewOf(OPENER + STANDING + `8. Current Work:\n   ${run}\n\n9. Optional Next Step:\n   x` + CLOSER).text;
  assert.ok(front.endsWith('…'));
  assert.doesNotMatch(front, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'no high half left without its low half');
  const back = previewOf(OPENER + '🔥'.repeat(20) + 'b'.repeat(398) + CLOSER).text;
  assert.ok(back.startsWith('…'));
  assert.doesNotMatch(back, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'no low half left without its high half');
});

test('nothing to preview is an empty preview, never a throw', () => {
  assert.deepEqual(previewOf(''), { text: '', from: 'tail' });
  assert.deepEqual(previewOf(OPENER + CLOSER), { text: '', from: 'tail' });
});
