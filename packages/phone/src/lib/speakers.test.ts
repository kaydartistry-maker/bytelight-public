import test from 'node:test';
import assert from 'node:assert/strict';
import { splitBySpeaker, splitInterleaved } from './speakers.js';
import { matchSpeakerLabel } from './speaker-label.js';

// The house has emitted `**🔷 Companion A —**` headers for weeks. Nothing in the
// marker set covered a trailing dash, so the header failed as a whole and only
// the bare 🔷 inside it matched — one character in. That left the opening `**`
// stranded in front of the first marker (rendered as its own narration bubble)
// and pushed `Companion A —**` into the top of the speaker's own text.
//
// Reported from a screenshot on 2026-09-22: an empty bubble reading `**`,
// followed by Companion A's bubble opening with `Companion A —**`.

test('a header with a trailing dash is consumed whole, not clipped to its emoji', () => {
  const [seg, ...rest] = splitBySpeaker('**🔷 Companion A —** *sets the spatula down*');
  assert.equal(rest.length, 0, 'the header must not spawn a second bubble');
  assert.equal(seg.speaker, 'companion-a');
  assert.equal(seg.text, '*sets the spatula down*');
});

test('the stray ** never becomes a narration bubble of its own', () => {
  const segs = splitBySpeaker('**🔶 Companion B —** Come here.');
  assert.deepEqual(
    segs.map(s => s.speaker),
    ['companion-b'],
    'no leading fallback segment may appear before a dashed header',
  );
  assert.equal(segs[0].text, 'Come here.');
});

test('both speakers split cleanly when both headers carry the dash', () => {
  const segs = splitBySpeaker(
    '**🔶 Companion B —** Facts, not guesses.\n\n**🔷 Companion A —** Two doors, love.',
  );
  assert.deepEqual(segs, [
    { speaker: 'companion-b', text: 'Facts, not guesses.' },
    { speaker: 'companion-a', text: 'Two doors, love.' },
  ]);
});

test('an en-dash or a hyphen is forgiven the same as an em-dash', () => {
  for (const dash of ['—', '–', '-']) {
    const segs = splitBySpeaker(`**🔷 Companion A ${dash}** hi`);
    assert.deepEqual(segs, [{ speaker: 'companion-a', text: 'hi' }], `dash: ${dash}`);
  }
});

test('a title after the dash is still forgiven, matching the audio reader', () => {
  // voice-speaker-split.ts already accepts `**🌿 Ivy — the docs**`; the visual
  // splitter must not be stricter than the reader on the same header.
  const segs = splitBySpeaker('**🔶 Companion B — the ledger** It is not idle.');
  assert.deepEqual(segs, [{ speaker: 'companion-b', text: 'It is not idle.' }]);
});

test('a dashed header survives the interleaved (thinking-chip) path too', () => {
  const rows = splitInterleaved([
    { type: 'thinking', content: 'reading the regex' },
    { type: 'text', content: '**🔷 Companion A —** Found it.' },
  ]);
  assert.deepEqual(rows, [
    { kind: 'chip', index: 0, segment: { type: 'thinking', content: 'reading the regex' } },
    { kind: 'text', speaker: 'companion-a', text: 'Found it.' },
  ]);
});

// ---- Regressions: every shape that already worked must keep working --------

test('the previously accepted header shapes are unchanged', () => {
  const cases: [string, string][] = [
    ['**🔷 Companion A** hi', 'companion-a'],
    ['**Companion A 🔷** hi', 'companion-a'],
    ['**Companion A:** hi', 'companion-a'],
    ['**🔶 Companion B** hi', 'companion-b'],
    ['**Companion B 🔶** hi', 'companion-b'],
    ['🔷 Companion A: hi', 'companion-a'],
    ['🔷 hi', 'companion-a'],
    ['🔶 hi', 'companion-b'],
  ];
  for (const [input, speaker] of cases) {
    assert.deepEqual(splitBySpeaker(input), [{ speaker, text: 'hi' }], input);
  }
});

test('prose is still prose — a dash near a name is not a speaker header', () => {
  const segs = splitBySpeaker('She told Companion A — quietly — that he was wrong.');
  assert.deepEqual(segs, [
    { speaker: 'fallback', text: 'She told Companion A — quietly — that he was wrong.' },
  ]);
});

test('genuine narration before the first header still renders as fallback', () => {
  const segs = splitBySpeaker('*The room goes quiet.*\n\n**🔶 Companion B —** Come here.');
  assert.deepEqual(segs, [
    { speaker: 'fallback', text: '*The room goes quiet.*' },
    { speaker: 'companion-b', text: 'Come here.' },
  ]);
});

// ---- The wholesale port: the shared rule, and what the scan must not eat ----

test('the sentence before a header keeps its punctuation', () => {
  // The sigil-outside-the-bold tolerance reaches backwards from `**`. Unanchored,
  // the full stop ending the previous sentence is itself non-alphanumeric and
  // gets swallowed into the marker, silently costing the sentence its period.
  const segs = splitBySpeaker('**🔶 Companion B —** Facts, not guesses.\n\n**🔷 Companion A —** Two doors.');
  assert.equal(segs[0].text, 'Facts, not guesses.');
});

test('a sigil outside the bold is consumed, not left as narration', () => {
  assert.deepEqual(splitBySpeaker('🔷 **Companion A** hi'), [{ speaker: 'companion-a', text: 'hi' }]);
});

test('a bold span that merely contains a name is not a header', () => {
  const segs = splitBySpeaker('You said **Companion A and the clipboard** last night.');
  assert.deepEqual(segs, [
    { speaker: 'fallback', text: 'You said **Companion A and the clipboard** last night.' },
  ]);
});

test('the label rule is the shared one, not a second opinion', () => {
  assert.equal(matchSpeakerLabel('🔷 Companion A —')?.slug, 'companion-a');
  assert.equal(matchSpeakerLabel('🔶 Companion B — the ledger')?.slug, 'companion-b');
  assert.equal(matchSpeakerLabel('Companion A 🔷')?.slug, 'companion-a');
  assert.equal(matchSpeakerLabel('My Companion A'), null, 'a possessive is not a header');
  assert.equal(matchSpeakerLabel('Companion A and the clipboard'), null);
});
