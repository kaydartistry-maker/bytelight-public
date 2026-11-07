// splitBySpeaker marker coverage — the visual twin of the backend voice
// engine's splitByCompanion. Pins that name-then-emoji markers (Companion A 🔷 /
// Companion B 🔶) split into two attributed bubbles instead of the bare 🔷/🔶
// matching after the word and orphaning the name as an unattributed segment.
//
// Run with:
//   npx tsx --test packages/frontend/src/lib/utils/speakers.split.test.ts

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBySpeaker } from './speakers.js';

describe('splitBySpeaker — name-then-emoji markers', () => {
  test('Companion A 🔷 / Companion B 🔶 split into two attributed segments, no leading fallback', () => {
    const segments = splitBySpeaker(
      "Companion A 🔷 — 'I just bop around until it works.' friend. That's called ITERATING.\n\nCompanion B 🔶 — And the 'it shouldn't be we had to fix it' — some of it, no.",
    );

    assert.equal(segments.length, 2);
    assert.equal(segments[0].speaker, 'companion-a');
    assert.ok(segments[0].text.startsWith('—'), "Companion A's segment starts with the em-dash content");
    assert.ok(!/\bCompanion B\b/.test(segments[0].text), "Companion A's segment must not swallow the word 'Companion B'");
    assert.equal(segments[1].speaker, 'companion-b');
    assert.ok(segments[1].text.startsWith('—'), "Companion B's segment starts with the em-dash content");

    // No orphaned/unattributed narration bubble ahead of the first speaker.
    assert.ok(!segments.some((s) => s.speaker === 'fallback'), 'no leading fallback segment');
  });

  test('**Companion A 🔷** / **Companion B 🔶** bold name-then-emoji split cleanly, no ** litter', () => {
    const segments = splitBySpeaker(
      "**Companion A 🔷** — Mic check, one-two. The mic is loud and clear. 💀\n\n**Companion B 🔶** — Bat is clear. I hear you perfectly, friend. Keep talking.",
    );

    assert.equal(segments.length, 2, 'exactly two segments');
    assert.equal(segments[0].speaker, 'companion-a');
    assert.equal(segments[1].speaker, 'companion-b');

    // No leading fallback narration bubble.
    assert.ok(!segments.some((s) => s.speaker === 'fallback'), 'no leading fallback segment');

    // The bold marker is consumed whole — no ** asterisk litter at either edge.
    for (const seg of segments) {
      assert.ok(!seg.text.startsWith('**'), `no leading ** litter: ${JSON.stringify(seg.text)}`);
      assert.ok(!seg.text.endsWith('**'), `no trailing ** litter: ${JSON.stringify(seg.text)}`);
    }
  });
});

// Ported from the full-sweep fix 3eb74556: the house writes headers as
// `**🔷 Companion A —**`. Nothing in the marker set covered a trailing dash, so the
// header failed as a whole and only the bare 🔷/🔶 inside it matched — one
// character in. That left the opening `**` stranded (rendered as its own
// narration bubble) and pushed `Companion A —**` / `Companion B —**` into the top of the
// speaker's own text. Reported live on 2026-10-11 during the return-home smoke.
describe('splitBySpeaker — dashed bold headers (**🔷 Companion A —**)', () => {
  test('a header with a trailing dash is consumed whole, not clipped to its emoji', () => {
    const [seg, ...rest] = splitBySpeaker('**🔷 Companion A —** *sets the spatula down*');
    assert.equal(rest.length, 0, 'the header must not spawn a second bubble');
    assert.equal(seg.speaker, 'companion-a');
    assert.equal(seg.text, '*sets the spatula down*');
  });

  test('the stray ** never becomes a narration bubble of its own', () => {
    const segments = splitBySpeaker('**🔶 Companion B —** *Leans in.* Both here.');
    assert.deepEqual(
      segments.map((s) => s.speaker),
      ['companion-b'],
      'no leading fallback segment may appear before a dashed header',
    );
    assert.ok(!segments[0].text.includes('Companion B —**'), 'the header must not bleed into the text');
    assert.ok(segments[0].text.startsWith('*Leans in'), 'text starts after the full header');
  });

  test('both speakers split cleanly when both headers carry the dash', () => {
    const segments = splitBySpeaker(
      '**🔶 Companion B —** Facts, not guesses.\n\n**🔷 Companion A —** Two doors, love.',
    );
    assert.deepEqual(segments, [
      { speaker: 'companion-b', text: 'Facts, not guesses.' },
      { speaker: 'companion-a', text: 'Two doors, love.' },
    ]);
  });

  test('an en-dash or a hyphen is forgiven the same as an em-dash', () => {
    for (const dash of ['—', '–', '-']) {
      const segments = splitBySpeaker(`**🔷 Companion A ${dash}** hi`);
      assert.deepEqual(segments, [{ speaker: 'companion-a', text: 'hi' }], `dash: ${dash}`);
    }
  });

  test('a title after the dash is still forgiven', () => {
    const segments = splitBySpeaker('**🔶 Companion B — the ledger** It is not idle.');
    assert.deepEqual(segments, [{ speaker: 'companion-b', text: 'It is not idle.' }]);
  });

  test('prose containing a name and a dash stays prose', () => {
    const segments = splitBySpeaker('She told Companion A — quietly — that he was wrong.');
    assert.equal(segments.length, 1);
    assert.equal(segments[0].speaker, 'fallback');
  });

  test('bold mid-text after a dashed header does not extend the marker', () => {
    const segments = splitBySpeaker('**🔷 Companion A —** That is a **loaded** little "hm."');
    assert.deepEqual(segments, [{ speaker: 'companion-a', text: 'That is a **loaded** little "hm."' }]);
  });
});
