import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../types.js';
import { splitMessageVoices, type VoiceCompanion } from './voices.js';

const companions: VoiceCompanion[] = [
  { slug: 'ivy', display_name: 'Ivy', avatar_url: '/ivy.png', color: '#3f8f5a', emoji: '🌿' },
  { slug: 'fern', display_name: 'Fern', avatar_url: '/fern.png', color: '#b45309', emoji: '🍂' },
];

function companionMessage(overrides: Partial<Message>): Message {
  return {
    id: 'wake-1',
    timestamp: '2026-07-22T00:59:10.376Z',
    direction: 'outbound',
    content: '',
    read: 1,
    ...overrides,
  };
}

test('attributes a headerless wake acknowledgement to the first named companion', () => {
  const message = companionMessage({
    content: '*stretches*\nHang on.\n\n**🌿 Ivy**\nEvening.\n\n**🍂 Fern**\nHere.',
    segments: [
      { type: 'thinking', content: 'Worth sending something real.', summary: 'Worth sending something real.' },
      { type: 'text', content: '*stretches*\nHang on.' },
      { type: 'tool', toolId: 'studio', toolName: 'Studio', input: '{}', output: '', isError: false },
      { type: 'text', content: '\n\n**🌿 Ivy**\nEvening.\n\n**🍂 Fern**\nHere.' },
    ],
  });

  const sections = splitMessageVoices(message, companions);
  assert.ok(sections);
  assert.equal(sections[0].voice?.slug, 'ivy');
  assert.equal(sections[0].content, '*stretches*\nHang on.');
  assert.equal(sections[1].voice?.slug, 'ivy');
  assert.equal(sections[2].voice?.slug, 'fern');
});

test('keeps a genuinely meta-only leading segment group voice-less', () => {
  const message = companionMessage({
    content: '**🌿 Ivy**\nEvening.',
    segments: [
      { type: 'thinking', content: 'A quiet thought.', summary: 'A quiet thought.' },
      { type: 'tool', toolId: 'studio', toolName: 'Studio', input: '{}', output: '', isError: false },
      { type: 'text', content: '**🌿 Ivy**\nEvening.' },
    ],
  });

  const sections = splitMessageVoices(message, companions);
  assert.ok(sections);
  assert.equal(sections[0].voice, null);
  assert.equal(sections[0].content, '');
  assert.equal(sections[1].voice?.slug, 'ivy');
});

test('explicit companion metadata wins over a later header when inferring a lead-in', () => {
  const message = companionMessage({
    companionSlug: 'fern',
    content: 'One second.\n\n**🌿 Ivy**\nEvening.',
    segments: [
      { type: 'text', content: 'One second.' },
      { type: 'text', content: '**🌿 Ivy**\nEvening.' },
    ],
  });

  const sections = splitMessageVoices(message, companions);
  assert.ok(sections);
  assert.equal(sections[0].voice?.slug, 'fern');
  assert.equal(sections[1].voice?.slug, 'ivy');
});

// A title hung off the end of a name — `**🌿 Ivy — the docs**` — used to fail
// the header match outright, so the line stopped being a header at all: no
// split, no avatar, the voice folded silently into the bubble above it. The
// reader forgives it now, because writing the rule down did not stop it.
test('a header with a title after the name still splits and keeps its voice', () => {
  const message = companionMessage({
    content: '**🌿 Ivy — the docs**\nRead rather than remembered.\n\n**🍂 Fern: one more**\nAnd this is mine.',
  });
  const sections = splitMessageVoices(message, companions);
  assert.ok(sections, 'expected the message to split');
  assert.equal(sections!.length, 2);
  assert.equal(sections![0].voice?.slug, 'ivy');
  assert.equal(sections![1].voice?.slug, 'fern');
});

// The forgiveness has to stop somewhere: a bold sentence that merely contains
// a companion's name is not that companion speaking.
test('a bold sentence containing a name is not a header', () => {
  const message = companionMessage({
    content: '**Ivy and I disagree about this**\nSo it stays one bubble.',
  });
  assert.equal(splitMessageVoices(message, companions), null);
});

test('an inline header on a line that ends in bold is not a whole-line header', () => {
  // Header and words share a line, and the line closes on its own bold
  // phrase. Read as one span this swallowed the speaker's words as a "name".
  const text =
    '**🌿 Ivy —** There she is. Still waiting on the ruling: **the underlined line, or the lip?**\n\n' +
    '**🍂 Fern —** *Fingers close in your hair.* Come back here.';
  const message = companionMessage({
    content: text,
    segments: [
      { type: 'tool', toolId: 't1', toolName: 'Read', input: '{}', output: '', isError: false },
      { type: 'text', content: text },
    ],
  });
  // No whole-line headers here, so the app-level splitter leaves the message
  // whole and the bubble's inline speaker split handles it, words intact.
  assert.equal(splitMessageVoices(message, companions), null);
});

test('a real one-span header still splits', () => {
  const message = companionMessage({ content: '**🌿 Ivy**\nEvening, **really**.\n\n**🍂 Fern**\nHere.' });
  const sections = splitMessageVoices(message, companions);
  assert.ok(sections);
  assert.deepEqual(sections.map((s) => s.voice?.slug), ['ivy', 'fern']);
  assert.equal(sections[0].content.includes('Evening, **really**.'), true);
});
